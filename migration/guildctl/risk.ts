import type Database from "better-sqlite3";
import type { LoadedStackPack } from "./stack";
import { loadClassificationSpec } from "./classification";

// ─── Risk Threshold Configuration (data-model.md Entity 2) ──────────────────

export interface RiskReflectionPattern {
  id: string;
  match: string;
  flags?: string;
  evidence: string;
}

export interface RiskSpec {
  god_method_max_lines?: number;
  cyclomatic_complexity_limit?: number;
  high_risk_score_cutoff?: number;
  method_boundary?: {
    style: "brace" | "indent";
    start_pattern: string;
  };
  complexity_keywords?: string[];
  reflection_patterns?: RiskReflectionPattern[];
}

export interface ResolvedRiskSpec {
  godMethodMaxLines: number;
  cyclomaticComplexityLimit: number;
  highRiskScoreCutoff: number;
  methodBoundary: { style: "brace" | "indent"; startPattern: string };
  complexityKeywords: string[];
  reflectionPatterns: RiskReflectionPattern[];
}

// Built-in defaults (research.md §2-3): used whenever a stack pack's `risk:`
// block, or an individual field within it, is absent.
export const DEFAULT_GOD_METHOD_MAX_LINES = 80;
export const DEFAULT_CYCLOMATIC_COMPLEXITY_LIMIT = 15;
export const DEFAULT_HIGH_RISK_SCORE_CUTOFF = 50;
export const DEFAULT_METHOD_BOUNDARY: { style: "brace" | "indent"; startPattern: string } = {
  style: "brace",
  startPattern: String.raw`(public|private|protected)[^;{]*\([^)]*\)\s*(throws\s+[\w,\s]+)?\s*\{`,
};
export const DEFAULT_COMPLEXITY_KEYWORDS = ["if", "else if", "for", "while", "case", "catch", "&&", "||", "?"];
export const DEFAULT_REFLECTION_PATTERNS: RiskReflectionPattern[] = [
  { id: "java-class-forName", match: String.raw`\bClass\.forName\s*\(`, evidence: "Class.forName reflective load" },
  { id: "java-method-invoke", match: String.raw`\.getMethod\s*\([^)]*\)\s*\.invoke\s*\(`, evidence: "Method.invoke reflective call" },
];

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isCompilableRegExp(pattern: string, flags?: string): boolean {
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern, flags);
    return true;
  } catch {
    return false;
  }
}

export function validateRiskSpec(risk: RiskSpec | undefined, source = "risk spec"): void {
  if (!risk) return;

  if (risk.god_method_max_lines !== undefined && !isPositiveFiniteNumber(risk.god_method_max_lines)) {
    throw new Error(`${source}: risk.god_method_max_lines must be a finite number > 0`);
  }
  if (risk.cyclomatic_complexity_limit !== undefined && !isPositiveFiniteNumber(risk.cyclomatic_complexity_limit)) {
    throw new Error(`${source}: risk.cyclomatic_complexity_limit must be a finite number > 0`);
  }
  if (risk.high_risk_score_cutoff !== undefined && !isNonNegativeFiniteNumber(risk.high_risk_score_cutoff)) {
    throw new Error(`${source}: risk.high_risk_score_cutoff must be a finite number >= 0`);
  }
  if (risk.method_boundary) {
    if (risk.method_boundary.style !== "brace" && risk.method_boundary.style !== "indent") {
      throw new Error(`${source}: risk.method_boundary.style must be "brace" or "indent"`);
    }
    if (!isCompilableRegExp(risk.method_boundary.start_pattern)) {
      throw new Error(`${source}: risk.method_boundary.start_pattern must be a valid regular expression`);
    }
  }
  const seenIds = new Set<string>();
  for (const [index, pattern] of (risk.reflection_patterns ?? []).entries()) {
    if (!isCompilableRegExp(pattern.match, pattern.flags)) {
      throw new Error(`${source}: risk.reflection_patterns[${index}].match must be a valid regular expression`);
    }
    if (seenIds.has(pattern.id)) {
      throw new Error(`${source}: risk.reflection_patterns has duplicate id "${pattern.id}"`);
    }
    seenIds.add(pattern.id);
  }
}

export function resolveRiskSpec(risk: RiskSpec | undefined): ResolvedRiskSpec {
  return {
    godMethodMaxLines: risk?.god_method_max_lines ?? DEFAULT_GOD_METHOD_MAX_LINES,
    cyclomaticComplexityLimit: risk?.cyclomatic_complexity_limit ?? DEFAULT_CYCLOMATIC_COMPLEXITY_LIMIT,
    highRiskScoreCutoff: risk?.high_risk_score_cutoff ?? DEFAULT_HIGH_RISK_SCORE_CUTOFF,
    methodBoundary: risk?.method_boundary
      ? { style: risk.method_boundary.style, startPattern: risk.method_boundary.start_pattern }
      : DEFAULT_METHOD_BOUNDARY,
    complexityKeywords: risk?.complexity_keywords ?? DEFAULT_COMPLEXITY_KEYWORDS,
    reflectionPatterns: risk?.reflection_patterns ?? DEFAULT_REFLECTION_PATTERNS,
  };
}

