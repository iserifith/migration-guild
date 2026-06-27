import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { registerArtifact, setArtifactStatus } from "../registry/commands/artifacts";
import { deriveBenchmarkMetrics } from "../registry/commands/benchmark";
import { addAcceptanceEvidence, approveArtifactWithEvidence, rejectArtifactWithEvidence } from "../registry/commands/evidence";
import { finishRun, startRun } from "../registry/commands/runs";
import { applySchema } from "../registry/db/schema";

test("derives completion, evidence pass rate, and rework from real registry state", () => {
  const db = new Database(":memory:");
  try {
    applySchema(db);
    const id = "legacy-source:com.acme:CustomerUtils";
    registerArtifact(db, { id, kind: "legacy-source", path: "legacy/CustomerUtils.java" });
    setArtifactStatus(db, id, "migrated", { agent: "builder-agent", reason: "proposal" });
    const failedEvidence = addAcceptanceEvidence(db, {
      artifactId: id, producedBy: "critic-agent", evidenceType: "test-command",
      command: "mvn test", exitCode: 1, pass: 0, summary: "test failed",
    });
    rejectArtifactWithEvidence(db, {
      artifactId: id, arbiter: "arbiter-agent", reason: "failed proof", evidenceIds: [failedEvidence.evidence_id],
    });
    setArtifactStatus(db, id, "migrated", { agent: "builder-agent", reason: "reworked proposal" });
    addAcceptanceEvidence(db, {
      artifactId: id, producedBy: "critic-agent", evidenceType: "test-command",
      command: "mvn test", exitCode: 0, pass: 1, summary: "test passed",
    });
    approveArtifactWithEvidence(db, { artifactId: id, arbiter: "arbiter-agent", reason: "passing independent proof" });
    const run = startRun(db, { agent: "builder-agent" });
    finishRun(db, { runId: run.run_id, exitCode: 0 });

    assert.deepEqual(deriveBenchmarkMetrics(db, "guild"), {
      totalRuns: 1,
      failedRuns: 0,
      artifactsPlanned: 1,
      artifactsCompleted: 1,
      evidencePassRate: 0.5,
      reworkCount: 1,
      verdict: "pass",
    });
  } finally {
    db.close();
  }
});
