import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { deriveOutcomeLabel } from "../guildctl/runner";
import { registerArtifact } from "../registry/commands/artifacts";
import { finishRun, listRuns, startRun } from "../registry/commands/runs";
import { applySchema } from "../registry/db/schema";
import { RegistryError } from "../registry/types";

/**
 * US4 (FR-030–FR-034): outcome_label is computed, never supplied by an agent,
 * and the questions "what did this attempt produce, what did it change, and
 * how did it end" must be answerable from recorded state without reading logs.
 */

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  registerArtifact(db, {
    id: "legacy-source:com.acme:OutcomeThing",
    kind: "legacy-source",
    tier: "first-class",
    path: "legacy/src/main/java/com/acme/OutcomeThing.java",
  });
  return db;
}

test("no-progress requires files_written_count = 0 AND status_from = status_to", () => {
  const label = deriveOutcomeLabel({
    exitCode: 124,
    limitKilled: true,
    statusFrom: "planned",
    statusTo: "planned",
    filesWrittenCount: 0,
    filesWrittenSource: "warden-snapshot",
    wardenClean: true,
  });
  assert.equal(label, "no-progress");
});

test("a terminated attempt that wrote files is released-retryable, not no-progress", () => {
  const label = deriveOutcomeLabel({
    exitCode: 124,
    limitKilled: true,
    statusFrom: "planned",
    statusTo: "planned",
    filesWrittenCount: 3,
    filesWrittenSource: "warden-snapshot",
    wardenClean: true,
  });
  assert.equal(label, "released-retryable");
});

test("succeeded is rejected whenever status_from = status_to", () => {
  const label = deriveOutcomeLabel({
    exitCode: 0,
    limitKilled: false,
    statusFrom: "planned",
    statusTo: "planned",
    filesWrittenCount: 5,
    filesWrittenSource: "warden-snapshot",
    wardenClean: true,
  });
  assert.notEqual(label, "succeeded");
});

test("succeeded requires exit 0, an actual status advance, and a clean warden", () => {
  const label = deriveOutcomeLabel({
    exitCode: 0,
    limitKilled: false,
    statusFrom: "tests-written",
    statusTo: "migrated",
    filesWrittenCount: 2,
    filesWrittenSource: "warden-snapshot",
    wardenClean: true,
  });
  assert.equal(label, "succeeded");
});

test("a limit termination with an unavailable file count is released-retryable, never no-progress", () => {
  const label = deriveOutcomeLabel({
    exitCode: 124,
    limitKilled: true,
    statusFrom: "planned",
    statusTo: "planned",
    filesWrittenCount: null,
    filesWrittenSource: "unavailable",
    wardenClean: true,
  });
  assert.equal(label, "released-retryable");
});

test("a non-zero exit with a warden violation is failed", () => {
  const label = deriveOutcomeLabel({
    exitCode: 1,
    limitKilled: false,
    statusFrom: "planned",
    statusTo: "planned",
    filesWrittenCount: 1,
    filesWrittenSource: "warden-snapshot",
    wardenClean: false,
  });
  assert.equal(label, "failed");
});

test("finishRun persists files_written_source distinctly from a false git-diff none", () => {
  const db = createDb();
  const runId = "run-outcome-0001";
  startRun(db, { runId, agent: "code-writer-agent", ownerId: "guildctl" });
  finishRun(db, {
    runId,
    exitCode: 124,
    filesWrittenCount: 0,
    filesWrittenSource: "unavailable",
    statusFrom: "planned",
    statusTo: "planned",
    budgetConsumed: 1,
    cleanupOutcome: "clean",
    outcomeLabel: "released-retryable",
  });
  const [run] = listRuns(db, "code-writer-agent", 1);
  assert.equal(run.files_written_source, "unavailable");
  assert.equal(run.files_written_count, 0);
  assert.equal(run.outcome_label, "released-retryable");
});

test("finishRun rejects outcome_label=succeeded when status_from equals status_to", () => {
  const db = createDb();
  const runId = "run-outcome-0002";
  startRun(db, { runId, agent: "code-writer-agent", ownerId: "guildctl" });
  assert.throws(() => {
    finishRun(db, {
      runId,
      exitCode: 0,
      statusFrom: "migrated",
      statusTo: "migrated",
      outcomeLabel: "succeeded",
    });
  }, RegistryError);
});

test("finishRun requires non-empty survivor_pids iff cleanup_outcome = survivors", () => {
  const db = createDb();
  const runId = "run-outcome-0003";
  startRun(db, { runId, agent: "code-writer-agent", ownerId: "guildctl" });
  assert.throws(() => {
    finishRun(db, { runId, exitCode: 1, cleanupOutcome: "survivors" });
  }, RegistryError);
  // A valid survivors record is accepted.
  finishRun(db, { runId, exitCode: 1, cleanupOutcome: "survivors", survivorPids: [4242] });
  const [run] = listRuns(db, "code-writer-agent", 1);
  assert.equal(run.cleanup_outcome, "survivors");
  assert.equal(JSON.parse(run.survivor_pids ?? "[]")[0], 4242);
});

test("the repeat-no-progress condition is a query over runs joined to claims, not a stored counter", () => {
  const db = createDb();
  // Two independent no-progress runs recorded for the same artifact via claims.
  for (let i = 0; i < 2; i++) {
    const runId = `run-repeat-000${i}`;
    startRun(db, { runId, agent: "code-writer-agent", ownerId: "guildctl" });
    finishRun(db, {
      runId,
      exitCode: 124,
      filesWrittenCount: 0,
      filesWrittenSource: "warden-snapshot",
      statusFrom: "planned",
      statusTo: "planned",
      outcomeLabel: "no-progress",
    });
    db.prepare(`
      INSERT INTO artifact_claims (claim_id, artifact_id, run_id, owner_id, agent, from_status, claim_token, state, attempt_no, lease_expires_at)
      VALUES (@claim_id, @artifact_id, @run_id, 'guildctl', 'code-writer-agent', 'planned', @token, 'released', 1, datetime('now', '+1 hour'))
    `).run({ claim_id: `claim-repeat-${i}`, artifact_id: "legacy-source:com.acme:OutcomeThing", run_id: runId, token: `tok-${i}` });
  }
  const row = db.prepare(`
    SELECT c.artifact_id, COUNT(*) AS n
    FROM runs r
    JOIN artifact_claims c ON c.run_id = r.run_id
    WHERE r.outcome_label = 'no-progress'
    GROUP BY c.artifact_id
  `).get() as { artifact_id: string; n: number };
  assert.equal(row.artifact_id, "legacy-source:com.acme:OutcomeThing");
  assert.equal(row.n, 2);
});
