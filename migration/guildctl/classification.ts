import fs from "fs";
import path from "path";
import { parse } from "yaml";
import type Database from "better-sqlite3";
import type { Role } from "../registry/types";
import { updateArtifact } from "../registry/commands/artifacts";
import type { LoadedStackPack } from "./stack";

export interface ClassificationSpec {
  version: number;
  frameworks: {
    allowed: string[];
    aliases?: Record<string, string>;
    fallback: string;
    ambiguous: string;
  };
  roles: { allowed: Role[] };
  modules?: {
    default?: string;
    source_roots?: Array<{ pattern: string; module_group?: number; suffix?: string }>;
  };
  quality?: {
    fallback_max_percentage?: number;
    fallback_concentration?: "error" | "warning" | "off";
    fallback_min_confidence?: number;
    fallback_required_evidence?: string;
  };
  tags?: {
    meaningful?: string[];
    generic?: string[];
  };
  signals?: ClassificationSignal[];
}

export interface ClassificationSignal {
  id: string;
  framework: string;
  role: Role;
  priority?: number;
  confidence?: number;
  evidence: string;
  match: {
    path?: string[];
    content?: string[];
  };
}

export interface ClassificationRecord {
  id: string;
  module: string;
  role: Role;
  framework: string;
  confidence: number;
  evidence: string[];
  ambiguous?: boolean;
  signals?: string[];
}

export interface BatchClassificationResult {
  accepted: number;
  dryRun: boolean;
  records: ClassificationRecord[];
}

export interface InventoryValidationReport {
  valid: boolean;
  expectedCount: number;
  registeredCount: number;
  classifiedCount: number;
  missingFields: Array<{ id: string; fields: string[] }>;
  invalidFrameworkValues: Record<string, number>;
  invalidRoleValues: Record<string, number>;
  ambiguousClassifications: string[];
  frameworkDistribution: Record<string, number>;
  roleDistribution: Record<string, number>;
  fallbackPercentage: number;
  modulePathInconsistencies: Array<{ id: string; module: string | null; path: string }>;
  unexpectedRegistrations: string[];
  unexpectedSecondClassRegistrations: string[];
  genericOnlyTagCount: number;
  lowConfidenceFallbacks: string[];
  fallbackMissingNegativeEvidence: string[];
  fallbackMissedSignals: Array<{ id: string; expectedFramework: string; signals: string[] }>;
  warnings: string[];
  completionStatus: "completed" | "missing" | "failed";
  errors: string[];
}

interface ArtifactRow {
  id: string;
  path: string;
  module: string | null;
  role: string | null;
  framework: string | null;
  tier: string;
}

export function loadClassificationSpec(pack: LoadedStackPack): ClassificationSpec {
  const manifest = pack.manifest as typeof pack.manifest & { classification_spec?: string };
  if (!manifest.classification_spec) {
    throw new Error(`[guildctl] Stack pack ${pack.manifest.id} is missing classification_spec`);
  }
  const specPath = path.join(pack.dir, manifest.classification_spec);
  const spec = parse(fs.readFileSync(specPath, "utf8")) as ClassificationSpec;
  validateSpec(spec, specPath);
  return spec;
}

function validateSpec(spec: ClassificationSpec, source = "classification spec"): void {
  const allowedFrameworks = new Set(spec.frameworks?.allowed ?? []);
  if (!allowedFrameworks.size) throw new Error(`${source}: frameworks.allowed must not be empty`);
  if (!allowedFrameworks.has(spec.frameworks.fallback)) throw new Error(`${source}: fallback framework must be allowed`);
  if (!allowedFrameworks.has(spec.frameworks.ambiguous)) throw new Error(`${source}: ambiguous framework must be allowed`);
  const allowedRoles = new Set(spec.roles?.allowed ?? []);
  if (!allowedRoles.size) throw new Error(`${source}: roles.allowed must not be empty`);
  for (const signal of spec.signals ?? []) {
    if (!allowedFrameworks.has(signal.framework)) throw new Error(`${source}: signal ${signal.id} uses unsupported framework ${signal.framework}`);
    if (!allowedRoles.has(signal.role)) throw new Error(`${source}: signal ${signal.id} uses unsupported role ${signal.role}`);
  }
}

