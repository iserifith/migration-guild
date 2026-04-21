import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type Database from "better-sqlite3";
import { listArtifacts } from "../registry/commands/queries";
import {
  replaceDependencyFindings,
  replaceJvmAuditFindings,
} from "../registry/commands/modernization";
import { setOperatorState } from "../registry/commands/operator";
import type {
  DependencyFindingInput,
  JvmAuditFindingInput,
} from "../registry/commands/modernization";

interface SourceArtifact {
  id: string;
  path: string;
}

interface LineMatch {
  symbol: string;
  line: number;
  text: string;
}

interface ToolStatus {
  name: "jdeps" | "jdeprscan";
  available: boolean;
  inspected_inputs: number;
  note: string;
}

interface JvmRule {
  category: JvmAuditFindingInput["category"];
  severity: JvmAuditFindingInput["severity"];
  match: RegExp;
  summary: (match: LineMatch) => string;
  remediation: string;
}

interface DependencyRule {
  dependencyName: string;
  targetHint: string;
  category: DependencyFindingInput["category"];
  severity: DependencyFindingInput["severity"];
  match: RegExp;
  summary: (match: LineMatch, version: string | null) => string;
  remediation: string;
  details?: string;
  coordinateHints?: string[];
}

export interface AuditRefreshSummary {
  artifact_count: number;
  jvm: {
    critical: number;
    warnings: number;
  };
  dependencies: {
    total: number;
    unresolved: number;
  };
  tools: ToolStatus[];
}

const JVM_RULES: readonly JvmRule[] = [
  {
    category: "internal-api",
    severity: "critical",
    match: /\b(?:sun|com\.sun|jdk\.internal)\.[A-Za-z0-9_$.]+/g,
    summary: (match) => `Internal JDK API usage detected: ${match.symbol}`,
    remediation: "Replace internal JDK APIs with supported Java SE or framework equivalents before planning.",
  },
  {
    category: "removed-api",
    severity: "critical",
    match: /\bjavax\.(?:xml\.bind|activation|annotation\.PostConstruct|annotation\.PreDestroy)\b/g,
    summary: (match) => `Removed or decoupled Java SE API detected: ${match.symbol}`,
    remediation: "Adopt supported Jakarta or external library replacements and record the target modernization strategy before planning.",
  },
  {
    category: "deprecated-api",
    severity: "warning",
    match: /\b(?:System\.setSecurityManager|SecurityManager\b|Thread\.(?:stop|suspend|resume)\b|java\.applet\.)/g,
    summary: (match) => `Deprecated JVM API usage detected: ${match.symbol}`,
    remediation: "Plan a supported replacement and capture the migration notes before code generation.",
  },
];

const DEPENDENCY_RULES: readonly DependencyRule[] = [
  {
    dependencyName: "log4j:log4j",
    targetHint: "org.slf4j:slf4j-api",
    category: "eol",
    severity: "critical",
    match: /\borg\.apache\.log4j\b/g,
    summary: (_match, version) => `EOL Log4j 1.x API detected${version ? ` (${version})` : ""}`,
    remediation: "Approve a replacement strategy to SLF4J/Log4j 2-compatible APIs before planning can continue.",
    details: "Log4j 1.x is end-of-life and should not advance into migrated outputs without an explicit replacement plan.",
    coordinateHints: ["log4j:log4j"],
  },
  {
    dependencyName: "junit:junit",
    targetHint: "org.junit.jupiter:junit-jupiter",
    category: "outdated",
    severity: "warning",
    match: /\b(?:junit\.framework|org\.junit\.(?!jupiter))/g,
    summary: (_match, version) => `JUnit 4-era test API detected${version ? ` (${version})` : ""}`,
    remediation: "Approve an upgrade strategy to JUnit 5 before the affected artifact can progress.",
    details: "Migration targets use JUnit 5 for generated tests and retained compatibility should be explicit.",
    coordinateHints: ["junit:junit"],
  },
  {
    dependencyName: "commons-logging:commons-logging",
    targetHint: "org.slf4j:slf4j-api",
    category: "outdated",
    severity: "warning",
    match: /\borg\.apache\.commons\.logging\b/g,
    summary: (_match, version) => `Commons Logging API detected${version ? ` (${version})` : ""}`,
    remediation: "Approve a logging facade upgrade or replacement strategy before planning can continue.",
    details: "Generated Spring Boot targets should use SLF4J-compatible logging rather than legacy Commons Logging calls.",
    coordinateHints: ["commons-logging:commons-logging"],
  },
  {
    dependencyName: "javax.servlet:javax.servlet-api",
    targetHint: "jakarta.servlet:jakarta.servlet-api",
    category: "incompatible",
    severity: "warning",
    match: /\bjavax\.servlet\b/g,
    summary: (_match, version) => `Legacy javax.servlet API detected${version ? ` (${version})` : ""}`,
    remediation: "Approve the jakarta.servlet replacement plan before the affected artifact can progress.",
    details: "Spring Boot 3 targets require Jakarta namespace APIs.",
    coordinateHints: ["javax.servlet:javax.servlet-api", "javax.servlet:servlet-api"],
  },
  {
    dependencyName: "javax.ws.rs:javax.ws.rs-api",
    targetHint: "jakarta.ws.rs:jakarta.ws.rs-api",
    category: "incompatible",
    severity: "warning",
    match: /\bjavax\.ws\.rs\b/g,
    summary: (_match, version) => `Legacy javax.ws.rs API detected${version ? ` (${version})` : ""}`,
    remediation: "Approve the Jakarta or Spring Web replacement strategy before planning can continue.",
    details: "Modern Spring Boot targets should not carry forward javax.ws.rs APIs without an explicit modernization plan.",
    coordinateHints: ["javax.ws.rs:javax.ws.rs-api"],
  },
];

