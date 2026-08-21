import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { resolveRiskSpec } from "../../guildctl/risk";
import { RegistryError, validateId } from "../types";
import { setArtifactStatus } from "./artifacts";
import { appendEvent } from "./events";
import { checkEvidenceFreshness, getLatestArbitrationDecision } from "./evidence";

export interface GateScopeResult {
  inScope: boolean;
  reason: string;
}

export interface RecordApprovalDecisionOptions {
  artifactId: string;
  operator: string;
  decision: "approved" | "rejected";
  reason?: string;
  runId?: string;
  operatorToken?: string;
}

/**
 * The human approval decision released out of pending-approval (spec 013,
 * contracts/registry-commands.md). Field names mirror the approval_decisions
 * column set in registry_schema.sql, exposed in camelCase like the rest of the
 * registry command layer's public types.
 */
export interface ApprovalDecision {
  decisionId: string;
  artifactId: string;
  runId: string | null;
  operator: string;
  decision: "approved" | "rejected";
  reason: string | null;
  operatorTokenHash: string | null;
  decidedAt: string;
}

/**
 * One artifact currently held at pending-approval, projected for
 * `guildctl approve --list` (and the deferred Mission Control panel) — the
 * read side of the human decision path (spec 013, contracts/registry-commands.md
 * §listPendingApprovals). Pure read shape: one JOIN across artifacts,
 * artifact_risk_assessments, and the artifact's latest arbitration_decisions
 * row.
 */
export interface PendingApproval {
  artifactId: string;
  /** Parsed artifact_risk_assessments.reason_codes_json ([] when missing/malformed). */
  riskReasonCodes: string[];
  /** The reason on the artifact's most recent arbitration_decisions row. */
  arbitrationVerdictSummary: string;
  /** artifacts.updated_at — bumped by the pending-approval status transition. */
  enteredPendingApprovalAt: string;
}

interface ApprovalDecisionRow {
  decision_id: string;
  artifact_id: string;
  run_id: string | null;
  operator: string;
  decision: "approved" | "rejected";
  reason: string | null;
  operator_token_hash: string | null;
  decided_at: string;
}

interface RiskAssessmentRow {
  risk_score: number | null;
  high_risk: number | null;
}

interface PendingApprovalRow {
  artifact_id: string;
  reason_codes_json: string | null;
  arbitration_reason: string | null;
  entered_pending_approval_at: string;
}

function toPendingApproval(row: PendingApprovalRow): PendingApproval {
  let riskReasonCodes: string[] = [];
  if (row.reason_codes_json) {
    try {
      const parsed: unknown = JSON.parse(row.reason_codes_json);
      if (Array.isArray(parsed)) {
        riskReasonCodes = parsed.filter((code): code is string => typeof code === "string");
      }
    } catch {
      // Tolerate a malformed stored payload — the list view degrades to [].
    }
  }
  return {
    artifactId: row.artifact_id,
    riskReasonCodes,
    arbitrationVerdictSummary: row.arbitration_reason ?? "",
    enteredPendingApprovalAt: row.entered_pending_approval_at,
  };
}

function toApprovalDecision(row: ApprovalDecisionRow): ApprovalDecision {
  return {
    decisionId: row.decision_id,
    artifactId: row.artifact_id,
    runId: row.run_id,
    operator: row.operator,
    decision: row.decision,
    reason: row.reason,
    operatorTokenHash: row.operator_token_hash,
    decidedAt: row.decided_at,
  };
}

function getRiskAssessment(
  db: Database.Database,
  artifactId: string,
): RiskAssessmentRow | null {
  const row = db.prepare(
    `SELECT risk_score, high_risk
     FROM artifact_risk_assessments
     WHERE artifact_id = ?`,
  ).get(artifactId) as RiskAssessmentRow | undefined;
  return row ?? null;
}

function getArtifactStatus(
  db: Database.Database,
  artifactId: string,
): string | null {
  const row = db.prepare("SELECT status FROM artifacts WHERE id = ?").get(artifactId) as
    | { status: string }
    | undefined;
  return row?.status ?? null;
}

/**
 * Resolve whether an artifact is in scope for the human approval gate
 * (spec 013, FR-001/FR-002/FR-011). The `artifact_risk_assessments.high_risk`
 * flag is already computed against the stack pack's high-risk cutoff at
 * inventory time (guildctl/risk.ts scoreArtifact), so the gate scope is a pure
 * read of that stored flag; the cutoff is re-derived here only for the
 * human-readable reason string. Pure read, no side effects.
 */
export function resolveGateScope(
  db: Database.Database,
  artifactId: string,
): GateScopeResult {
  validateId(artifactId);
  const cutoff = resolveRiskSpec(undefined).highRiskScoreCutoff;
  const assessment = getRiskAssessment(db, artifactId);
  if (!assessment) {
    return { inScope: false, reason: "no risk assessment recorded; below cutoff" };
  }
  if (Number(assessment.high_risk) === 1) {
    return {
      inScope: true,
      reason: `risk_score ${assessment.risk_score} exceeds cutoff ${cutoff}`,
    };
  }
  return {
    inScope: false,
    reason: `risk_score ${assessment.risk_score} below cutoff ${cutoff}`,
  };
}

