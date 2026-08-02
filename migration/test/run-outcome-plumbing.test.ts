import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { finishRun, listRuns, startRun } from "../registry/commands/runs";
import { applySchema } from "../registry/db/schema";

/**
 * Foundational coverage for T010/T011: `finishRun` accepts and persists the
 * eight attempt-outcome fields inside the same transaction that closes the run.
 *
 * Plumbing only. Label derivation and value-domain validation are US4 (T050)
 * and are deliberately not asserted here.
 */

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function storedRun(db: Database.Database, runId: string): Record<string, unknown> {
  return db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId) as Record<string, unknown>;
}

test("finishRun persists all eight attempt-outcome fields alongside the close", () => {
  const db = createDb();
  try {
    const run = startRun(db, { agent: "code-writer-agent", model: "test-model" });

    finishRun(db, {
      runId: run.run_id,
      exitCode: 124,
      reason: "code-writer-agent killed: CEILING after 1200s",
      filesWrittenCount: 0,
      filesWrittenSource: "warden-snapshot",
      statusFrom: "migrated",
      statusTo: "migrated",
      budgetConsumed: 1,
      cleanupOutcome: "survivors",
      survivorPids: [48211, 48212],
      outcomeLabel: "no-progress",
    });

    const stored = storedRun(db, run.run_id);
    assert.equal(stored["files_written_count"], 0);
    assert.equal(stored["files_written_source"], "warden-snapshot");
    assert.equal(stored["status_from"], "migrated");
    assert.equal(stored["status_to"], "migrated");
    assert.equal(stored["budget_consumed"], 1);
    assert.equal(stored["cleanup_outcome"], "survivors");
    assert.deepEqual(JSON.parse(String(stored["survivor_pids"])), [48211, 48212]);
    assert.equal(stored["outcome_label"], "no-progress");

    // The existing close semantics are untouched.
    assert.equal(stored["exit_code"], 124);
    assert.equal(stored["status"], "failed");
    assert.equal(stored["termination_reason"], "code-writer-agent killed: CEILING after 1200s");
    assert.notEqual(stored["finished_at"], null);
  } finally {
    db.close();
  }
});

test("omitting every attempt-outcome field reproduces today's finishRun behaviour exactly", () => {
  const db = createDb();
  try {
    const run = startRun(db, { agent: "review-agent", model: "test-model" });
    finishRun(db, {
      runId: run.run_id,
      exitCode: 0,
      tokenUsage: { input: 10, output: 5, reasoning: 2, cacheRead: 7, cacheWrite: 3, fresh: 17, total: 27 },
    });

    const stored = storedRun(db, run.run_id);
    assert.equal(stored["status"], "completed");
    assert.equal(stored["exit_code"], 0);
    assert.equal(stored["token_total"], 27);
    assert.equal(stored["token_fresh"], 17);
    for (const column of [
      "files_written_count", "files_written_source", "status_from", "status_to",
      "budget_consumed", "cleanup_outcome", "survivor_pids", "outcome_label",
    ]) {
      assert.equal(stored[column], null, `${column} must stay NULL when not supplied`);
    }
  } finally {
    db.close();
  }
});

test("files_written_count of 0 is persisted as a fact, distinct from NULL", () => {
  const db = createDb();
  try {
    const zero = startRun(db, { agent: "code-writer-agent" });
    finishRun(db, { runId: zero.run_id, exitCode: 1, filesWrittenCount: 0, filesWrittenSource: "git-diff" });
    const unknown = startRun(db, { agent: "code-writer-agent" });
    finishRun(db, { runId: unknown.run_id, exitCode: 1 });

    assert.equal(storedRun(db, zero.run_id)["files_written_count"], 0);
    assert.equal(storedRun(db, unknown.run_id)["files_written_count"], null);
  } finally {
    db.close();
  }
});

test("the outcome fields land in the same transaction that closes the run", () => {
  const db = createDb();
  try {
    const run = startRun(db, { agent: "code-writer-agent" });
    // A run is never observed finished-but-unlabelled: both halves commit together.
    finishRun(db, {
      runId: run.run_id,
      exitCode: 1,
      outcomeLabel: "failed",
      cleanupOutcome: "clean",
      filesWrittenCount: 3,
      filesWrittenSource: "warden-snapshot",
    });
    const stored = storedRun(db, run.run_id);
    assert.notEqual(stored["finished_at"], null);
    assert.equal(stored["outcome_label"], "failed");
    assert.equal(stored["cleanup_outcome"], "clean");
    assert.equal(stored["survivor_pids"], null);
  } finally {
    db.close();
  }
});

test("listRuns surfaces the new columns for --json consumers", () => {
  const db = createDb();
  try {
    const run = startRun(db, { agent: "code-writer-agent" });
    finishRun(db, {
      runId: run.run_id,
      exitCode: 0,
      filesWrittenCount: 2,
      filesWrittenSource: "git-diff",
      statusFrom: "planned",
      statusTo: "migrated",
      budgetConsumed: 1,
      cleanupOutcome: "clean",
      outcomeLabel: "succeeded",
    });

    const listed = listRuns(db, "code-writer-agent", 5)[0] as unknown as Record<string, unknown>;
    assert.equal(listed["files_written_count"], 2);
    assert.equal(listed["files_written_source"], "git-diff");
    assert.equal(listed["status_from"], "planned");
    assert.equal(listed["status_to"], "migrated");
    assert.equal(listed["budget_consumed"], 1);
    assert.equal(listed["cleanup_outcome"], "clean");
    assert.equal(listed["outcome_label"], "succeeded");
    // Existing fields and their meanings are unchanged.
    assert.equal(listed["agent"], "code-writer-agent");
    assert.equal(listed["status"], "completed");
  } finally {
    db.close();
  }
});
