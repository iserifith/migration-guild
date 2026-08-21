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
