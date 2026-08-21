import assert from "node:assert/strict";
import test from "node:test";
import type Database from "better-sqlite3";
import { runArbitrate } from "../guildctl/commands/arbitrate";
import { getArtifact } from "../registry/commands/artifacts";
import {
  createApprovalGateFixture,
  seedHighRiskArtifact,
  seedRuntimeEvidence,
  HIGH_RISK_ARTIFACT_ID,
  OPERATOR_TOKEN,
  RUN_ID,
} from "./approval-fixtures";

// T008 (spec 013, FR-005/FR-008): `guildctl arbitrate --approve` must surface the
// approval-gate outcome. Approving an above-cutoff high-risk artifact holds it at
// `pending-approval` (not `reviewed`), and the CLI must say so; a low-risk
// artifact still promotes straight to `reviewed`. Registry-layer behavior is
// unchanged — this is CLI surfacing only.

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
  return getArtifact(db, artifactId)!.status;
}

test("T008: approving a HIGH-risk artifact reports target_status=pending-approval (held for human approval)", async () => {
  const gate = createApprovalGateFixture();
  try {
    seedHighRiskArtifact(gate);
    seedRuntimeEvidence(gate);

    const { out } = await capture(() =>
      runArbitrate(gate.db, {
        artifact: HIGH_RISK_ARTIFACT_ID,
        approve: true,
        arbiter: "arbiter-1",
        reason: "verdict approve",
        runId: RUN_ID,
        operatorToken: OPERATOR_TOKEN,
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
  const gate = createApprovalGateFixture();
  try {
    seedHighRiskArtifact(gate);
    seedRuntimeEvidence(gate);

    const { out } = await capture(() =>
      runArbitrate(gate.db, {
        artifact: HIGH_RISK_ARTIFACT_ID,
        approve: true,
        arbiter: "arbiter-1",
        reason: "verdict approve",
        runId: RUN_ID,
        operatorToken: OPERATOR_TOKEN,
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
  const gate = createApprovalGateFixture();
  try {
    // Low-risk: no artifact_risk_assessments row → resolveGateScope is out of scope.
    gate.registerArtifact(HIGH_RISK_ARTIFACT_ID);
    gate.setArtifactStatus(HIGH_RISK_ARTIFACT_ID, "migrated");
    seedRuntimeEvidence(gate);

    const { out } = await capture(() =>
      runArbitrate(gate.db, {
        artifact: HIGH_RISK_ARTIFACT_ID,
        approve: true,
        arbiter: "arbiter-1",
        reason: "verdict approve",
        runId: RUN_ID,
        operatorToken: OPERATOR_TOKEN,
      }),
    );

    assert.equal(getStatus(gate.db, HIGH_RISK_ARTIFACT_ID), "reviewed");
    assert.match(out.stdout, /target_status=reviewed/);
    assert.doesNotMatch(out.stdout, /held for human approval/);
    assert.doesNotMatch(out.stdout, /target_status=pending-approval/);
  } finally {
    gate.db.close();
  }
});

test("T008: approving a LOW-risk artifact --json reports artifactStatus=reviewed, heldForApproval=false", async () => {
  const gate = createApprovalGateFixture();
  try {
    gate.registerArtifact(HIGH_RISK_ARTIFACT_ID);
    gate.setArtifactStatus(HIGH_RISK_ARTIFACT_ID, "migrated");
    seedRuntimeEvidence(gate);

    const { out } = await capture(() =>
      runArbitrate(gate.db, {
        artifact: HIGH_RISK_ARTIFACT_ID,
        approve: true,
        arbiter: "arbiter-1",
        reason: "verdict approve",
        runId: RUN_ID,
        operatorToken: OPERATOR_TOKEN,
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
  const gate = createApprovalGateFixture();
  try {
    seedHighRiskArtifact(gate);
    seedRuntimeEvidence(gate);

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