export function normalizeFramework(spec: ClassificationSpec, raw: string): string {
  const value = raw.trim();
  const allowed = new Set(spec.frameworks.allowed);
  if (allowed.has(value)) return value;
  const lowerAliases = new Map(Object.entries(spec.frameworks.aliases ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const alias = lowerAliases.get(value.toLowerCase());
  if (alias && allowed.has(alias)) return alias;
  throw new Error(`unsupported framework "${raw}". Allowed: ${spec.frameworks.allowed.join(", ")}`);
}

export function deriveArtifactModule(spec: ClassificationSpec, filePath: string): string {
  const normalized = filePath.split(path.sep).join("/");
  for (const rule of spec.modules?.source_roots ?? []) {
    const match = normalized.match(new RegExp(rule.pattern));
    if (!match) continue;
    const moduleName = match[rule.module_group ?? 1] ?? spec.modules?.default ?? "default";
    return `${moduleName}${rule.suffix ?? ""}`;
  }
  return spec.modules?.default ?? "default";
}

function regexMatches(pattern: string, text: string): boolean {
  return new RegExp(pattern, "m").test(text);
}

function signalMatches(signal: ClassificationSignal, artifactPath: string, content: string): boolean {
  const pathMatches = signal.match.path?.some((pattern) => regexMatches(pattern, artifactPath)) ?? false;
  const contentMatches = signal.match.content?.some((pattern) => regexMatches(pattern, content)) ?? false;
  if (signal.match.path && !pathMatches) return false;
  if (signal.match.content && !contentMatches) return false;
  return Boolean(signal.match.path || signal.match.content);
}

function inferPlainRole(artifactPath: string, content: string): Role {
  if (/\/test\//i.test(artifactPath) || /Test\.(java|py)$/i.test(artifactPath)) return "test";
  if (/\binterface\s+\w+/.test(content)) return "interface";
  if (/\b(class|record)\s+\w*(Dto|DTO|Model|Entity|Record)\b/.test(content)) return "model";
  return "utility";
}

export function classifyArtifactSource(
  spec: ClassificationSpec,
  artifact: { id: string; path: string },
  workspaceRoot: string,
): ClassificationRecord {
  const absolutePath = path.join(workspaceRoot, artifact.path);
  const content = fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, "utf8") : "";
  const matches = (spec.signals ?? []).filter((signal) => signalMatches(signal, artifact.path, content));
  const module = deriveArtifactModule(spec, artifact.path);
  if (matches.length === 0) {
    return {
      id: artifact.id,
      module,
      role: inferPlainRole(artifact.path, content),
      framework: spec.frameworks.fallback,
      confidence: spec.quality?.fallback_min_confidence ?? 0.75,
      evidence: [`negative-evidence: no configured framework signal matched for ${spec.frameworks.fallback}`],
      signals: [],
    };
  }

  const bestPriority = Math.min(...matches.map((signal) => signal.priority ?? 100));
  const best = matches.filter((signal) => (signal.priority ?? 100) === bestPriority);
  const frameworks = [...new Set(best.map((signal) => signal.framework))];
  if (frameworks.length > 1) {
    return {
      id: artifact.id,
      module,
      role: best[0]!.role,
      framework: spec.frameworks.ambiguous,
      confidence: Math.min(...best.map((signal) => signal.confidence ?? 0.5)),
      ambiguous: true,
      evidence: best.map((signal) => `${signal.framework}:${signal.evidence}`),
      signals: best.map((signal) => signal.id),
    };
  }
  const selected = best[0]!;
  return {
    id: artifact.id,
    module,
    role: selected.role,
    framework: selected.framework,
    confidence: selected.confidence ?? 0.8,
    evidence: best.map((signal) => `${signal.framework}:${signal.evidence}`),
    signals: best.map((signal) => signal.id),
  };
}

function validateBatch(db: Database.Database, spec: ClassificationSpec, records: ClassificationRecord[]): ClassificationRecord[] {
  const seen = new Set<string>();
  const allowedRoles = new Set(spec.roles.allowed);
  const normalized: ClassificationRecord[] = [];
  for (const record of records) {
    if (seen.has(record.id)) throw new Error(`duplicate classification record for ${record.id}`);
    seen.add(record.id);
    const artifact = db.prepare("SELECT id FROM artifacts WHERE id = ?").get(record.id);
    if (!artifact) throw new Error(`unknown artifact id ${record.id}`);
    const missing = ["module", "role", "framework"].filter((field) => !(record as unknown as Record<string, unknown>)[field]);
    if (missing.length) throw new Error(`incomplete classification for ${record.id}: missing ${missing.join(", ")}`);
    if (!allowedRoles.has(record.role)) throw new Error(`unsupported role "${record.role}" for ${record.id}`);
    if (!Number.isFinite(record.confidence) || record.confidence < 0 || record.confidence > 1) throw new Error(`invalid confidence for ${record.id}`);
    if (!record.evidence?.length) throw new Error(`missing evidence for ${record.id}`);
    normalized.push({ ...record, framework: normalizeFramework(spec, record.framework) });
  }
  return normalized;
}

// ─── Evidence JSON coercion + safe reader ────────────────────────────────────
//
// The context-agent sometimes persists evidence as a plain string instead of a
// JSON array of strings. We coerce at WRITE time so evidence_json on disk is
// always a JSON array of strings, and we read with a never-throwing parser so
// legacy malformed rows (written before this fix) never crash the quality gate.

export function coerceEvidence(evidence: unknown): string {
  if (evidence == null) return "[]";
  if (typeof evidence === "string") {
    const trimmed = evidence.trim();
    if (trimmed === "") return "[]";
    // Already a serialized array? Keep it only if it parses back to an array.
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return trimmed;
      } catch {
        /* fall through to wrap */
      }
    }
    return JSON.stringify([evidence]);
  }
  if (Array.isArray(evidence)) {
    const items = evidence.map((item) =>
      typeof item === "string" ? item : JSON.stringify(item),
    );
    return JSON.stringify(items);
  }
  // object / number / boolean — wrap its string form and let callers log.
  return JSON.stringify([String(evidence)]);
}

