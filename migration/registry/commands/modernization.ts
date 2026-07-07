import { createHash } from "crypto";
import type Database from "better-sqlite3";
import { RegistryError, validateId } from "../types";
import type {
  DependencyFinding,
  DependencyRiskCategory,
  DependencyStrategyDecision,
  DependencyStrategyKind,
  FindingSeverity,
  JvmAuditCategory,
  JvmAuditFinding,
  AuditOverride,
} from "../types";

export interface JvmAuditFindingInput {
  tool: string;
  category: JvmAuditCategory;
  severity: FindingSeverity;
  symbol?: string | null;
  summary: string;
  evidence?: string | null;
  remediation: string;
}

export interface DependencyFindingInput {
  dependency_name: string;
  current_version?: string | null;
  target_hint?: string | null;
  category: DependencyRiskCategory;
  severity: FindingSeverity;
  summary: string;
  details?: string | null;
  remediation: string;
}

export interface DependencyFindingWithStrategy extends DependencyFinding {
  strategy: DependencyStrategyKind | null;
  target_dependency: string | null;
  target_version: string | null;
  rationale: string | null;
  approved_by: string | null;
  approved_at: string | null;
}

export interface ListJvmAuditFindingsOptions {
  artifactId?: string;
  severity?: FindingSeverity;
}

export interface ListDependencyFindingsOptions {
  artifactId?: string;
  severity?: FindingSeverity;
  unresolvedOnly?: boolean;
}

export interface ApproveDependencyStrategyOptions {
  findingId: string;
  strategy: DependencyStrategyKind;
  targetDependency?: string | null;
  targetVersion?: string | null;
  rationale: string;
  approvedBy: string;
  agent?: string;
  model?: string;
}

function stableFindingId(namespace: string, artifactId: string, fingerprint: string): string {
  const digest = createHash("sha1")
    .update(`${namespace}|${artifactId}|${fingerprint}`)
    .digest("hex")
    .slice(0, 20);
  return `${namespace}-${digest}`;
}

function normalizeJvmFingerprint(input: JvmAuditFindingInput): string {
  return [
    input.tool,
    input.category,
    input.severity,
    input.symbol ?? "",
    input.summary,
  ].join("|");
}

function normalizeDependencyFingerprint(input: DependencyFindingInput): string {
  return [
    input.dependency_name,
    input.current_version ?? "",
    input.target_hint ?? "",
    input.category,
    input.severity,
    input.summary,
  ].join("|");
}

export function replaceJvmAuditFindings(
  db: Database.Database,
  artifactId: string,
  findings: JvmAuditFindingInput[],
): JvmAuditFinding[] {
  validateId(artifactId);
  const tx = db.transaction(() => {
    if (!db.prepare("SELECT id FROM artifacts WHERE id = ?").get(artifactId)) {
      throw new RegistryError(2, `Artifact not found: "${artifactId}"`);
    }

    const keepIds = new Set<string>();
    for (const finding of findings) {
      const findingId = stableFindingId("jvm", artifactId, normalizeJvmFingerprint(finding));
      keepIds.add(findingId);
      db.prepare(`
        INSERT INTO jvm_audit_findings (
          finding_id, artifact_id, tool, category, severity, symbol, summary, evidence, remediation, detected_at
        )
        VALUES (
          @finding_id, @artifact_id, @tool, @category, @severity, @symbol, @summary, @evidence, @remediation, datetime('now')
        )
        ON CONFLICT(finding_id) DO UPDATE SET
          tool = excluded.tool,
          category = excluded.category,
          severity = excluded.severity,
          symbol = excluded.symbol,
          summary = excluded.summary,
          evidence = excluded.evidence,
          remediation = excluded.remediation,
          detected_at = datetime('now')
          -- dismissed_at / override_id are intentionally preserved across re-audits
      `).run({
        finding_id: findingId,
        artifact_id: artifactId,
        tool: finding.tool,
        category: finding.category,
        severity: finding.severity,
        symbol: finding.symbol ?? null,
        summary: finding.summary,
        evidence: finding.evidence ?? null,
        remediation: finding.remediation,
      });
    }

    const existing = db.prepare(
      "SELECT finding_id FROM jvm_audit_findings WHERE artifact_id = ?",
    ).all(artifactId) as Array<{ finding_id: string }>;
    for (const row of existing) {
      if (!keepIds.has(row.finding_id)) {
        db.prepare("DELETE FROM jvm_audit_findings WHERE finding_id = ?").run(row.finding_id);
      }
    }
  });

  tx();
  return listJvmAuditFindings(db, { artifactId });
}

