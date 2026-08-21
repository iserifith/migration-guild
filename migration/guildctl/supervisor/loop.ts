import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { appendEvent } from "../../registry/commands/events";
import { claimArtifactById, createRunOperatorCredential, releaseClaimsForRun } from "../../registry/commands/claim";
import { setArtifactStatus } from "../../registry/commands/artifacts";
import { addAcceptanceEvidence, approveArtifactWithEvidence, checkEvidenceFreshness, rejectArtifactWithEvidence } from "../../registry/commands/evidence";
import { finishRun, startRun } from "../../registry/commands/runs";
import type { AcceptanceEvidence, ClaimedArtifact, FilesWrittenSource, OutcomeLabel } from "../../registry/types";
import { deriveOutcomeLabel } from "../runner";
import { isPathInside } from "../config";
import { AutonomousLimitError } from "../limits";
import { contentSha256, diffSignatures, signatureDigest, type DeltaKind, type SignatureDelta } from "../signature";
import { formatVerificationCloseOut, runVerify, verifyAtClaimClose, type VerifyResult } from "../verify";
import { resolveGuildConfig } from "../config";
import { activeSqliteWardenExclusions, enforceWardenSnapshot, snapshotWorkspaceForWardenWithExclusions, transientWardenExclusions, wardenSnapshotDiff, type WardenSnapshot } from "../warden";
import { classifyFailure, FailureBudget } from "./failures";
import { getPersistedBudgetState, recordAttemptOutcome } from "../../registry/commands/attempts";

export interface AutoWorkerInput {
  phase: "migrate" | "repair";
  claim: ClaimedArtifact;
  runId: string;
  producerAgent: string;
  producerModel?: string;
  reviewReason?: string;
}

export interface AutoReviewInput {
  artifactId: string;
  runId: string;
  evidence: AcceptanceEvidence[];
  producerAgent: string;
  producerModel?: string;
}

export interface AutoReviewDecision {
  approved: boolean;
  reason: string;
  reviewerAgent: string;
  reviewerModel: string;
}

export interface AutoOptions {
  artifactId: string;
  workspaceRoot: string;
  commands: string[];
  outputDir?: string;
  maxAttempts?: number;
  producerModel?: string;
  worker?: (input: AutoWorkerInput) => Promise<void>;
  /**
   * Receives the loop's own run-bound operator credential so an injected
   * verifier can sign evidence under the same run the loop later uses to
   * approve the artifact — evidence signed under a different run/token can
   * never pass `assertApprovalEvidenceIsIndependent`'s authenticity check.
   */
  verify?: (ctx: { runId: string; operatorToken: string }) => Promise<Pick<VerifyResult, "pass" | "evidence">>;
  review?: (input: AutoReviewInput) => Promise<AutoReviewDecision>;
  resume?: boolean;
}

export interface AutoResult {
  // US1 (spec 013, T009): "held" is the awaiting-a-human-decision outcome for a
  // `pending-approval` artifact — distinct from blocked/failed/complete.
  status: "complete" | "blocked" | "cancelled" | "held";
  runId: string | null;
  attempts: number;
  // Additive held-for-approval marker, present (true) only when status === "held".
  heldForApproval?: boolean;
  reason?: string;
}

async function defaultWorker(): Promise<void> {
  throw new Error("guildctl auto requires a worker implementation in this build path");
}

/**
 * US2 (#154) / T009: the event type a remediation pass appends to declare "no
 * defect was found — do not re-loop verify/repair for this cause." When this
 * signal is present for an artifact, the supervisor treats the artifact as
 * terminal (operator-visible) instead of dispatching another verify attempt.
 */
export const REMEDIATION_CONFIRMED_NO_DEFECT = "remediation-confirmed-no-defect" as const;

/**
 * True when a `remediation-confirmed-no-defect` event exists for the artifact —
 * the supervisor's cue to stop the blocked-verify re-loop and surface the
 * artifact to the operator instead of re-running verify.
 */
export function hasRemediationConfirmedNoDefect(db: Database.Database, artifactId: string): boolean {
  const row = db
    .prepare("SELECT 1 AS x FROM events WHERE artifact_id = ? AND type = ? LIMIT 1")
    .get(artifactId, REMEDIATION_CONFIRMED_NO_DEFECT) as { x: number } | undefined;
  return row != null;
}

export const highRiskDriftKinds: ReadonlySet<DeltaKind> = new Set([
  "private-constructor-added",
  "field-became-final",
  "public-method-removed",
  "visibility-narrowed",
]);

export interface DriftGateResult {
  ok: boolean;
  primaryContentSha256: string | null;
  signatureJson: string | null;
  highRisk: boolean;
  deltas: SignatureDelta[];
  methodAddedInfo: SignatureDelta[];
}

export interface DriftGateInput {
  workspaceRoot: string;
  legacyArtifactId: string;
  legacyPath: string;
  expectedOutputPaths: string[];
  db: Database.Database;
  runId?: string;
}