export function parseEvidence(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => (typeof item === "string" ? item : JSON.stringify(item)));
    }
    if (typeof parsed === "string") {
      // Legacy row stored a stringified string (e.g. "\"plain text\"").
      return [parsed];
    }
    return [];
  } catch {
    return [];
  }
}

export function applyBatchClassification(
  db: Database.Database,
  spec: ClassificationSpec,
  records: ClassificationRecord[],
  opts: { dryRun?: boolean } = {},
): BatchClassificationResult {
  const normalized = validateBatch(db, spec, records);
  if (!opts.dryRun) {
    const tx = db.transaction(() => {
      for (const record of normalized) {
        updateArtifact(db, { id: record.id, module: record.module, role: record.role, framework: record.framework });
        db.prepare(`
          INSERT INTO artifact_classifications (artifact_id, framework, role, confidence, ambiguous, evidence_json, signals_json, updated_at)
          VALUES (@artifact_id, @framework, @role, @confidence, @ambiguous, @evidence_json, @signals_json, datetime('now'))
          ON CONFLICT(artifact_id) DO UPDATE SET
            framework = excluded.framework,
            role = excluded.role,
            confidence = excluded.confidence,
            ambiguous = excluded.ambiguous,
            evidence_json = excluded.evidence_json,
            signals_json = excluded.signals_json,
            updated_at = datetime('now')
        `).run({
          artifact_id: record.id,
          framework: record.framework,
          role: record.role,
          confidence: record.confidence,
          ambiguous: record.ambiguous ? 1 : 0,
          evidence_json: coerceEvidence(record.evidence),
          signals_json: JSON.stringify(record.signals ?? []),
        });
      }
    });
    tx();
  }
  return { accepted: normalized.length, dryRun: Boolean(opts.dryRun), records: normalized };
}

export function formatInventoryValidationReport(report: InventoryValidationReport): string {
  const lines = [
    `Inventory validation: ${report.valid ? "PASS" : "FAIL"}`,
    `expected=${report.expectedCount} registered=${report.registeredCount} classified=${report.classifiedCount} completion=${report.completionStatus}`,
    `fallback=${report.fallbackPercentage.toFixed(1)}%`,
    `frameworks=${JSON.stringify(report.frameworkDistribution)}`,
    `roles=${JSON.stringify(report.roleDistribution)}`,
  ];
  for (const warning of report.warnings) lines.push(`! ${warning}`);
  for (const error of report.errors) lines.push(`- ${error}`);
  return lines.join("\n");
}

export function getInventoryCompletionStatus(db: Database.Database): "completed" | "missing" | "failed" {
  const raw = db.prepare("SELECT value FROM operator_state WHERE key = 'inventory_completion'").pluck().get() as string | undefined;
  if (!raw) return "missing";
  try {
    const parsed = JSON.parse(raw) as { status?: string };
    return parsed.status === "completed" ? "completed" : "failed";
  } catch {
    return "failed";
  }
}

