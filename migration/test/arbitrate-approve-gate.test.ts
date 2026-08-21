import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type Database from "better-sqlite3";
import { runArbitrate } from "../guildctl/commands/arbitrate";
import { signRuntimeEvidence, sha256 } from "../guildctl/verify";
import { addVerifierRuntimeEvidence } from "../registry/commands/evidence";
import {
  createApprovalGateDb,
  seedHighRiskArtifact,
  seedLowRiskArtifact,
  HIGH_RISK_ARTIFACT_ID,
  LOW_RISK_ARTIFACT_ID,
  type ApprovalGateDb,
} from "./approval-fixtures";

// T008 (spec 013, FR-005/FR-008): `guildctl arbitrate --approve` must surface the
// approval-gate outcome. Approving an above-cutoff high-risk artifact holds it at
// `pending-approval` (not `reviewed`), and the CLI must say so; a low-risk
// artifact still promotes straight to `reviewed`. Registry-layer behavior is
// unchanged — this is CLI surfacing only.

// The fixtures' seedArtifact seeds the risk assessment plus a gate-oriented
// runtime-evidence row whose run_id is NULL and which has no on-disk
// output_path. That's enough to drive the gate via direct status manipulation
// (what approval-gate.test.ts does), but NOT enough for the
// `approveArtifactWithEvidence` path that `runArbitrate --approve` takes, which
// requires: run binding, an on-disk log whose sha256 matches log_sha256, and the
// raw HMAC in `authenticity`. Mirror arbitrate-manual-approval.test.ts's
// signedRuntimeEvidence helper: write a real log file and add run-bound,
// authenticity-signed runtime evidence under the gate run's operator credential.
function bindApproveableEvidence(gate: ApprovalGateDb, artifactId: string): void {
  const log = "runtime ok\n";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guild-t008-evidence-"));
  const logPath = path.join(dir, "runtime.log");
  fs.writeFileSync(logPath, log);
  const logSha256 = sha256(log);
  const command = "npm test";
  const exitCode = 0;
  const pass = 1 as const;
  addVerifierRuntimeEvidence(gate.db, {
    artifactId,
    producedBy: "critic-agent",
    runId: gate.runId,
    command,
    exitCode,
    pass,
    summary: "runtime passed",
    outputPath: logPath,
    outputExcerpt: log,
    logSha256,
    durationMs: 10,
    authenticity: signRuntimeEvidence(
      { artifactId, runId: gate.runId, command, exitCode, pass, logSha256 },
      gate.operatorToken,
    ),
  });
}

interface Captured {
  stdout: string;
  stderr: string;
}

async function capture<T>(fn: () => Promise<T>): Promise<{ result: T; out: Captured }> {
  const out: Captured = { stdout: "", stderr: "" };
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  (process.stdout.write as typeof origStdout) = ((chunk: unknown) => {
    out.stdout += String(chunk);
    return true;
  }) as typeof origStdout;
  (process.stderr.write as typeof origStderr) = ((chunk: unknown) => {
    out.stderr += String(chunk);
    return true;
  }) as typeof origStderr;
  try {
    const result = await fn();
    return { result, out };
  } finally {
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
  }
}

function getStatus(db: Database.Database, artifactId: string): string {
  const row = db.prepare("SELECT status FROM artifacts WHERE id = ?").get(artifactId) as { status: string } | undefined;
  return row?.status ?? "";
}

test("T008: approving a HIGH-risk artifact reports target_status=pending-approval (held for human approval)", async () => {
  const gate = createApprovalGateDb();
  try {
    seedHighRiskArtifact(gate);
    bindApproveableEvidence(gate, HIGH_RISK_ARTIFACT_ID);

    const { out } = await capture(() =>
      runArbitrate(gate.db, {
        artifact: HIGH_RISK_ARTIFACT_ID,
        approve: true,
        arbiter: "arbiter-1",
        reason: "verdict approve",
        runId: gate.runId,
        operatorToken: gate.operatorToken,
      }),
    );

    // The registry actually held the artifact at the gate.
    assert.equal(getStatus(gate.db, HIGH_RISK_ARTIFACT_ID), "pending-approval");
    // The non-JSON summary reflects the real post-verdict status and the hold.
    assert.match(out.stdout, /target_status=pending-approval/);
    assert.match(out.stdout, /held for human approval/);
    assert.doesNotMatch(out.stdout, /target_status=reviewed/);
  } finally {
    gate.db.close();
  }
});