export function replaceDependencyFindings(
  db: Database.Database,
  artifactId: string,
  findings: DependencyFindingInput[],
): DependencyFindingWithStrategy[] {
  validateId(artifactId);
  const tx = db.transaction(() => {
    if (!db.prepare("SELECT id FROM artifacts WHERE id = ?").get(artifactId)) {
      throw new RegistryError(2, `Artifact not found: "${artifactId}"`);
    }

    const keepIds = new Set<string>();
    for (const finding of findings) {
      const findingId = stableFindingId("dep", artifactId, normalizeDependencyFingerprint(finding));
      keepIds.add(findingId);
      db.prepare(`
        INSERT INTO dependency_findings (
          finding_id, artifact_id, dependency_name, current_version, target_hint, category, severity, summary, details, remediation, detected_at
        )
        VALUES (
          @finding_id, @artifact_id, @dependency_name, @current_version, @target_hint, @category, @severity, @summary, @details, @remediation, datetime('now')
        )
        ON CONFLICT(finding_id) DO UPDATE SET
          dependency_name = excluded.dependency_name,
          current_version = excluded.current_version,
          target_hint = excluded.target_hint,
          category = excluded.category,
          severity = excluded.severity,
          summary = excluded.summary,
          details = excluded.details,
          remediation = excluded.remediation,
          detected_at = datetime('now')
          -- dismissed_at / override_id are intentionally preserved across re-audits
      `).run({
        finding_id: findingId,
        artifact_id: artifactId,
        dependency_name: finding.dependency_name,
        current_version: finding.current_version ?? null,
        target_hint: finding.target_hint ?? null,
        category: finding.category,
        severity: finding.severity,
        summary: finding.summary,
        details: finding.details ?? null,
        remediation: finding.remediation,
      });
    }

    const existing = db.prepare(
      "SELECT finding_id FROM dependency_findings WHERE artifact_id = ?",
    ).all(artifactId) as Array<{ finding_id: string }>;
    for (const row of existing) {
      if (!keepIds.has(row.finding_id)) {
        db.prepare("DELETE FROM dependency_findings WHERE finding_id = ?").run(row.finding_id);
      }
    }
  });

  tx();
  return listDependencyFindings(db, { artifactId });
}

export function listJvmAuditFindings(
  db: Database.Database,
  opts: ListJvmAuditFindingsOptions = {},
): JvmAuditFinding[] {
  const conditions: string[] = ["1=1"];
  const params: Record<string, string> = {};
  if (opts.artifactId) {
    validateId(opts.artifactId);
    conditions.push("artifact_id = @artifact_id");
    params["artifact_id"] = opts.artifactId;
  }
  if (opts.severity) {
    conditions.push("severity = @severity");
    params["severity"] = opts.severity;
  }
  return db.prepare(`
    SELECT *
    FROM jvm_audit_findings
    WHERE ${conditions.join(" AND ")}
    ORDER BY
      CASE severity WHEN 'critical' THEN 0 ELSE 1 END,
      artifact_id ASC,
      detected_at DESC
  `).all(params) as JvmAuditFinding[];
}

