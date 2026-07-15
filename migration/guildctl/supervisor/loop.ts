import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { appendEvent } from "../../registry/commands/events";
import { claimArtifactById, createRunOperatorCredential, releaseClaimsForRun } from "../../registry/commands/claim";
import { setArtifactStatus } from "../../registry/commands/artifacts";
import { approveArtifactWithEvidence, rejectArtifactWithEvidence } from "../../registry/commands/evidence";
import { finishRun, startRun } from "../../registry/commands/runs";
import type { AcceptanceEvidence, ClaimedArtifact } from "../../registry/types";
import { isPathInside } from "../config";
import { runVerify, type VerifyResult } from "../verify";
import { activeSqliteWardenExclusions, enforceWardenSnapshot, snapshotWorkspaceForWardenWithExclusions } from "../warden";
import { classifyFailure, FailureBudget } from "./failures";

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
  verify?: () => Promise<Pick<VerifyResult, "pass" | "evidence">>;
  review?: (input: AutoReviewInput) => Promise<AutoReviewDecision>;
  resume?: boolean;
}

export interface AutoResult {
  status: "complete" | "blocked" | "cancelled";
  runId: string;
  attempts: number;
}

async function defaultWorker(): Promise<void> {
  throw new Error("guildctl auto requires a worker implementation in this build path");
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

async function guardedIndependentReview(
  db: Database.Database,
  opts: AutoOptions,
  review: NonNullable<AutoOptions["review"]>,
  input: AutoReviewInput,
  excludedPaths: string[],
): Promise<{ decision?: AutoReviewDecision; violation: boolean }> {
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
  if (reviewError) throw reviewError;
  return { decision, violation: false };
}

export async function runAuto(
  db: Database.Database,
  opts: AutoOptions,
): Promise<AutoResult> {
  const review = requireReview(opts.review);
  assertAutonomousRegistryPlacement(db, opts.workspaceRoot);
  const wardenExcludedPaths = activeSqliteWardenExclusions(db);
  const runId = `auto-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  startRun(db, {
    runId,
    agent: "guildctl-auto",
    ownerId: "guildctl-auto",
    phase: "auto",
    prompt: `auto ${opts.artifactId}`,
  });
  const operator = createRunOperatorCredential(db, runId);
  const maxAttempts = opts.maxAttempts ?? 3;
  const budget = new FailureBudget(maxAttempts, 2);
  const worker = opts.worker ?? defaultWorker;
  const verifier = opts.verify ?? (() => runVerify(db, {
    artifactId: opts.artifactId,
    workspaceRoot: opts.workspaceRoot,
    commands: opts.commands,
    outputDir: opts.outputDir ?? `${opts.workspaceRoot}/.guild/evidence`,
    runId,
    operatorToken: operator.token,
  }));

  let attempts = 0;
  try {
    let fromStatus: "planned" | "migrated" = "planned";
    let phase: "migrate" | "repair" = "migrate";
    let reviewReason: string | undefined;
    if (opts.resume) {
      const latest = latestRuntimeEvidence(db, opts.artifactId);
      if (latest?.pass === 1) {
        const verification = await verifier();
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
            return { status: "complete", runId, attempts };
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
      const claim = claimArtifactById(db, {
        artifactId: opts.artifactId,
        agent: phase === "repair" ? "remediation-agent" : "code-writer-agent",
        ownerId: claimOwner,
        runId,
        fromStatus,
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
        setArtifactStatus(db, opts.artifactId, "blocked", {
          agent: "guildctl",
          runId,
          operatorToken: operator.token,
          reason: `Autonomous ${phase} worker failed: ${message}`,
        });
        finishRun(db, { runId, exitCode: 1, reason: message });
        return { status: "blocked", runId, attempts };
      }
      releaseClaimsForRun(db, runId, "guildctl", `auto cleanup after ${phase}`);

      const verification = await verifier();
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
        const reviewed = reviewResult.decision!;
        if (!reviewed.approved) {
          if (scheduleReviewRejectionRepair(db, opts, budget, reviewed, attempts, maxAttempts)) {
            fromStatus = "migrated";
            phase = "repair";
            reviewReason = reviewed.reason;
            continue;
          }
          rejectArtifactWithEvidence(db, {
            artifactId: opts.artifactId,
            arbiter: reviewed.reviewerAgent,
            reason: reviewed.reason,
            evidenceIds: verification.evidence.map((item) => item.evidence_id),
          });
          finishRun(db, { runId, exitCode: 1, reason: "independent review rejected artifact" });
          return { status: "blocked", runId, attempts };
        }
        approveArtifactWithEvidence(db, {
          artifactId: opts.artifactId,
          arbiter: reviewed.reviewerAgent,
          reason: reviewed.reason,
          evidenceIds: verification.evidence.map((item) => item.evidence_id),
          runId,
          operatorToken: operator.token,
        });
        finishRun(db, { runId, exitCode: 0 });
        return { status: "complete", runId, attempts };
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
        break;
      }
      budget.recordPlaybook(opts.artifactId, failure, "repair");
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