export function computeDriftGate(input: DriftGateInput): DriftGateResult {
  const legacyPath = path.join(input.workspaceRoot, input.legacyPath);
  if (!isPathInside(legacyPath, input.workspaceRoot) || !fs.existsSync(legacyPath)) {
    return { ok: false, primaryContentSha256: null, signatureJson: null, highRisk: false, deltas: [], methodAddedInfo: [] };
  }

  const primaryOutputPath = input.expectedOutputPaths[0];
  const modernPath = primaryOutputPath ? path.join(input.workspaceRoot, primaryOutputPath) : "";
  if (!primaryOutputPath || !isPathInside(modernPath, input.workspaceRoot) || !fs.existsSync(modernPath)) {
    return { ok: false, primaryContentSha256: null, signatureJson: null, highRisk: false, deltas: [], methodAddedInfo: [] };
  }
  const legacyBytes = fs.readFileSync(legacyPath);
  const modernBytes = fs.readFileSync(modernPath);
  const legacyDigest = signatureDigest(legacyBytes.toString("utf8"), "java");
  const modernDigest = signatureDigest(modernBytes.toString("utf8"), "java");
  const diff = diffSignatures(legacyDigest, modernDigest);

  const highRiskDeltas = diff.deltas.filter((d) => highRiskDriftKinds.has(d.kind));
  const methodAdded = diff.deltas.filter((d) => d.kind === "method-added");

  if (highRiskDeltas.length > 0) {
    const detail = highRiskDeltas.map((d) => d.detail).join("; ");
    appendEvent(input.db, {
      id: input.legacyArtifactId,
      type: "blocked",
      agent: "guildctl-drift-gate",
      summary: `High-risk drift detected: ${detail}`,
      data: JSON.stringify({ high_risk_deltas: highRiskDeltas, deltas: diff.deltas }),
    });
    return {
      ok: false,
      primaryContentSha256: contentSha256(modernBytes),
      signatureJson: JSON.stringify(diff),
      highRisk: true,
      deltas: diff.deltas,
      methodAddedInfo: methodAdded,
    };
  }

  for (const outputPath of input.expectedOutputPaths) {
    if (!outputPath) continue;
    const absPath = path.join(input.workspaceRoot, outputPath);
    if (!isPathInside(absPath, input.workspaceRoot)) {
      appendEvent(input.db, {
        id: input.legacyArtifactId,
        type: "blocked",
        agent: "guildctl-drift-gate",
        summary: `Expected output path escapes workspace: ${outputPath}`,
        data: JSON.stringify({ outputPath }),
      });
      return {
        ok: false,
        primaryContentSha256: null,
        signatureJson: null,
        highRisk: false,
        deltas: diff.deltas,
        methodAddedInfo: methodAdded,
      };
    }
    if (!fs.existsSync(absPath)) {
      appendEvent(input.db, {
        id: input.legacyArtifactId,
        type: "auto-rework",
        agent: "guildctl-drift-gate",
        summary: `Expected output not found: ${outputPath}`,
        data: JSON.stringify({ outputPath }),
      });
    }
  }

  const primaryContentSha256 = contentSha256(modernBytes);
  const signatureJson = JSON.stringify(diff);
  addAcceptanceEvidence(input.db, {
    artifactId: input.legacyArtifactId,
    runId: input.runId ?? null,
    producedBy: "guildctl-drift-gate",
    evidenceType: "static-check",
    pass: 1,
    summary: `API drift gate passed with ${diff.deltas.length} delta(s)`,
    outputPath: modernPath,
    contentSha256: primaryContentSha256,
    signatureJson,
  });

  return {
    ok: true,
    primaryContentSha256,
    signatureJson,
    highRisk: false,
    deltas: diff.deltas,
    methodAddedInfo: methodAdded,
  };
}

function parseAllowedPaths(claim: ClaimedArtifact): string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(claim.expected_output_paths ?? "[]");
  } catch {
    raw = [];
  }
  if (!Array.isArray(raw)) {
    throw new Error(`Claim ${claim.claim_id} has invalid expected_output_paths`);
  }
  const paths = raw.map(String).map((item) => item.replace(/\\/g, "/").trim()).filter(Boolean);
  if (paths.length === 0) {
    throw new Error(`Claim ${claim.claim_id} has no expected output paths; refusing autonomous live migration`);
  }
  for (const item of paths) {
    if (path.isAbsolute(item) || item.split("/").includes("..")) {
      throw new Error(`Claim ${claim.claim_id} has unsafe expected output path: ${item}`);
    }
  }
  return paths;
}

function latestRuntimeEvidence(db: Database.Database, artifactId: string): AcceptanceEvidence | null {
  return db.prepare(`
    SELECT *
    FROM acceptance_evidence
    WHERE artifact_id = ?
      AND evidence_type = 'runtime'
    ORDER BY created_at DESC, rowid DESC
    LIMIT 1
  `).get(artifactId) as AcceptanceEvidence | undefined ?? null;
}

function requireReview(
  review: AutoOptions["review"] | undefined,
): NonNullable<AutoOptions["review"]> {
  if (!review) {
    throw new Error("guildctl auto requires an explicit independent review callback before approval");
  }
  return review;
}

function assertIndependentReview(decision: AutoReviewDecision, producerAgent: string, producerModel?: string): void {
  if (!decision.reason?.trim()) {
    throw new Error("independent review returned an empty reason");
  }
  if (!decision.reviewerAgent?.trim() || !decision.reviewerModel?.trim()) {
    throw new Error("independent review must identify reviewer agent and model");
  }
  if (decision.reviewerAgent === producerAgent) {
    throw new Error(`independent review agent must differ from producer agent ${producerAgent}`);
  }
  if (producerModel && decision.reviewerModel === producerModel) {
    throw new Error(`independent review model must differ from producer model ${producerModel}`);
  }
}

async function runIndependentReview(
  review: NonNullable<AutoOptions["review"]>,
  input: AutoReviewInput,
): Promise<AutoReviewDecision> {
  const decision = await review(input);
  assertIndependentReview(decision, input.producerAgent, input.producerModel);
  return decision;
}