/**
 * List every artifact currently held at pending-approval with the context an
 * operator needs to decide (spec 013, contracts/registry-commands.md
 * §listPendingApprovals). One pure read: a JOIN across artifacts,
 * artifact_risk_assessments, and the artifact's most recent
 * arbitration_decisions row (its `reason` becomes the verdict summary —
 * mirrors getLatestArbitrationDecision's decided_at/rowid ordering).
 * `enteredPendingApprovalAt` is artifacts.updated_at, which setArtifactStatus
 * bumps at the pending-approval transition. Backs both `guildctl approve
 * --list` and the deferred Mission Control panel — one query, two renderers.
 */
export function listPendingApprovals(db: Database.Database): PendingApproval[] {
  const rows = db.prepare(
    `SELECT
       a.id                AS artifact_id,
       ra.reason_codes_json AS reason_codes_json,
       latest.reason       AS arbitration_reason,
       a.updated_at        AS entered_pending_approval_at
     FROM artifacts a
     LEFT JOIN artifact_risk_assessments ra
       ON ra.artifact_id = a.id
     LEFT JOIN arbitration_decisions latest
       ON latest.artifact_id = a.id
      AND latest.rowid = (
        SELECT ad2.rowid
        FROM arbitration_decisions ad2
        WHERE ad2.artifact_id = a.id
        ORDER BY ad2.decided_at DESC, ad2.rowid DESC
        LIMIT 1
      )
     WHERE a.status = 'pending-approval'
     ORDER BY a.updated_at, a.id`,
  ).all() as PendingApprovalRow[];
  return rows.map(toPendingApproval);
}

/**
 * Record the human approval/rejection that releases an artifact out of
 * pending-approval (spec 013, FR-003/FR-006/FR-007/FR-008). Preconditions each
 * throw RegistryError matching the existing approveArtifactWithEvidence shape:
 * the artifact must be awaiting approval, the approving arbiter must not double
 * as the human operator, evidence freshness (FR-006) must hold, and a
 * rejection must carry a reason. Effect lands in one transaction: one
 * approval_decisions row, a status transition to reviewed/needs-rework, and an
 * approval-approved / approval-rejected event.
 */
export function recordApprovalDecision(
  db: Database.Database,
  opts: RecordApprovalDecisionOptions,
): ApprovalDecision {
  const tx = db.transaction((): ApprovalDecision => {
    validateId(opts.artifactId);
    const status = getArtifactStatus(db, opts.artifactId);
    if (!status) {
      throw new RegistryError(2, `Artifact not found: "${opts.artifactId}"`);
    }
    if (status !== "pending-approval") {
      throw new RegistryError(1, "Artifact is not awaiting approval.");
    }

    const latestArbitration = getLatestArbitrationDecision(db, opts.artifactId);
    if (latestArbitration && latestArbitration.arbiter === opts.operator) {
      throw new RegistryError(1, "Approving arbiter cannot record the human decision.");
    }

    const freshness = checkEvidenceFreshness(db, opts.artifactId);
    if (!freshness.ok) {
      throw new RegistryError(1, freshness.reason);
    }

    if (opts.decision === "rejected" && (!opts.reason || !opts.reason.trim())) {
      throw new RegistryError(1, "A rejection reason is required.");
    }

    const operatorTokenHash = opts.operatorToken
      ? createHash("sha256").update(opts.operatorToken).digest("hex")
      : null;

    const result = db.prepare(
      `INSERT INTO approval_decisions (
         artifact_id,
         run_id,
         operator,
         decision,
         reason,
         operator_token_hash
       ) VALUES (
         @artifact_id,
         @run_id,
         @operator,
         @decision,
         @reason,
         @operator_token_hash
       )`,
    ).run({
      artifact_id: opts.artifactId,
      run_id: opts.runId ?? null,
      operator: opts.operator,
      decision: opts.decision,
      reason: opts.reason ?? null,
      operator_token_hash: operatorTokenHash,
    });

    const row = db.prepare(
      "SELECT * FROM approval_decisions WHERE rowid = ?",
    ).get(result.lastInsertRowid) as ApprovalDecisionRow;

    const targetStatus = opts.decision === "approved" ? "reviewed" : "needs-rework";
    setArtifactStatus(db, opts.artifactId, targetStatus);
    appendEvent(db, {
      id: opts.artifactId,
      type: opts.decision === "approved" ? "approval-approved" : "approval-rejected",
      agent: opts.operator,
      summary: `Operator ${opts.decision} artifact${opts.reason ? `: ${opts.reason}` : ""}`,
      data: JSON.stringify({
        role: "operator",
        decision_id: row.decision_id,
        run_id: opts.runId ?? null,
        target_status: targetStatus,
      }),
    });

    return toApprovalDecision(row);
  });

  return tx();
}
