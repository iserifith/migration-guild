import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { appendEvent } from "../../registry/commands/events";
import { claimArtifactById, createRunOperatorCredential, releaseClaimsForRun } from "../../registry/commands/claim";
import { setArtifactStatus } from "../../registry/commands/artifacts";
import { addAcceptanceEvidence, approveArtifactWithEvidence, checkEvidenceFreshness, rejectArtifactWithEvidence } from "../../registry/commands/evidence";
import { finishRun, startRun } from "../../registry/commands/runs";
import type { AcceptanceEvidence, ClaimedArtifact } from "../../registry/types";
import { isPathInside } from "../config";
import { contentSha256, diffSignatures, signatureDigest, type DeltaKind, type SignatureDelta } from "../signature";
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
      const artifact = db.prepare("SELECT status FROM artifacts WHERE id = ?").get(opts.artifactId) as { status: string } | undefined;
      if (artifact?.status === "migrated" && latest?.pass !== 0) {
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
