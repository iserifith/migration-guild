import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { signRuntimeEvidence, sha256 } from "../guildctl/verify";
import { createRunOperatorCredential } from "../registry/commands/claim";
import { registerArtifact, setArtifactStatus } from "../registry/commands/artifacts";
import { deriveBenchmarkMetrics } from "../registry/commands/benchmark";
import { addAcceptanceEvidence, addVerifierRuntimeEvidence, approveArtifactWithEvidence, rejectArtifactWithEvidence } from "../registry/commands/evidence";
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
    const run = startRun(db, { agent: "builder-agent" });
    const operatorToken = createRunOperatorCredential(db, run.run_id).token;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guild-benchmark-evidence-"));
    const logPath = path.join(dir, "runtime.log");
    const log = "test passed\n";
    fs.writeFileSync(logPath, log);
    const logSha256 = sha256(log);
    addVerifierRuntimeEvidence(db, {
      artifactId: id, producedBy: "critic-agent", runId: run.run_id,
      command: "mvn test", exitCode: 0, pass: 1, summary: "test passed",
      outputPath: logPath, outputExcerpt: log,
      logSha256, durationMs: 10,
      authenticity: signRuntimeEvidence({ artifactId: id, runId: run.run_id, command: "mvn test", exitCode: 0, pass: 1, logSha256 }, operatorToken),
    });
    approveArtifactWithEvidence(db, { artifactId: id, arbiter: "arbiter-agent", reason: "passing independent proof", runId: run.run_id, operatorToken });
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
    fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    db.close();
  }
});
