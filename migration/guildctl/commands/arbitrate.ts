import type Database from "better-sqlite3";
import {
  approveArtifactWithEvidence,
  rejectArtifactWithEvidence,
} from "../../registry/commands/evidence";
import { createRunOperatorCredential } from "../../registry/commands/claim";
import { startRun } from "../../registry/commands/runs";
import { RegistryError } from "../../registry/types";

export interface ArbitrateCliOptions {
  artifact: string;
  approve?: boolean;
  reject?: boolean;
  arbiter: string;
  reason: string;
  evidence?: string[];
  json?: boolean;
  /** Existing run the evidence was produced under (approve path). */
  runId?: string;
  /** Operator credential for --run-id (approve path). */
  operatorToken?: string;
}

function normalizeEvidenceIds(value: string[] | undefined): string[] | undefined {
  if (!value || value.length === 0) return undefined;
  return value.flatMap((item) => item.split(",")).map((item) => item.trim()).filter(Boolean);
}

export async function runArbitrate(db: Database.Database, opts: ArbitrateCliOptions): Promise<void> {
  if (opts.approve === opts.reject) {
    throw new Error("Choose exactly one of --approve or --reject");
  }
  const evidenceIds = normalizeEvidenceIds(opts.evidence);

  // US1 (#153): manual arbitration outside an `auto` run. When the operator
  // supplies both --run-id and --operator-token they are used directly. When
  // neither is supplied, mint an ad-hoc run + operator credential scoped to
  // this one invocation so the registry's run-binding precondition is met —
  // the same createRunOperatorCredential the supervisor loop already uses.
  // The evidence's authenticity HMAC still binds it to the run that produced
  // it, so a fully-manual approve against evidence signed by a different run
  // fails with the registry's own clean "valid run operator credential"
  // message; supplying --run-id/--operator-token for the evidence's run is
  // the supported path for that case. Only the approve path uses a run
  // credential at all, so --reject never mints one — an unused run/operator
  // row would otherwise be left behind on every manual reject.
  let runId = opts.runId;
  let operatorToken = opts.operatorToken;
  if (opts.approve && !runId && !operatorToken) {
    const run = startRun(db, {
      agent: "guildctl-arbitrate",
      ownerId: "guildctl-arbitrate",
      phase: "arbitration",
      prompt: `arbitrate ${opts.artifact}`,
    });
    const credential = createRunOperatorCredential(db, run.run_id);
    runId = run.run_id;
    operatorToken = credential.token;
  }

  try {
    const decision = opts.approve
      ? approveArtifactWithEvidence(db, {
          artifactId: opts.artifact,
          arbiter: opts.arbiter,
          reason: opts.reason,
          evidenceIds,
          runId,
          operatorToken,
        })
      : rejectArtifactWithEvidence(db, {
          artifactId: opts.artifact,
          arbiter: opts.arbiter,
          reason: opts.reason,
          evidenceIds,
        });

    // T008: re-read the artifact's actual status after the verdict. The
    // registry now holds an above-cutoff high-risk artifact at
    // pending-approval instead of promoting it straight to reviewed, so the
    // CLI must report what actually happened rather than infer from the
    // verdict alone.
    const statusRow = db
      .prepare("SELECT status FROM artifacts WHERE id = ?")
      .get(opts.artifact) as { status: string } | undefined;
    const artifactStatus = statusRow?.status ?? (decision.decision === "approved" ? "reviewed" : "needs-rework");
    const heldForApproval = decision.decision === "approved" && artifactStatus === "pending-approval";

    if (opts.json) {
      // T008 (spec 013, FR-005/FR-008): keep emitting the ArbitrationDecision
      // object verbatim (artifact_id, arbiter, decision, reason, evidence_ids,
      // decided_at, ...) and ADD two fields so a CLI consumer can tell a gated
      // artifact (held at pending-approval) from a promoted one (reviewed)
      // without a second query:
      //   artifactStatus    — the artifact's actual status after the verdict
      //   heldForApproval   — true iff the verdict held it at pending-approval
      // Nothing is removed or renamed; the shape is purely additive.
      process.stdout.write(JSON.stringify({ ...decision, artifactStatus, heldForApproval }, null, 2) + "\n");
      return;
    }
    // Non-JSON summary uses the artifact's ACTUAL post-verdict status, not a
    // value inferred from the verdict: an approving verdict on an above-cutoff
    // high-risk artifact now holds at pending-approval rather than reviewed.
    process.stdout.write(
      `✓ Artifact ${decision.decision}: ${opts.artifact}\n  decision=${decision.decision_id} target_status=${artifactStatus}\n`,
    );
    if (heldForApproval) {
      process.stdout.write("  held for human approval (high-risk)\n");
    }
  } catch (error) {
    // US1 (#153) / T005: a RegistryError (missing credential, stale evidence,
    // independence violation, non-migrated status) is an expected operator
    // error. The CLI action handler (T006) is the boundary that converts it to
    // a single clean stderr line + non-zero exit; rethrowing here preserves
    // the library-level contract for other callers.
    throw error;
  }
}