export function loadRiskSpec(pack: LoadedStackPack): ResolvedRiskSpec {
  const spec = loadClassificationSpec(pack);
  validateRiskSpec(spec.risk, `${pack.manifest.id} risk spec`);
  return resolveRiskSpec(spec.risk);
}

// ─── Scanner (research.md §2, §6, §7) ────────────────────────────────────────

export interface RiskAssessmentRecord {
  id: string;
  riskScore: number;
  highRisk: boolean;
  reasonCodes: string[];
  signals: Record<string, unknown>;
}

interface MethodBoundary {
  name: string;
  startLine: number; // 1-indexed
  endLine: number; // 1-indexed, inclusive
  lineCount: number;
  body: string;
}

interface ReflectionHit {
  patternId: string;
  line: number;
  evidence: string;
}

function extractMethodName(signatureLine: string): string {
  const match = signatureLine.match(/\b([A-Za-z_$][\w$]*)\s*\(/);
  return match?.[1] ?? "method";
}

function indentOf(line: string): number {
  return line.match(/^[ \t]*/)?.[0].length ?? 0;
}

function findMethodBoundariesBrace(lines: string[], startPattern: RegExp): MethodBoundary[] {
  const boundaries: MethodBoundary[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!startPattern.test(line)) {
      i++;
      continue;
    }
    let depth = 0;
    for (const ch of line) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    let end = i;
    while (end + 1 < lines.length && depth > 0) {
      end++;
      for (const ch of lines[end]!) {
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
      }
    }
    const body = lines.slice(i, end + 1).join("\n");
    boundaries.push({ name: extractMethodName(line), startLine: i + 1, endLine: end + 1, lineCount: end - i + 1, body });
    i = end + 1;
  }
  return boundaries;
}

function findMethodBoundariesIndent(lines: string[], startPattern: RegExp): MethodBoundary[] {
  const boundaries: MethodBoundary[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!startPattern.test(line)) {
      i++;
      continue;
    }
    const baseIndent = indentOf(line);
    let end = i;
    let j = i + 1;
    while (j < lines.length) {
      const candidate = lines[j]!;
      if (candidate.trim() === "") {
        j++;
        continue;
      }
      if (indentOf(candidate) <= baseIndent) break;
      end = j;
      j++;
    }
    const body = lines.slice(i, end + 1).join("\n");
    boundaries.push({ name: extractMethodName(line), startLine: i + 1, endLine: end + 1, lineCount: end - i + 1, body });
    i = end + 1;
  }
  return boundaries;
}

