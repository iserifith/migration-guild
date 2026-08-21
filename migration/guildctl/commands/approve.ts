import type Database from "better-sqlite3";
import {
  listPendingApprovals,
  recordApprovalDecision,
} from "../../registry/commands/approval";
import { createRunOperatorCredential } from "../../registry/commands/claim";
import { startRun } from "../../registry/commands/runs";
import { RegistryError } from "../../registry/types";

export interface ApproveCliOptions {
  artifact?: string;
  list?: boolean;
  reject?: boolean;
  reason?: string;
  runId?: string;
  operatorToken?: string;
  json?: boolean;
}

const OPERATOR_ID = "guildctl-approve";

/**
 * US2 (spec 013, contracts/registry-commands.md §CLI contract: guildctl
 * approve): the human decision path out of pending-approval. FR-004 — this
 * file holds no business logic and no SQL; --list delegates to
 * listPendingApprovals and the decision path delegates to
 * recordApprovalDecision, so the CLI and the deferred UI consume the identical
 * registry-layer functions.
 */
export async function runApprove(db: Database.Database, opts: ApproveCliOptions): Promise<void> {
  if (opts.list) {
    const pending = listPendingApprovals(db);
    if (opts.json) {
      process.stdout.write(JSON.stringify(pending, null, 2) + "\n");
      return;
    }
    if (pending.length === 0) {
      process.stdout.write("No artifacts awaiting approval.\n");
      return;
    }
    process.stdout.write("Artifacts awaiting approval:\n");
    for (const item of pending) {
      process.stdout.write(
        `  ${item.artifactId}\n` +
          `    risk_reason_codes=${item.riskReasonCodes.length ? item.riskReasonCodes.join(",") : "-"}\n` +
          `    arbitration_verdict=${item.arbitrationVerdictSummary || "-"}\n` +
          `    entered_pending_approval_at=${item.enteredPendingApprovalAt}\n`,
      );
    }
    return;
  }

  if (!opts.artifact) {
    throw new RegistryError(2, "Artifact id is required unless --list is given.");
  }
  const decisionKind = opts.reject ? "rejected" : "approved";
  if (decisionKind === "rejected" && (!opts.reason || !opts.reason.trim())) {
    // Enforce before calling, with the registry's own message, so the cli.ts
    // boundary prints one clean stderr line and exits non-zero.
    throw new RegistryError(1, "A rejection reason is required.");
  }

  // Mirror arbitrate.ts's manual-approve precedent (US1, #153): when the
  // operator supplies both --run-id and --operator-token they are passed
  // through; when neither is supplied, mint an ad-hoc run + operator
  // credential scoped to this one invocation so recordApprovalDecision's
  // run-binding context is recorded. The human decision is recorded under the
  // stable "guildctl-approve" operator id regardless — the credential binds
  // the decision to the run it was taken under, never to an operator identity.
  let runId = opts.runId;
  let operatorToken = opts.operatorToken;
  if (Boolean(runId) !== Boolean(operatorToken)) {
    throw new RegistryError(2, "--run-id and --operator-token must be supplied together, or neither.");
  }
  if (!runId && !operatorToken) {
    const run = startRun(db, {
      agent: OPERATOR_ID,
      ownerId: OPERATOR_ID,
      phase: "approval",
      prompt: `approve ${opts.artifact}`,
    });
    const credential = createRunOperatorCredential(db, run.run_id);
    runId = run.run_id;
    operatorToken = credential.token;
  }

  const decision = recordApprovalDecision(db, {
    artifactId: opts.artifact,
    operator: OPERATOR_ID,
    decision: decisionKind,
    reason: opts.reason,
    runId,
    operatorToken,
  });

  if (opts.json) {
    process.stdout.write(JSON.stringify(decision, null, 2) + "\n");
    return;
  }
  const target = decision.decision === "approved" ? "reviewed" : "needs-rework";
  process.stdout.write(
    `✓ Artifact ${decision.decision}: ${opts.artifact}\n  decision=${decision.decisionId} target_status=${target}\n`,
  );
}
