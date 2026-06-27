import * as fs from "fs";
import * as path from "path";
import type Database from "better-sqlite3";
import { listArtifacts } from "../registry/commands/queries";
import { replaceDependencyFindings, replaceJvmAuditFindings } from "../registry/commands/modernization";
import { setOperatorState } from "../registry/commands/operator";
import type { DependencyFindingInput, JvmAuditFindingInput } from "../registry/commands/modernization";
import { findMatchingFiles, interpolate, loadActiveStack, runExternalProbes, type StackAuditRule } from "./stack";
import { resolveGuildConfig } from "./config";

interface SourceArtifact { id: string; path: string }
interface LineMatch { symbol: string; line: number; text: string }
interface ToolStatus { name: string; available: boolean; inspected_inputs: number; note: string }

export interface AuditRefreshSummary {
  artifact_count: number;
  jvm: { critical: number; warnings: number };
  dependencies: { total: number; unresolved: number };
  tools: ToolStatus[];
}

function listLegacySourceArtifacts(db: Database.Database): SourceArtifact[] {
  return listArtifacts(db, { kind: "legacy-source" }).map((artifact) => ({ id: artifact.id, path: artifact.path }));
}

function parseDependencyVersions(root: string, pack: ReturnType<typeof loadActiveStack>): Map<string, string> {
  const versions = new Map<string, string>();
  for (const filePath of findMatchingFiles(root, pack.manifest.manifest_globs)) {
    const parser = pack.manifest.dependency_parsers.find((candidate) => path.basename(filePath) === candidate.match);
    if (!parser) continue;
    const regex = new RegExp(parser.pattern, parser.flags);
    for (const match of fs.readFileSync(filePath, "utf8").matchAll(regex)) {
      const coordinate = `${match[1]?.trim()}:${match[2]?.trim()}`;
      const version = match[3]?.trim();
      if (coordinate && version) versions.set(coordinate, version);
    }
  }
  return versions;
}

function collectLineMatches(content: string, rule: StackAuditRule): LineMatch[] {
  const results: LineMatch[] = [];
  const seen = new Set<string>();
  const pattern = new RegExp(rule.match, rule.flags);
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    for (const match of line.matchAll(new RegExp(pattern.source, pattern.flags))) {
      const symbol = match[0];
      const key = `${symbol}|${index + 1}`;
      if (!symbol || seen.has(key)) continue;
      seen.add(key);
      results.push({ symbol, line: index + 1, text: line.trim() });
    }
  }
  return results;
}

function versionText(version: string | null): string {
  return version ? ` (${version})` : "";
}

function detectJvmFindings(content: string, rules: StackAuditRule[]): JvmAuditFindingInput[] {
  return rules.filter((rule) => rule.finding === "jvm").flatMap((rule) => collectLineMatches(content, rule).map((match) => ({
    tool: "source-scan",
    category: rule.category as JvmAuditFindingInput["category"],
    severity: rule.severity,
    symbol: match.symbol,
    summary: interpolate(rule.summary_template, match),
    evidence: `L${match.line}: ${match.text}`,
    remediation: rule.remediation,
  })));
}

function detectDependencyFindings(content: string, rules: StackAuditRule[], versions: Map<string, string>): DependencyFindingInput[] {
  return rules.filter((rule) => rule.finding === "dependency").flatMap((rule) => {
    const version = rule.coordinate_hints?.map((coordinate) => versions.get(coordinate)).find(Boolean) ?? null;
    return collectLineMatches(content, rule).map((match) => ({
      dependency_name: rule.dependency_name!,
      current_version: version,
      target_hint: rule.target_hint!,
      category: rule.category as DependencyFindingInput["category"],
      severity: rule.severity,
      summary: interpolate(rule.summary_template, { ...match, version: versionText(version) }),
      details: rule.details_template
        ? interpolate(rule.details_template, { ...match, version: versionText(version) })
        : `L${match.line}: ${match.text}`,
      remediation: rule.remediation,
    }));
  });
}

export function refreshCompatibilityAudits(db: Database.Database, projectRoot: string): AuditRefreshSummary {
  const legacyRoot = path.join(projectRoot, "legacy");
  const pack = loadActiveStack(resolveGuildConfig({ cwd: projectRoot }), projectRoot);
  const dependencyVersions = parseDependencyVersions(legacyRoot, pack);
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
    const jvmFindings = detectJvmFindings(content, pack.rules);
    const dependencyFindings = detectDependencyFindings(content, pack.rules, dependencyVersions);
    replaceJvmAuditFindings(db, artifact.id, jvmFindings);
    replaceDependencyFindings(db, artifact.id, dependencyFindings);
    jvmCritical += jvmFindings.filter((finding) => finding.severity === "critical").length;
    jvmWarnings += jvmFindings.filter((finding) => finding.severity === "warning").length;
    dependencyTotal += dependencyFindings.length;
  }

  const unresolved = (db.prepare(`SELECT COUNT(*) AS total FROM dependency_findings f LEFT JOIN dependency_strategies s ON s.finding_id = f.finding_id WHERE s.finding_id IS NULL`).get() as { total: number }).total;
  const summary: AuditRefreshSummary = {
    artifact_count: artifacts.length,
    jvm: { critical: jvmCritical, warnings: jvmWarnings },
    dependencies: { total: dependencyTotal, unresolved },
    tools: runExternalProbes(legacyRoot, pack.manifest.audit.external_probes),
  };
  setOperatorState(db, "pre_plan_audit", summary);
  return summary;
}