function findMethodBoundaries(content: string, methodBoundary: ResolvedRiskSpec["methodBoundary"]): MethodBoundary[] {
  const lines = content.split(/\r?\n/);
  const startPattern = new RegExp(methodBoundary.startPattern);
  return methodBoundary.style === "indent"
    ? findMethodBoundariesIndent(lines, startPattern)
    : findMethodBoundariesBrace(lines, startPattern);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countComplexityKeywords(text: string, keywords: string[]): number {
  let total = 0;
  for (const keyword of keywords) {
    const isWordLike = /^[A-Za-z_][A-Za-z_0-9 ]*$/.test(keyword);
    const pattern = isWordLike
      ? new RegExp(`\\b${escapeRegExp(keyword)}\\b`, "g")
      : new RegExp(escapeRegExp(keyword), "g");
    total += text.match(pattern)?.length ?? 0;
  }
  return total;
}

function detectReflection(content: string, patterns: RiskReflectionPattern[]): ReflectionHit[] {
  const hits: ReflectionHit[] = [];
  const lines = content.split(/\r?\n/);
  for (const pattern of patterns) {
    const base = new RegExp(pattern.match, pattern.flags);
    for (const [index, line] of lines.entries()) {
      if (new RegExp(base.source, base.flags).test(line)) {
        hits.push({ patternId: pattern.id, line: index + 1, evidence: pattern.evidence });
      }
    }
  }
  return hits;
}

/**
 * Computes a deterministic risk assessment for one artifact's source text,
 * per research.md §7's weighted-sum-of-overages formula: each heuristic's
 * contribution is capped independently, and the total is clamped to [0, 100].
 */
export function scoreArtifact(id: string, content: string, spec: ResolvedRiskSpec): RiskAssessmentRecord {
  const reasonCodes: string[] = [];
  const signals: Record<string, unknown> = {};

  const reflectionHits = detectReflection(content, spec.reflectionPatterns);
  const hitPatternIds = [...new Set(reflectionHits.map((hit) => hit.patternId))];
  for (const patternId of hitPatternIds) reasonCodes.push(`reflection-usage:${patternId}`);
  signals["reflection"] = { hits: reflectionHits.length, patterns: hitPatternIds };

  const methods = findMethodBoundaries(content, spec.methodBoundary);

  let methodLinesOverage = 0;
  let complexityOverage = 0;

  if (methods.length === 0) {
    reasonCodes.push("heuristic-skipped:god-method");
    reasonCodes.push("heuristic-skipped:cyclomatic-complexity");
    signals["godMethod"] = { skipped: true };
    signals["cyclomaticComplexity"] = { skipped: true };
  } else {
    const worstGodMethod = methods.reduce((worst, m) => (m.lineCount > worst.lineCount ? m : worst));
    if (worstGodMethod.lineCount > spec.godMethodMaxLines) {
      methodLinesOverage = worstGodMethod.lineCount - spec.godMethodMaxLines;
      reasonCodes.push(
        `god-method:${worstGodMethod.name}@L${worstGodMethod.startLine} (${worstGodMethod.lineCount} lines > ${spec.godMethodMaxLines})`,
      );
    }
    signals["godMethod"] = { worstLines: worstGodMethod.lineCount, limit: spec.godMethodMaxLines };

    let worstComplexityMethod: MethodBoundary | undefined;
    let worstComplexityValue = 0;
    for (const method of methods) {
      const value = 1 + countComplexityKeywords(method.body, spec.complexityKeywords);
      if (value > worstComplexityValue) {
        worstComplexityValue = value;
        worstComplexityMethod = method;
      }
    }
    if (worstComplexityMethod && worstComplexityValue > spec.cyclomaticComplexityLimit) {
      complexityOverage = worstComplexityValue - spec.cyclomaticComplexityLimit;
      reasonCodes.push(
        `cyclomatic-complexity:${worstComplexityMethod.name}@L${worstComplexityMethod.startLine} (complexity ${worstComplexityValue} > ${spec.cyclomaticComplexityLimit})`,
      );
    }
    signals["cyclomaticComplexity"] = { worstValue: worstComplexityValue, limit: spec.cyclomaticComplexityLimit };
  }

  const riskScore = Math.min(
    100,
    (reflectionHits.length > 0 ? 30 : 0) +
      Math.min(35, methodLinesOverage * 0.5) +
      Math.min(35, complexityOverage * 2),
  );

  return {
    id,
    riskScore,
    highRisk: riskScore > spec.highRiskScoreCutoff,
    reasonCodes,
    signals,
  };
}

// ─── Persistence (data-model.md Entity 1; contracts/registry-schema.md) ─────

/**
 * Upserts one artifact's risk assessment into artifact_risk_assessments.
 * A second call for the same artifact REPLACES the stored row (score, reason
 * codes, signals) — it never accumulates (FR-015). Mirrors the
 * artifact_classifications upsert in classification.ts's applyBatchClassification.
 *
 * US3 gate seeding (data-model.md Entity 3): when the freshly computed record is
 * high-risk and no risk_confirmations row exists yet, a `pending` row is created
 * in the same transaction. An existing confirmed/declined decision is NEVER
 * reset by a recompute — only newly high-risk artifacts enter the review queue.
 */
export function applyRiskAssessment(db: Database.Database, record: RiskAssessmentRecord): void {
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO artifact_risk_assessments (artifact_id, risk_score, high_risk, reason_codes_json, signals_json, updated_at)
      VALUES (@artifact_id, @risk_score, @high_risk, @reason_codes_json, @signals_json, datetime('now'))
      ON CONFLICT(artifact_id) DO UPDATE SET
        risk_score = excluded.risk_score,
        high_risk = excluded.high_risk,
        reason_codes_json = excluded.reason_codes_json,
        signals_json = excluded.signals_json,
        updated_at = datetime('now')
    `).run({
      artifact_id: record.id,
      risk_score: record.riskScore,
      high_risk: record.highRisk ? 1 : 0,
      reason_codes_json: JSON.stringify(record.reasonCodes ?? []),
      signals_json: JSON.stringify(record.signals ?? {}),
    });
    if (record.highRisk) {
      db.prepare(`
        INSERT INTO risk_confirmations (artifact_id, decision)
        VALUES (?, 'pending')
        ON CONFLICT(artifact_id) DO NOTHING
      `).run(record.id);
    }
  });
  tx();
}

/** Writes multiple artifacts' risk assessments inside a single transaction. */
export function applyBatchRiskAssessment(db: Database.Database, records: RiskAssessmentRecord[]): void {
  const tx = db.transaction(() => {
    for (const record of records) applyRiskAssessment(db, record);
  });
  tx();
}