function assertAutonomousRegistryPlacement(db: Database.Database, workspaceRoot: string): void {
  if (db.name === ":memory:") return;
  if (isPathInside(db.name, workspaceRoot)) {
    throw new Error(`Autonomous runs require REGISTRY_DB outside the target workspace: ${db.name}`);
  }
}

function scheduleReviewRejectionRepair(
  db: Database.Database,
  opts: AutoOptions,
  budget: FailureBudget,
  reviewed: AutoReviewDecision,
  attempts: number,
  maxAttempts: number,
): boolean {
  const failure = classifyFailure({
    phase: "review",
    stderr: `review rejected: ${reviewed.reason}`,
  });
  if (attempts >= maxAttempts || !budget.canAttemptArtifact(opts.artifactId) || !budget.canRunPlaybook(opts.artifactId, failure, "repair")) {
    return false;
  }
  budget.recordPlaybook(opts.artifactId, failure, "repair");
  appendEvent(db, {
    id: opts.artifactId,
    type: "auto-rework",
    agent: "guildctl-auto",
    summary: `Autonomous review rejected artifact; scheduling repair: ${failure.kind}`,
    data: JSON.stringify({ failure, reason: reviewed.reason, reviewer_agent: reviewed.reviewerAgent, reviewer_model: reviewed.reviewerModel }),
  });
  return true;
}

/**
 * T048: a review-spawn rejection (including a descriptor-derived limit
 * termination) is reported through `reviewError` rather than thrown, so a
 * caller can close this artifact out through its own per-artifact block
 * instead of the outer queue-halting catch — leaving independent queue work
 * runnable (spec: US4 independent test).
 */
async function guardedIndependentReview(
  db: Database.Database,
  opts: AutoOptions,
  review: NonNullable<AutoOptions["review"]>,
  input: AutoReviewInput,
  excludedPaths: string[],
): Promise<{ decision?: AutoReviewDecision; violation: boolean; reviewError?: unknown }> {
  const snapshot = snapshotWorkspaceForWardenWithExclusions(opts.workspaceRoot, excludedPaths);
  let decision: AutoReviewDecision | undefined;
  let reviewError: unknown;
  try {
    decision = await runIndependentReview(review, input);
  } catch (error) {
    reviewError = error;
  }
  const warden = enforceWardenSnapshot(db, {
    artifactId: opts.artifactId,
    workspaceRoot: opts.workspaceRoot,
    snapshot,
    allowedPaths: [],
    excludedPaths,
    agent: "guildctl-review-warden",
  });
  if (!warden.clean) {
    appendEvent(db, {
      id: opts.artifactId,
      type: "blocked",
      agent: "guildctl-auto",
      summary: "Blocked after independent reviewer modified verified workspace bytes",
      data: JSON.stringify({ violations: warden.violations }),
    });
    return { violation: true };
  }
  // Only a descriptor-derived limit termination (AutonomousLimitError) routes
  // through the non-throwing review-error close-out. Every other reviewer
  // failure — a malformed marker, an identity-assertion failure, a plain
  // invocation error — keeps failing closed by propagating out of runAuto.
  if (reviewError instanceof AutonomousLimitError) return { violation: false, reviewError };
  if (reviewError) throw reviewError;
  return { decision, violation: false };
}

/**
 * The review-error per-artifact close-out (T048): a review-spawn rejection
 * (including a descriptor-derived limit termination — T047) blocks this
 * artifact and persists the termination reason, exactly as the worker-error
 * path already does, instead of throwing out of `runAuto` and halting every
 * other artifact in the queue.
 */
function closeOutReviewError(
  db: Database.Database,
  opts: AutoOptions,
  operatorToken: string,
  runId: string,
  attempts: number,
  error: unknown,
  statusFrom: string | null = "migrated",
): AutoResult {
  const message = error instanceof Error ? error.message : String(error);
  appendEvent(db, {
    id: opts.artifactId,
    type: "blocked",
    agent: "guildctl-auto",
    summary: `Independent review failed: ${message}`,
    data: JSON.stringify({ error: message }),
  });
  setArtifactStatus(db, opts.artifactId, "blocked", {
    agent: "guildctl",
    runId,
    operatorToken,
    reason: `Independent review failed: ${message}`,
  });
  // T048/T049: same close-out shape as the worker-error path. The reviewer is
  // enforced read-only (its own warden pass runs with an empty allow-list), so
  // it never legitimately writes files; a limit-fired rejection here never
  // carries a success-equivalent label.
  const statusToRow = db.prepare("SELECT status FROM artifacts WHERE id = ?").get(opts.artifactId) as { status: string } | undefined;
  const filesWrittenSource: FilesWrittenSource = "warden-snapshot";
  const isLimitError = error instanceof AutonomousLimitError;
  const outcomeLabel: OutcomeLabel = deriveOutcomeLabel({
    exitCode: 1,
    limitKilled: isLimitError,
    statusFrom,
    statusTo: statusToRow?.status ?? statusFrom,
    filesWrittenCount: 0,
    filesWrittenSource,
    wardenClean: true,
  });
  const cleanupOutcome = isLimitError ? error.cleanupOutcome : "not-applicable";
  const survivorPids = isLimitError ? error.survivorPids : [];
  // FR-039: the claim disposition and process-cleanup outcome are printed
  // together — a released claim is never printed alone.
  process.stderr.write(
    `[guildctl] ${opts.artifactId} review attempt closed — claim: released, retryable; process cleanup: ${
      cleanupOutcome === "survivors" ? `FAILED — ${survivorPids.length} survivor(s) (pid ${survivorPids.join(", ")})` : `${cleanupOutcome} (0 survivors)`
    }; provider budget: consumed — this spend is not recovered\n`,
  );
  finishRun(db, {
    runId,
    exitCode: 1,
    reason: message,
    filesWrittenCount: 0,
    filesWrittenSource,
    // A reviewer invocation that reached this point actually launched a
    // provider request; autonomous workers do not (yet) plumb per-attempt
    // token usage the way the manual runner's usage file does, so this is
    // the honest conservative default: assume spend, never claim recovery.
    budgetConsumed: 1,
    cleanupOutcome,
    survivorPids: survivorPids.length > 0 ? survivorPids : null,
    statusFrom,
    statusTo: statusToRow?.status ?? statusFrom,
    outcomeLabel,
  });
  return { status: "blocked", runId, attempts };
}