test("T008: approving a HIGH-risk artifact --json adds artifactStatus + heldForApproval to the decision", async () => {
  const gate = createApprovalGateDb();
  try {
    seedHighRiskArtifact(gate);
    bindApproveableEvidence(gate, HIGH_RISK_ARTIFACT_ID);

    const { out } = await capture(() =>
      runArbitrate(gate.db, {
        artifact: HIGH_RISK_ARTIFACT_ID,
        approve: true,
        arbiter: "arbiter-1",
        reason: "verdict approve",
        runId: gate.runId,
        operatorToken: gate.operatorToken,
        json: true,
      }),
    );

    const parsed = JSON.parse(out.stdout) as Record<string, unknown>;
    // Existing ArbitrationDecision fields are preserved verbatim.
    assert.equal(parsed.artifact_id, HIGH_RISK_ARTIFACT_ID);
    assert.equal(parsed.decision, "approved");
    assert.equal(parsed.arbiter, "arbiter-1");
    assert.ok(typeof parsed.decision_id === "string" && parsed.decision_id.length > 0);
    // Additive gate-outcome fields let a CLI consumer tell gated from promoted.
    assert.equal(parsed.artifactStatus, "pending-approval");
    assert.equal(parsed.heldForApproval, true);
  } finally {
    gate.db.close();
  }
});

test("T008: approving a LOW-risk artifact reports target_status=reviewed (not held)", async () => {
  const gate = createApprovalGateDb();
  try {
    seedLowRiskArtifact(gate);
    bindApproveableEvidence(gate, LOW_RISK_ARTIFACT_ID);

    const { out } = await capture(() =>
      runArbitrate(gate.db, {
        artifact: LOW_RISK_ARTIFACT_ID,
        approve: true,
        arbiter: "arbiter-1",
        reason: "verdict approve",
        runId: gate.runId,
        operatorToken: gate.operatorToken,
      }),
    );

    assert.equal(getStatus(gate.db, LOW_RISK_ARTIFACT_ID), "reviewed");
    assert.match(out.stdout, /target_status=reviewed/);
    assert.doesNotMatch(out.stdout, /held for human approval/);
    assert.doesNotMatch(out.stdout, /target_status=pending-approval/);
  } finally {
    gate.db.close();
  }
});

test("T008: approving a LOW-risk artifact --json reports artifactStatus=reviewed, heldForApproval=false", async () => {
  const gate = createApprovalGateDb();
  try {
    seedLowRiskArtifact(gate);
    bindApproveableEvidence(gate, LOW_RISK_ARTIFACT_ID);

    const { out } = await capture(() =>
      runArbitrate(gate.db, {
        artifact: LOW_RISK_ARTIFACT_ID,
        approve: true,
        arbiter: "arbiter-1",
        reason: "verdict approve",
        runId: gate.runId,
        operatorToken: gate.operatorToken,
        json: true,
      }),
    );

    const parsed = JSON.parse(out.stdout) as Record<string, unknown>;
    assert.equal(parsed.decision, "approved");
    assert.equal(parsed.artifactStatus, "reviewed");
    assert.equal(parsed.heldForApproval, false);
  } finally {
    gate.db.close();
  }
});

test("T008: rejecting an artifact reports target_status=needs-rework and heldForApproval=false", async () => {
  const gate = createApprovalGateDb();
  try {
    seedHighRiskArtifact(gate);

    const { out } = await capture(() =>
      runArbitrate(gate.db, {
        artifact: HIGH_RISK_ARTIFACT_ID,
        reject: true,
        arbiter: "arbiter-1",
        reason: "needs more work",
      }),
    );

    assert.equal(getStatus(gate.db, HIGH_RISK_ARTIFACT_ID), "needs-rework");
    assert.match(out.stdout, /target_status=needs-rework/);
    assert.doesNotMatch(out.stdout, /held for human approval/);
  } finally {
    gate.db.close();
  }
});