export function listDependencyFindings(
  db: Database.Database,
  opts: ListDependencyFindingsOptions = {},
): DependencyFindingWithStrategy[] {
  const conditions: string[] = ["1=1"];
  const params: Record<string, string> = {};
  if (opts.artifactId) {
    validateId(opts.artifactId);
    conditions.push("f.artifact_id = @artifact_id");
    params["artifact_id"] = opts.artifactId;
  }
  if (opts.severity) {
    conditions.push("f.severity = @severity");
    params["severity"] = opts.severity;
  }
  if (opts.unresolvedOnly) {
    conditions.push("s.finding_id IS NULL");
  }

  return db.prepare(`
    SELECT
      f.*,
      s.strategy,
      s.target_dependency,
      s.target_version,
      s.rationale,
      s.approved_by,
      s.approved_at
    FROM dependency_findings f
    LEFT JOIN dependency_strategies s ON s.finding_id = f.finding_id
    WHERE ${conditions.join(" AND ")}
    ORDER BY
      CASE f.severity WHEN 'critical' THEN 0 ELSE 1 END,
      f.artifact_id ASC,
      f.dependency_name ASC
  `).all(params) as DependencyFindingWithStrategy[];
}

export function approveDependencyStrategy(
  db: Database.Database,
  opts: ApproveDependencyStrategyOptions,
): DependencyStrategyDecision {
  if (!opts.findingId) throw new RegistryError(1, "--finding-id is required.");
  if (!opts.rationale.trim()) throw new RegistryError(1, "--rationale is required.");
  if (!opts.approvedBy.trim()) throw new RegistryError(1, "--approved-by is required.");

  const finding = db.prepare(`
    SELECT artifact_id, dependency_name, current_version, target_hint
    FROM dependency_findings
    WHERE finding_id = ?
  `).get(opts.findingId) as {
    artifact_id: string;
    dependency_name: string;
    current_version: string | null;
    target_hint: string | null;
  } | undefined;
  if (!finding) {
    throw new RegistryError(2, `Dependency finding not found: "${opts.findingId}"`);
  }

  if ((opts.strategy === "upgrade" || opts.strategy === "replace") && !(opts.targetDependency ?? "").trim()) {
    throw new RegistryError(1, `Strategy "${opts.strategy}" requires --target-dependency.`);
  }

  db.prepare(`
    INSERT INTO dependency_strategies (
      finding_id, strategy, target_dependency, target_version, rationale, approved_by, approved_at, updated_at
    )
    VALUES (
      @finding_id, @strategy, @target_dependency, @target_version, @rationale, @approved_by, datetime('now'), datetime('now')
    )
    ON CONFLICT(finding_id) DO UPDATE SET
      strategy = excluded.strategy,
      target_dependency = excluded.target_dependency,
      target_version = excluded.target_version,
      rationale = excluded.rationale,
      approved_by = excluded.approved_by,
      approved_at = datetime('now'),
      updated_at = datetime('now')
  `).run({
    finding_id: opts.findingId,
    strategy: opts.strategy,
    target_dependency: opts.targetDependency?.trim() || null,
    target_version: opts.targetVersion?.trim() || null,
    rationale: opts.rationale.trim(),
    approved_by: opts.approvedBy.trim(),
  });

  db.prepare(`
    INSERT INTO events (artifact_id, type, agent, model, summary, event_data)
    VALUES (@artifact_id, 'dependency-strategy-set', @agent, @model, @summary, @event_data)
  `).run({
    artifact_id: finding.artifact_id,
    agent: opts.agent ?? "operator",
    model: opts.model ?? null,
    summary: `Dependency strategy approved for ${finding.dependency_name}: ${opts.strategy}${opts.targetDependency ? ` -> ${opts.targetDependency}` : ""}`,
    event_data: JSON.stringify({
      finding_id: opts.findingId,
      dependency_name: finding.dependency_name,
      current_version: finding.current_version,
      target_hint: finding.target_hint,
      strategy: opts.strategy,
      target_dependency: opts.targetDependency?.trim() || null,
      target_version: opts.targetVersion?.trim() || null,
      rationale: opts.rationale.trim(),
      approved_by: opts.approvedBy.trim(),
    }),
  });

  return db.prepare(`
    SELECT finding_id, strategy, target_dependency, target_version, rationale, approved_by, approved_at, updated_at
    FROM dependency_strategies
    WHERE finding_id = ?
  `).get(opts.findingId) as DependencyStrategyDecision;
}