/**
 * US1 approval gate (spec 013, T009): report what actually happened after
 * approveArtifactWithEvidence runs, not what the caller assumed. An
 * above-cutoff high-risk artifact holds at `pending-approval` instead of
 * promoting to `reviewed` (see arbitrate.ts's identical T008 re-read), so
 * runAuto must not report "complete" when the artifact got gated mid-run.
 */
function reportApprovalOutcome(
  db: Database.Database,
  artifactId: string,
  runId: string,
  attempts: number,
): AutoResult {
  const statusRow = db.prepare("SELECT status FROM artifacts WHERE id = ?").get(artifactId) as { status: string } | undefined;
  if (statusRow?.status === "pending-approval") {
    return {
      status: "held",
      runId,
      attempts,
      heldForApproval: true,
      reason: "pending-approval",
    };
  }
  return { status: "complete", runId, attempts };
}

export async function runAuto(
  db: Database.Database,
  opts: AutoOptions,
): Promise<AutoResult> {
  // US1 approval gate (spec 013, T009): a `pending-approval` artifact is HELD
  // awaiting a human decision — it is not claimable work and the supervisor
  // must never try to claim it, advance it, or treat it as a failure. Surface
  // it as held-for-approval and leave its status untouched. This short-circuits
  // before requireReview/startRun/claim so a held artifact never crashes the
  // supervisor even when no review callback or claim is involved.
  const initialStatusRow = db.prepare("SELECT status FROM artifacts WHERE id = ?").get(opts.artifactId) as { status: string } | undefined;
  if (initialStatusRow?.status === "pending-approval") {
    process.stderr.write(`held for approval: artifact ${opts.artifactId} is pending-approval; awaiting a human approval decision\n`);
    return {
      runId: null,
      attempts: 0,
      status: "held",
      heldForApproval: true,
      reason: "pending-approval",
    };
  }

  const review = requireReview(opts.review);
  assertAutonomousRegistryPlacement(db, opts.workspaceRoot);
  const wardenExcludedPaths = transientWardenExclusions(opts.workspaceRoot, [path.resolve(opts.outputDir ?? `${opts.workspaceRoot}/.guild/evidence`), ...activeSqliteWardenExclusions(db)]);
  const runId = `auto-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  startRun(db, {
    runId,
    agent: "guildctl-auto",
    ownerId: "guildctl-auto",
    phase: "auto",
    prompt: `auto ${opts.artifactId}`,
  });
  const operator = createRunOperatorCredential(db, runId);
  // Resolved once per autonomous run; a workspace without a .guild config still
  // yields defaults, so verification degrades to no-stack-check rather than
  // failing the run.
  const autoConfig = resolveGuildConfig({ cwd: opts.workspaceRoot });
  const maxAttempts = opts.maxAttempts ?? 3;
  // US3 (spec 013, FR-009): seed from durable attempt_records so a restart
  // resumes consumed attempts/playbooks instead of resetting the budget.
  const budget = new FailureBudget(maxAttempts, 2, {
    artifactId: opts.artifactId,
    ...getPersistedBudgetState(db, opts.artifactId),
  });
  // Timestamp the current attempt began; attempts[#attempts-1] is the attempt
  // currently executing (attempts is incremented before each dispatch).
  const attemptStartedAt: string[] = [];
  const worker = opts.worker ?? defaultWorker;
  // The default (--command) verifier already closes over the loop's own
  // runId/operator.token, so it ignores the ctx argument; injected verifiers
  // use it to sign evidence under that same run (see AutoOptions.verify).
  const verifier = opts.verify ?? ((): Promise<Pick<VerifyResult, "pass" | "evidence">> => runVerify(db, {
    artifactId: opts.artifactId,
    workspaceRoot: opts.workspaceRoot,
    commands: opts.commands,
    outputDir: opts.outputDir ?? `${opts.workspaceRoot}/.guild/evidence`,
    runId,
    operatorToken: operator.token,
    config: autoConfig,
  }));

  // US3 (spec 013, FR-009): seed from durable attempt_records like the
  // FailureBudget above, so a resumed run's attempt counter picks up where
  // persisted history left off instead of colliding with already-persisted
  // attempt_records rows (UNIQUE(artifact_id, attempt_no)).
  let attempts = getPersistedBudgetState(db, opts.artifactId).attemptsUsed;
  try {
    // US2 (#154) / T009: a remediation pass that appended
    // `remediation-confirmed-no-defect` for this artifact has already declared
    // the blocked-verify cause resolved-without-a-defect. The supervisor MUST
    // NOT dispatch another verify/repair loop for the same unresolved cause —
    // surface the artifact in a terminal, operator-visible state instead.
    if (hasRemediationConfirmedNoDefect(db, opts.artifactId)) {
      appendEvent(db, {
        id: opts.artifactId,
        type: "blocked",
        agent: "guildctl-auto",
        summary:
          "Remediation confirmed no defect for this artifact; the supervisor is not " +
          "re-running verify/repair. Surface for operator attention.",
      });
      finishRun(db, { runId, exitCode: 1, reason: "remediation-confirmed-no-defect: operator attention required" });
      return { status: "blocked", runId, attempts };
    }

    let fromStatus: "planned" | "migrated" = "planned";
    let phase: "migrate" | "repair" = "migrate";
    let reviewReason: string | undefined;
    if (opts.resume) {
      const latest = latestRuntimeEvidence(db, opts.artifactId);
      const artifact = db.prepare("SELECT status FROM artifacts WHERE id = ?").get(opts.artifactId) as { status: string } | undefined;
      // US3 (#155): a blocked artifact is resume-eligible. Treat it exactly
      // like a migrated-without-failing-evidence resume: re-verify, then drive
      // review/arbitration from the verifier outcome — no claim from
      // `planned`, so no raw "expected \"planned\"" RegistryError.
      if (artifact?.status === "blocked" || (artifact?.status === "migrated" && latest?.pass !== 0)) {
        const verification = await verifier({ runId, operatorToken: operator.token });
        if (!verification.pass) {
          const failureText = verification.evidence.map((item) => item.output_excerpt ?? item.summary).join("\n");
          const failure = classifyFailure({ phase: "verify", exitCode: verification.evidence[0]?.exit_code, stderr: failureText });
          appendEvent(db, {
            id: opts.artifactId,
            type: "auto-rework",
            agent: "guildctl-auto",
            summary: `Resume re-verification failed: ${failure.kind}`,
            data: JSON.stringify({ failure }),
          });
          fromStatus = "migrated";
          phase = "repair";
        } else {
          const resumeArtifactRow = db.prepare("SELECT path FROM artifacts WHERE id = ?").get(opts.artifactId) as { path: string } | undefined;
          const resumeClaimRow = db.prepare(
            "SELECT expected_output_paths FROM artifact_claims WHERE artifact_id = ? ORDER BY rowid DESC LIMIT 1",
          ).get(opts.artifactId) as { expected_output_paths: string | null } | undefined;
          let resumeExpectedOutputs: string[] = [];
          if (resumeClaimRow?.expected_output_paths) {
            try { resumeExpectedOutputs = JSON.parse(resumeClaimRow.expected_output_paths); } catch { resumeExpectedOutputs = []; }
          }
          if (resumeArtifactRow && resumeExpectedOutputs.length > 0) {
            const driftGate = computeDriftGate({
              workspaceRoot: opts.workspaceRoot,
              legacyArtifactId: opts.artifactId,
              legacyPath: resumeArtifactRow.path,
              expectedOutputPaths: resumeExpectedOutputs,
              db,
              runId,
            });
            if (!driftGate.ok) {
              releaseClaimsForRun(db, runId, "guildctl", "resume drift gate rejection");
              setArtifactStatus(db, opts.artifactId, "blocked", {
                agent: "guildctl",
                runId,
                operatorToken: operator.token,
                reason: "High-risk signature drift detected by drift gate on resume",
              });
              finishRun(db, { runId, exitCode: 1, reason: "high-risk drift detected on resume" });
              return { status: "blocked", runId, attempts };
            }
            appendEvent(db, {
              id: opts.artifactId,
              type: "evidence-submitted",
              agent: "guildctl-drift-gate",
              summary: `Static-check acceptance evidence recorded (resume): content_sha256=${driftGate.primaryContentSha256 ? driftGate.primaryContentSha256.slice(0, 12) : "none"} deltas=${driftGate.deltas.length}`,
              data: JSON.stringify({
                content_sha256: driftGate.primaryContentSha256,
                signature_json: driftGate.signatureJson,
                method_added_info: driftGate.methodAddedInfo,
                delta_count: driftGate.deltas.length,
              }),
            });
          }

          // US3 (#155): a blocked artifact whose resume re-verification passed
          // has its blocked cause cleared by the verifier. Restore it to
          // `migrated` so independent review and arbitration operate on the
          // migrated proposal (arbitration requires `migrated`).
          if (artifact?.status === "blocked") {
            setArtifactStatus(db, opts.artifactId, "migrated", {
              agent: "guildctl-resume",
              runId,
              operatorToken: operator.token,
              reason: "Resume re-verification passed; blocked artifact restored to migrated for review",
            });
          }
          const reviewResult = await guardedIndependentReview(db, opts, review, {
            artifactId: opts.artifactId,
            runId,
            evidence: verification.evidence as AcceptanceEvidence[],
            producerAgent: "guildctl-resume",
            producerModel: opts.producerModel,
          }, wardenExcludedPaths);
          if (reviewResult.violation) {
            setArtifactStatus(db, opts.artifactId, "blocked", {
              agent: "guildctl",
              runId,
              operatorToken: operator.token,
              reason: "Independent reviewer modified verified workspace bytes",
            });
            finishRun(db, { runId, exitCode: 1, reason: "review filesystem violation" });
            return { status: "blocked", runId, attempts };
          }
          if (reviewResult.reviewError) {
            return closeOutReviewError(db, opts, operator.token, runId, attempts, reviewResult.reviewError);
          }
          const reviewed = reviewResult.decision!;
          if (reviewed.approved) {
            approveArtifactWithEvidence(db, {
              artifactId: opts.artifactId,
              arbiter: reviewed.reviewerAgent,
              reason: reviewed.reason,
              evidenceIds: verification.evidence.map((item) => item.evidence_id),
              runId,
              operatorToken: operator.token,
            });
            finishRun(db, { runId, exitCode: 0 });
            return reportApprovalOutcome(db, opts.artifactId, runId, attempts);
          }
          if (!scheduleReviewRejectionRepair(db, opts, budget, reviewed, attempts, maxAttempts)) {
            rejectArtifactWithEvidence(db, {
              artifactId: opts.artifactId,
              arbiter: reviewed.reviewerAgent,
              reason: reviewed.reason,
              evidenceIds: verification.evidence.map((item) => item.evidence_id),
            });
            finishRun(db, { runId, exitCode: 1, reason: "independent review rejected artifact" });
            return { status: "blocked", runId, attempts };
          }
          fromStatus = "migrated";
          phase = "repair";
          reviewReason = reviewed.reason;
        }
      }
      if (latest?.pass === 0) {
        fromStatus = "migrated";
        phase = "repair";
      }
    }
    const claimOwner = `guildctl-auto:${opts.artifactId}`;
    while (attempts < maxAttempts && budget.canAttemptArtifact(opts.artifactId)) {
      attempts += 1;
      budget.recordAttempt(opts.artifactId);
      attemptStartedAt[attempts - 1] = new Date().toISOString();
      const claim = claimArtifactById(db, {
        artifactId: opts.artifactId,
        agent: phase === "repair" ? "remediation-agent" : "code-writer-agent",
        ownerId: claimOwner,
        runId,
        fromStatus,
        // US3 (#155): on resume, a blocked artifact that needs a repair attempt
        // is reclaimed from `blocked` as well as the phase's own from-status.
        fromStatuses: opts.resume
          ? Array.from(new Set<typeof fromStatus | "blocked">([fromStatus, "blocked"]))
          : undefined,
      });
      const allowedPaths = parseAllowedPaths(claim);
      const snapshot = snapshotWorkspaceForWardenWithExclusions(opts.workspaceRoot, wardenExcludedPaths);
      const producerAgent = phase === "repair" ? "remediation-agent" : "code-writer-agent";
      const producerModel = opts.producerModel;
      let workerError: unknown;
      try {
        await worker({ phase, claim, runId, producerAgent, producerModel, reviewReason });
      } catch (error) {
        workerError = error;
      }
      const warden = enforceWardenSnapshot(db, {
        artifactId: opts.artifactId,
        workspaceRoot: opts.workspaceRoot,
        snapshot,
        allowedPaths,
        excludedPaths: wardenExcludedPaths,
        agent: "guildctl-warden",
        claimId: claim.claim_id,
        runId,
      });
      if (!warden.clean) {
        releaseClaimsForRun(db, runId, "guildctl", "auto blocked after filesystem violation");
        const failure = classifyFailure({ phase, stderr: `filesystem-violation ${JSON.stringify(warden.violations)}` });
        appendEvent(db, {
          id: opts.artifactId,
          type: "blocked",
          agent: "guildctl-auto",
          summary: `Blocked after filesystem violation: ${failure.signature}`,
          data: JSON.stringify({ failure, violations: warden.violations }),
        });
        recordAttemptOutcome(db, {
          artifactId: opts.artifactId,
          attemptNo: attempts,
          phase,
          outcome: "failed",
          failureKind: failure.kind,
          failureSignature: failure.signature,
          startedAt: attemptStartedAt[attempts - 1],
          runId,
        });
        setArtifactStatus(db, opts.artifactId, "blocked", {
          agent: "guildctl",
          runId,
          operatorToken: operator.token,
          reason: "Autonomous worker changed files outside claim output paths",
        });
        finishRun(db, { runId, exitCode: 1, reason: "filesystem violation" });
        return { status: "blocked", runId, attempts };
      }
      if (workerError) {
        releaseClaimsForRun(db, runId, "guildctl", `auto cleanup after failed ${phase}`);
        const message = workerError instanceof Error ? workerError.message : String(workerError);
        const failure = classifyFailure({ phase, stderr: message });
        appendEvent(db, {
          id: opts.artifactId,
          type: "blocked",
          agent: "guildctl-auto",
          summary: `Worker failed: ${failure.kind}`,
          data: JSON.stringify({ failure }),
        });
        recordAttemptOutcome(db, {
          artifactId: opts.artifactId,
          attemptNo: attempts,
          phase,
          outcome: "failed",
          failureKind: failure.kind,
          failureSignature: failure.signature,
          startedAt: attemptStartedAt[attempts - 1],
          runId,
        });
        setArtifactStatus(db, opts.artifactId, "blocked", {
          agent: "guildctl",
          runId,
          operatorToken: operator.token,
          reason: `Autonomous ${phase} worker failed: ${message}`,
        });
        // T048/T049: the worker-error close-out states files written (from the
        // same warden snapshot diff the manual runner uses), the status
        // transition, and a computed outcome_label — never a stored counter,
        // never a success-equivalent label for a limit termination.
        const afterSnapshot = snapshotWorkspaceForWardenWithExclusions(opts.workspaceRoot, wardenExcludedPaths);
        const writtenFiles = wardenSnapshotDiff(snapshot, afterSnapshot);
        const statusToRow = db.prepare("SELECT status FROM artifacts WHERE id = ?").get(opts.artifactId) as { status: string } | undefined;
        const limitKilled = workerError instanceof AutonomousLimitError;
        const outcomeLabel: OutcomeLabel = deriveOutcomeLabel({
          exitCode: 1,
          limitKilled,
          statusFrom: fromStatus,
          statusTo: statusToRow?.status ?? fromStatus,
          filesWrittenCount: writtenFiles.length,
          filesWrittenSource: "warden-snapshot",
          wardenClean: true,
        });
        const workerCleanupOutcome = limitKilled ? (workerError as InstanceType<typeof AutonomousLimitError>).cleanupOutcome : "not-applicable";
        const workerSurvivorPids = limitKilled ? (workerError as InstanceType<typeof AutonomousLimitError>).survivorPids : [];
        // FR-039: the claim disposition and process-cleanup outcome are
        // printed together — a released claim is never printed alone.
        process.stderr.write(
          `[guildctl] ${opts.artifactId} ${phase} attempt closed — claim: released, retryable; process cleanup: ${
            workerCleanupOutcome === "survivors"
              ? `FAILED — ${workerSurvivorPids.length} survivor(s) (pid ${workerSurvivorPids.join(", ")})`
              : `${workerCleanupOutcome} (0 survivors)`
          }; provider budget: consumed — this spend is not recovered\n`,
        );
        finishRun(db, {
          runId,
          exitCode: 1,
          reason: message,
          filesWrittenCount: writtenFiles.length,
          filesWrittenSource: "warden-snapshot",
          statusFrom: fromStatus,
          statusTo: statusToRow?.status ?? fromStatus,
          // See closeOutReviewError: autonomous workers do not yet plumb
          // per-attempt token usage; a worker that reached this point
          // actually ran, so the honest conservative default is "consumed".
          budgetConsumed: 1,
          cleanupOutcome: workerCleanupOutcome,
          survivorPids: workerSurvivorPids.length > 0 ? workerSurvivorPids : null,
          outcomeLabel,
        });
        return { status: "blocked", runId, attempts };
      }
      releaseClaimsForRun(db, runId, "guildctl", `auto cleanup after ${phase}`);

      // Verification at the autonomous claim close (FR-001, FR-006, FR-007),
      // through the same helper the manual runner uses. Its outcome is recorded,
      // never a gate: nothing below branches on it, so no verification result
      // can stop the artifact from advancing.
      const artifactVerification = await verifyAtClaimClose(db, {
        artifactId: opts.artifactId,
        workspaceRoot: opts.workspaceRoot,
        config: autoConfig,
        runId,
        operatorToken: operator.token,
      });
      if (artifactVerification) {
        // Stated alongside migration status, and separately from it.
        const status = (db.prepare("SELECT status FROM artifacts WHERE id = ?").get(opts.artifactId) as { status: string } | undefined)?.status ?? "unknown";
        process.stderr.write(
          `[guildctl] ${opts.artifactId} attempt closed — status: ${status}; verification: ${formatVerificationCloseOut(artifactVerification)}\n`,
        );
      }

      const verification = await verifier({ runId, operatorToken: operator.token });
      appendEvent(db, {
        id: opts.artifactId,
        type: verification.pass ? "auto-completed" : "auto-rework",
        agent: "guildctl-auto",
        summary: verification.pass
          ? "Autonomous verification passed"
          : "Autonomous verification failed; scheduling repair",
        data: JSON.stringify({ attempts, evidence_count: verification.evidence.length }),
      });
      if (verification.pass) {
        const artifactRow = db.prepare("SELECT path FROM artifacts WHERE id = ?").get(opts.artifactId) as { path: string } | undefined;
        const claimRow = db.prepare(
          "SELECT expected_output_paths FROM artifact_claims WHERE artifact_id = ? ORDER BY rowid DESC LIMIT 1",
        ).get(opts.artifactId) as { expected_output_paths: string | null } | undefined;
        let expectedOutputs: string[] = [];
        if (claimRow?.expected_output_paths) {
          try { expectedOutputs = JSON.parse(claimRow.expected_output_paths); } catch { expectedOutputs = []; }
        }
        if (artifactRow && expectedOutputs.length > 0) {
          const driftGate = computeDriftGate({
            workspaceRoot: opts.workspaceRoot,
            legacyArtifactId: opts.artifactId,
            legacyPath: artifactRow.path,
            expectedOutputPaths: expectedOutputs,
            db,
            runId,
          });
          if (!driftGate.ok) {
            releaseClaimsForRun(db, runId, "guildctl", "drift gate high-risk rejection");
            setArtifactStatus(db, opts.artifactId, "blocked", {
              agent: "guildctl",
              runId,
              operatorToken: operator.token,
              reason: "High-risk signature drift detected by drift gate",
            });
            finishRun(db, { runId, exitCode: 1, reason: "high-risk drift detected" });
            return { status: "blocked", runId, attempts };
          }
          appendEvent(db, {
            id: opts.artifactId,
            type: "evidence-submitted",
            agent: "guildctl-drift-gate",
            summary: `Static-check acceptance evidence recorded: content_sha256=${driftGate.primaryContentSha256 ? driftGate.primaryContentSha256.slice(0, 12) : "none"} deltas=${driftGate.deltas.length}`,
            data: JSON.stringify({
              content_sha256: driftGate.primaryContentSha256,
              signature_json: driftGate.signatureJson,
              method_added_info: driftGate.methodAddedInfo,
              delta_count: driftGate.deltas.length,
            }),
          });
        }

        const reviewResult = await guardedIndependentReview(db, opts, review, {
          artifactId: opts.artifactId,
          runId,
          evidence: verification.evidence as AcceptanceEvidence[],
          producerAgent,
          producerModel,
        }, wardenExcludedPaths);
        if (reviewResult.violation) {
          setArtifactStatus(db, opts.artifactId, "blocked", {
            agent: "guildctl",
            runId,
            operatorToken: operator.token,
            reason: "Independent reviewer modified verified workspace bytes",
          });
          finishRun(db, { runId, exitCode: 1, reason: "review filesystem violation" });
          return { status: "blocked", runId, attempts };
        }
        if (reviewResult.reviewError) {
          return closeOutReviewError(db, opts, operator.token, runId, attempts, reviewResult.reviewError);
        }
        const reviewed = reviewResult.decision!;
        if (!reviewed.approved) {
          const reviewFailure = classifyFailure({
            phase: "review",
            stderr: `review rejected: ${reviewed.reason}`,
          });
          // US3 (spec 013): record the rejected attempt's outcome BEFORE the
          // repair boundary. The record insert must stay ahead of the
          // helper's auto-rework event: the evidence-freshness check breaks
          // same-second auto-rework-vs-evidence ties by rowid, so this
          // ordering keeps the event strictly after both the record and the
          // next attempt's evidence.
          if (scheduleReviewRejectionRepair(db, opts, budget, reviewed, attempts, maxAttempts)) {
            recordAttemptOutcome(db, {
              artifactId: opts.artifactId,
              attemptNo: attempts,
              phase,
              outcome: "failed",
              failureKind: reviewFailure.kind,
              failureSignature: reviewFailure.signature,
              startedAt: attemptStartedAt[attempts - 1],
              runId,
            });
            fromStatus = "migrated";
            phase = "repair";
            reviewReason = reviewed.reason;
            continue;
          }
          // US3 (spec 013): no repair left for this attempt — record the
          // terminal outcome ("failed" when the attempt itself failed,
          // "budget-exhausted" when the loop's retry policy is what stopped
          // a retryable rejection).
          const exhaustedByAttemptCap = attempts >= maxAttempts || !budget.canAttemptArtifact(opts.artifactId);
          recordAttemptOutcome(db, {
            artifactId: opts.artifactId,
            attemptNo: attempts,
            phase,
            outcome: exhaustedByAttemptCap ? "budget-exhausted" : "failed",
            failureKind: reviewFailure.kind,
            failureSignature: reviewFailure.signature,
            startedAt: attemptStartedAt[attempts - 1],
            runId,
          });
          rejectArtifactWithEvidence(db, {
            artifactId: opts.artifactId,
            arbiter: reviewed.reviewerAgent,
            reason: reviewed.reason,
            evidenceIds: verification.evidence.map((item) => item.evidence_id),
          });
          finishRun(db, { runId, exitCode: 1, reason: "independent review rejected artifact" });
          return { status: "blocked", runId, attempts };
        }
        recordAttemptOutcome(db, {
          artifactId: opts.artifactId,
          attemptNo: attempts,
          phase,
          outcome: "succeeded",
          startedAt: attemptStartedAt[attempts - 1],
          runId,
        });
        approveArtifactWithEvidence(db, {
          artifactId: opts.artifactId,
          arbiter: reviewed.reviewerAgent,
          reason: reviewed.reason,
          evidenceIds: verification.evidence.map((item) => item.evidence_id),
          runId,
          operatorToken: operator.token,
        });
        finishRun(db, { runId, exitCode: 0 });
        return reportApprovalOutcome(db, opts.artifactId, runId, attempts);
      }
      const failureText = verification.evidence.map((item) => item.output_excerpt ?? item.summary).join("\n");
      const failure = classifyFailure({ phase: "verify", exitCode: verification.evidence[0]?.exit_code, stderr: failureText });
      appendEvent(db, {
        id: opts.artifactId,
        type: "blocked",
        agent: "guildctl-auto",
        summary: `Classified verification failure: ${failure.kind}`,
        data: JSON.stringify({ failure }),
      });
      if (!budget.canRunPlaybook(opts.artifactId, failure, "repair")) {
        // US3 (spec 013): the playbook retry budget for this signature is
        // exhausted — record the attempt's terminal outcome before the loop
        // falls through to the budget-exhausted close-out.
        recordAttemptOutcome(db, {
          artifactId: opts.artifactId,
          attemptNo: attempts,
          phase,
          outcome: "budget-exhausted",
          failureKind: failure.kind,
          failureSignature: failure.signature,
          startedAt: attemptStartedAt[attempts - 1],
          runId,
        });
        break;
      }
      budget.recordPlaybook(opts.artifactId, failure, "repair");
      // US3 (spec 013): repair scheduled at the playbook boundary — durably
      // record the failed attempt so budget state is re-seedable after a
      // restart.
      recordAttemptOutcome(db, {
        artifactId: opts.artifactId,
        attemptNo: attempts,
        phase,
        outcome: "failed",
        failureKind: failure.kind,
        failureSignature: failure.signature,
        startedAt: attemptStartedAt[attempts - 1],
        runId,
      });
      fromStatus = "migrated";
      phase = "repair";
      reviewReason = undefined;
    }

    releaseClaimsForRun(db, runId, "guildctl", "auto budget exhausted");
    setArtifactStatus(db, opts.artifactId, "blocked", {
      agent: "guildctl",
      runId,
      operatorToken: operator.token,
      reason: `Autonomous attempt budget exhausted after ${attempts} attempt(s)`,
    });
    finishRun(db, { runId, exitCode: 1, reason: "auto budget exhausted" });
    return { status: "blocked", runId, attempts };
  } catch (error) {
    releaseClaimsForRun(db, runId, "guildctl", "auto failed");
    finishRun(db, { runId, exitCode: 1, reason: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