export function recordInventoryCompletion(db: Database.Database, value: { status: "completed" | "failed"; runId?: string; reason?: string }): void {
  db.prepare(`
    INSERT INTO operator_state (key, value, updated_at) VALUES ('inventory_completion', @value, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run({ value: JSON.stringify(value) });
}

function classificationFor(db: Database.Database, artifactId: string): { confidence: number; evidence_json: string } | undefined {
  return db.prepare("SELECT confidence, evidence_json FROM artifact_classifications WHERE artifact_id = ?").get(artifactId) as { confidence: number; evidence_json: string } | undefined;
}

export function validateInventoryQuality(
  db: Database.Database,
  spec: ClassificationSpec,
  opts: {
    expectedArtifactIds?: string[];
    allowedSecondClassArtifactIds?: string[];
    completionStatus?: "completed" | "missing" | "failed";
    requireCompletion?: boolean;
    workspaceRoot?: string;
  } = {},
): InventoryValidationReport {
  const artifacts = db.prepare("SELECT id, path, module, role, framework, tier FROM artifacts WHERE tier = 'first-class' ORDER BY id").all() as ArtifactRow[];
  const allArtifacts = db.prepare("SELECT id, path, module, role, framework, tier FROM artifacts ORDER BY id").all() as ArtifactRow[];
  const expectedIds = opts.expectedArtifactIds ?? artifacts.map((artifact) => artifact.id);
  const expectedSet = new Set(expectedIds);
  const allowedSecondClassSet = new Set(opts.allowedSecondClassArtifactIds ?? allArtifacts.filter((artifact) => artifact.tier === "second-class").map((artifact) => artifact.id));
  const allowedFrameworks = new Set(spec.frameworks.allowed);
  const allowedRoles = new Set(spec.roles.allowed as string[]);
  const meaningfulTags = new Set(spec.tags?.meaningful ?? []);
  const genericTags = new Set(spec.tags?.generic ?? ["analyzed"]);
  const frameworkDistribution: Record<string, number> = {};
  const roleDistribution: Record<string, number> = {};
  const invalidFrameworkValues: Record<string, number> = {};
  const invalidRoleValues: Record<string, number> = {};
  const missingFields: InventoryValidationReport["missingFields"] = [];
  const ambiguousClassifications: string[] = [];
  const modulePathInconsistencies: InventoryValidationReport["modulePathInconsistencies"] = [];
  const unexpectedRegistrations = artifacts.filter((artifact) => !expectedSet.has(artifact.id)).map((artifact) => artifact.id);
  const unexpectedSecondClassRegistrations = allArtifacts.filter((artifact) => artifact.tier === "second-class" && !allowedSecondClassSet.has(artifact.id)).map((artifact) => artifact.id);
  const lowConfidenceFallbacks: string[] = [];
  const fallbackMissingNegativeEvidence: string[] = [];
  const fallbackMissedSignals: InventoryValidationReport["fallbackMissedSignals"] = [];
  const warnings: string[] = [];
  let classifiedCount = 0;
  let fallbackCount = 0;
  let genericOnlyTagCount = 0;

  for (const artifact of artifacts) {
    const missing = ["module", "role", "framework"].filter((field) => (artifact as unknown as Record<string, unknown>)[field] == null || (artifact as unknown as Record<string, unknown>)[field] === "");
    if (missing.length) missingFields.push({ id: artifact.id, fields: missing });
    else classifiedCount++;
    if (artifact.framework) {
      frameworkDistribution[artifact.framework] = (frameworkDistribution[artifact.framework] ?? 0) + 1;
      if (!allowedFrameworks.has(artifact.framework)) invalidFrameworkValues[artifact.framework] = (invalidFrameworkValues[artifact.framework] ?? 0) + 1;
      if (artifact.framework === spec.frameworks.fallback || artifact.framework === "Java-EE") fallbackCount++;
      if (artifact.framework === spec.frameworks.ambiguous) ambiguousClassifications.push(artifact.id);
    }
    if (artifact.role) {
      roleDistribution[artifact.role] = (roleDistribution[artifact.role] ?? 0) + 1;
      if (!allowedRoles.has(artifact.role)) invalidRoleValues[artifact.role] = (invalidRoleValues[artifact.role] ?? 0) + 1;
    }
    if (artifact.module) {
      const expectedModule = deriveArtifactModule(spec, artifact.path);
      if (expectedModule !== "default" && artifact.module !== expectedModule) modulePathInconsistencies.push({ id: artifact.id, module: artifact.module, path: artifact.path });
    }
    if (artifact.framework === spec.frameworks.fallback) {
      const classification = classificationFor(db, artifact.id);
      const minConfidence = spec.quality?.fallback_min_confidence ?? 0.75;
      const requiredEvidence = spec.quality?.fallback_required_evidence ?? "negative-evidence";
      if (!classification || classification.confidence < minConfidence) lowConfidenceFallbacks.push(artifact.id);
      let evidence: string[] = parseEvidence(classification?.evidence_json);
      if (!evidence.some((item) => item.includes(requiredEvidence))) fallbackMissingNegativeEvidence.push(artifact.id);
      const inferred = classifyArtifactSource(spec, { id: artifact.id, path: artifact.path }, opts.workspaceRoot ?? process.cwd());
      if (inferred.framework !== spec.frameworks.fallback && inferred.framework !== spec.frameworks.ambiguous) {
        fallbackMissedSignals.push({ id: artifact.id, expectedFramework: inferred.framework, signals: inferred.signals ?? [] });
      }
    }
    const tags = db.prepare("SELECT tag FROM artifact_tags WHERE artifact_id = ?").pluck().all(artifact.id) as string[];
    if (tags.length > 0 && tags.every((tag) => genericTags.has(tag)) && !tags.some((tag) => meaningfulTags.has(tag))) genericOnlyTagCount++;
  }

  for (const expectedId of expectedIds) {
    if (!artifacts.some((artifact) => artifact.id === expectedId)) missingFields.push({ id: expectedId, fields: ["registration"] });
  }

  const fallbackPercentage = artifacts.length === 0 ? 0 : (fallbackCount / artifacts.length) * 100;
  const completionStatus = opts.completionStatus ?? (opts.requireCompletion ? getInventoryCompletionStatus(db) : "completed");
  const errors: string[] = [];
  if (completionStatus !== "completed") errors.push(`inventory completion evidence is ${completionStatus}`);
  if (missingFields.length) errors.push(`${missingFields.length} artifact(s) have missing classification fields`);
  if (Object.keys(invalidFrameworkValues).length) errors.push(`invalid framework values: ${JSON.stringify(invalidFrameworkValues)}`);
  if (Object.keys(invalidRoleValues).length) errors.push(`invalid role values: ${JSON.stringify(invalidRoleValues)}`);
  if (ambiguousClassifications.length) errors.push(`${ambiguousClassifications.length} ambiguous classification(s) require review`);
  if (artifacts.length >= 10 && fallbackPercentage > (spec.quality?.fallback_max_percentage ?? 50)) {
    const message = `fallback concentration ${fallbackPercentage.toFixed(1)}% exceeds advisory limit ${spec.quality?.fallback_max_percentage ?? 50}%`;
    const mode = spec.quality?.fallback_concentration ?? "warning";
    if (mode === "error") errors.push(message);
    else if (mode === "warning") warnings.push(message);
  }
  if (modulePathInconsistencies.length) errors.push(`${modulePathInconsistencies.length} module/path inconsistencies`);
  if (unexpectedRegistrations.length) errors.push(`${unexpectedRegistrations.length} unexpected registration(s): first-class`);
  if (unexpectedSecondClassRegistrations.length) errors.push(`${unexpectedSecondClassRegistrations.length} unexpected registration(s): second-class`);
  if (lowConfidenceFallbacks.length) errors.push(`${lowConfidenceFallbacks.length} low-confidence fallback classification(s)`);
  if (fallbackMissingNegativeEvidence.length) errors.push(`${fallbackMissingNegativeEvidence.length} fallback classification(s) missing negative evidence`);
  if (fallbackMissedSignals.length) errors.push(`${fallbackMissedSignals.length} fallback classification(s) missed configured framework signal(s)`);
  if (genericOnlyTagCount > 0) errors.push(`${genericOnlyTagCount} artifact(s) have only generic lifecycle tags; tags do not count as classification evidence`);

  return {
    valid: errors.length === 0,
    expectedCount: expectedIds.length,
    registeredCount: artifacts.length,
    classifiedCount,
    missingFields,
    invalidFrameworkValues,
    invalidRoleValues,
    ambiguousClassifications,
    frameworkDistribution,
    roleDistribution,
    fallbackPercentage,
    modulePathInconsistencies,
    unexpectedRegistrations,
    unexpectedSecondClassRegistrations,
    genericOnlyTagCount,
    lowConfidenceFallbacks,
    fallbackMissingNegativeEvidence,
    fallbackMissedSignals,
    warnings,
    completionStatus,
    errors,
  };
}