// ─── Audit finding dismiss / reopen (no-delete acknowledge path) ──────────────

function resolveFindingTable(db: Database.Database, findingId: string): "jvm_audit_findings" | "dependency_findings" {
  if (db.prepare("SELECT 1 FROM jvm_audit_findings WHERE finding_id = ?").get(findingId)) return "jvm_audit_findings";
  if (db.prepare("SELECT 1 FROM dependency_findings WHERE finding_id = ?").get(findingId)) return "dependency_findings";
  throw new RegistryError(2, `Audit finding not found: "${findingId}"`);
}

export interface DismissFindingOptions {
  findingId: string;
  reason: string;
  dismissedBy?: string;
}

export function dismissFinding(db: Database.Database, opts: DismissFindingOptions): AuditOverride {
  if (!opts.reason.trim()) throw new RegistryError(1, "--reason is required to dismiss a finding.");
  const table = resolveFindingTable(db, opts.findingId);
  const overrideId = `ovr-${createHash("sha1").update(`${opts.findingId}|${Date.now()}|${Math.random()}`).digest("hex").slice(0, 16)}`;

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO audit_overrides (override_id, finding_id, finding_table, action, reason, dismissed_by, created_at)
      VALUES (@override_id, @finding_id, @finding_table, 'dismiss', @reason, @dismissed_by, datetime('now'))
    `).run({
      override_id: overrideId,
      finding_id: opts.findingId,
      finding_table: table,
      reason: opts.reason.trim(),
      dismissed_by: (opts.dismissedBy ?? "operator").trim(),
    });
    db.prepare(`
      UPDATE ${table} SET dismissed_at = datetime('now'), override_id = @override_id WHERE finding_id = @finding_id
    `).run({ override_id: overrideId, finding_id: opts.findingId });
  });
  tx();

  return db.prepare("SELECT * FROM audit_overrides WHERE override_id = ?").get(overrideId) as AuditOverride;
}

export function reopenFinding(db: Database.Database, findingId: string): AuditOverride {
  const table = resolveFindingTable(db, findingId);
  const overrideId = `ovr-${createHash("sha1").update(`${findingId}|${Date.now()}|${Math.random()}`).digest("hex").slice(0, 16)}`;

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO audit_overrides (override_id, finding_id, finding_table, action, reason, dismissed_by, created_at)
      VALUES (@override_id, @finding_id, @finding_table, 'reopen', 'Reopened via CLI', 'operator', datetime('now'))
    `).run({
      override_id: overrideId,
      finding_id: findingId,
      finding_table: table,
    });
    db.prepare(`
      UPDATE ${table} SET dismissed_at = NULL, override_id = NULL WHERE finding_id = @finding_id
    `).run({ finding_id: findingId });
  });
  tx();

  return db.prepare("SELECT * FROM audit_overrides WHERE override_id = ?").get(overrideId) as AuditOverride;
}

export function listAuditOverrides(
  db: Database.Database,
  opts: { findingId?: string; action?: "dismiss" | "reopen" } = {},
): AuditOverride[] {
  const conditions = ["1=1"];
  const params: Record<string, string> = {};
  if (opts.findingId) {
    conditions.push("finding_id = @finding_id");
    params["finding_id"] = opts.findingId;
  }
  if (opts.action) {
    conditions.push("action = @action");
    params["action"] = opts.action;
  }
  return db.prepare(`
    SELECT * FROM audit_overrides
    WHERE ${conditions.join(" AND ")}
    ORDER BY created_at DESC, finding_id ASC
  `).all(params) as AuditOverride[];
}