function listLegacySourceArtifacts(db: Database.Database): SourceArtifact[] {
  return listArtifacts(db, { kind: "legacy-source" }).map((artifact) => ({
    id: artifact.id,
    path: artifact.path,
  }));
}

function findManifestFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      results.push(...findManifestFiles(full));
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name === "pom.xml" || entry.name === "build.gradle" || entry.name === "build.gradle.kts") {
      results.push(full);
    }
  }
  return results;
}

function parseDependencyVersions(legacyRoot: string): Map<string, string> {
  const versions = new Map<string, string>();
  for (const filePath of findManifestFiles(legacyRoot)) {
    const content = fs.readFileSync(filePath, "utf8");
    if (path.basename(filePath) === "pom.xml") {
      const regex = /<dependency>\s*<groupId>([^<]+)<\/groupId>\s*<artifactId>([^<]+)<\/artifactId>(?:\s*<version>([^<]+)<\/version>)?/gms;
      for (const match of content.matchAll(regex)) {
        const coordinate = `${match[1]?.trim()}:${match[2]?.trim()}`;
        const version = match[3]?.trim();
        if (coordinate && version) versions.set(coordinate, version);
      }
      continue;
    }

    const regex = /(?:implementation|api|compileOnly|runtimeOnly|testImplementation|testCompile)\s*\(?\s*['"]([^:'"]+):([^:'"]+):([^'"]+)['"]/g;
    for (const match of content.matchAll(regex)) {
      const coordinate = `${match[1]?.trim()}:${match[2]?.trim()}`;
      const version = match[3]?.trim();
      if (coordinate && version) versions.set(coordinate, version);
    }
  }
  return versions;
}

function collectLineMatches(content: string, pattern: RegExp): LineMatch[] {
  const results: LineMatch[] = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const localPattern = new RegExp(pattern.source, pattern.flags);
    for (const match of line.matchAll(localPattern)) {
      const symbol = match[0];
      if (!symbol) continue;
      results.push({
        symbol,
        line: index + 1,
        text: line.trim(),
      });
    }
  }
  return results;
}

function dedupeMatches(matches: LineMatch[]): LineMatch[] {
  const seen = new Set<string>();
  return matches.filter((match) => {
    const key = `${match.symbol}|${match.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function detectJvmFindings(content: string): JvmAuditFindingInput[] {
  return JVM_RULES.flatMap((rule) =>
    dedupeMatches(collectLineMatches(content, rule.match)).map((match) => ({
      tool: "source-scan",
      category: rule.category,
      severity: rule.severity,
      symbol: match.symbol,
      summary: rule.summary(match),
      evidence: `L${match.line}: ${match.text}`,
      remediation: rule.remediation,
    })),
  );
}

function resolveDependencyVersion(rule: DependencyRule, versions: Map<string, string>): string | null {
  for (const coordinate of rule.coordinateHints ?? []) {
    const version = versions.get(coordinate);
    if (version) return version;
  }
  return null;
}

function detectDependencyFindings(content: string, versions: Map<string, string>): DependencyFindingInput[] {
  return DEPENDENCY_RULES.flatMap((rule) => {
    const version = resolveDependencyVersion(rule, versions);
    return dedupeMatches(collectLineMatches(content, rule.match)).map((match) => ({
      dependency_name: rule.dependencyName,
      current_version: version,
      target_hint: rule.targetHint,
      category: rule.category,
      severity: rule.severity,
      summary: rule.summary(match, version),
      details: rule.details ? `${rule.details} Evidence: L${match.line}: ${match.text}` : `L${match.line}: ${match.text}`,
      remediation: rule.remediation,
    }));
  });
}

function findCompiledAuditInputs(legacyRoot: string): string[] {
  const candidates = [
    path.join(legacyRoot, "target", "classes"),
    path.join(legacyRoot, "build", "classes"),
    path.join(legacyRoot, "build", "classes", "java", "main"),
  ];
  const jars: string[] = [];
  const visit = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && entry.name.endsWith(".jar")) jars.push(full);
    }
  };
  visit(legacyRoot);
  return [...candidates.filter((candidate) => fs.existsSync(candidate)), ...jars];
}

function toolAvailable(command: string): boolean {
  const probe = spawnSync(command, ["--version"], { stdio: "ignore" });
  return probe.status === 0;
}

function collectToolStatus(legacyRoot: string): ToolStatus[] {
  const compiledInputs = findCompiledAuditInputs(legacyRoot);
  return [
    {
      name: "jdeps",
      available: toolAvailable("jdeps"),
      inspected_inputs: compiledInputs.length,
      note: compiledInputs.length > 0
        ? "Compiled classes or jars are available for optional JDK dependency inspection."
        : "No compiled classes or jars found under legacy/; source-scan heuristics were used instead.",
    },
    {
      name: "jdeprscan",
      available: toolAvailable("jdeprscan"),
      inspected_inputs: compiledInputs.length,
      note: compiledInputs.length > 0
        ? "Compiled classes or jars are available for optional deprecation inspection."
        : "No compiled classes or jars found under legacy/; source-scan heuristics were used instead.",
    },
  ];
}

export function refreshCompatibilityAudits(
  db: Database.Database,
  projectRoot: string,
): AuditRefreshSummary {
  const legacyRoot = path.join(projectRoot, "legacy");
  const dependencyVersions = parseDependencyVersions(legacyRoot);
  const artifacts = listLegacySourceArtifacts(db);
  let jvmCritical = 0;
  let jvmWarnings = 0;
  let dependencyTotal = 0;

  for (const artifact of artifacts) {
    const absPath = path.join(projectRoot, artifact.path);
    if (!fs.existsSync(absPath)) {
      replaceJvmAuditFindings(db, artifact.id, []);
      replaceDependencyFindings(db, artifact.id, []);
      continue;
    }

    const content = fs.readFileSync(absPath, "utf8");
    const jvmFindings = detectJvmFindings(content);
    const dependencyFindings = detectDependencyFindings(content, dependencyVersions);
    replaceJvmAuditFindings(db, artifact.id, jvmFindings);
    replaceDependencyFindings(db, artifact.id, dependencyFindings);
    jvmCritical += jvmFindings.filter((finding) => finding.severity === "critical").length;
    jvmWarnings += jvmFindings.filter((finding) => finding.severity === "warning").length;
    dependencyTotal += dependencyFindings.length;
  }

  const unresolved = (
    db.prepare(`
      SELECT COUNT(*) AS total
      FROM dependency_findings f
      LEFT JOIN dependency_strategies s ON s.finding_id = f.finding_id
      WHERE s.finding_id IS NULL
    `).get() as { total: number }
  ).total;

  const summary: AuditRefreshSummary = {
    artifact_count: artifacts.length,
    jvm: {
      critical: jvmCritical,
      warnings: jvmWarnings,
    },
    dependencies: {
      total: dependencyTotal,
      unresolved,
    },
    tools: collectToolStatus(legacyRoot),
  };

  setOperatorState(db, "pre_plan_audit", summary);
  return summary;
}
