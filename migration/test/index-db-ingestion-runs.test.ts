import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { applyIndexDbSchema } from "../index-db/schema";

/**
 * specs/007-doc-rag-lookup — T014: ingestion run recording helpers
 * (startIngestionRun / recordIngestionRunLibrary / completeIngestionRun)
 * per data-model.md's ingestion_runs + ingestion_run_libraries tables (FR-004).
 */

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applyIndexDbSchema(db);
  return db;
}

test("startIngestionRun inserts a run row and returns it (completed_at NULL while in progress)", async () => {
  const { startIngestionRun } = await import("../index-db/commands/runs");
  const db = freshDb();
  const run = startIngestionRun(db, { triggeredBy: "operator", lockedSetSnapshotCount: 3 });
  assert.ok(run.run_id.length > 0);
  assert.equal(run.triggered_by, "operator");
  assert.equal(run.locked_set_snapshot_count, 3);
  assert.equal(run.completed_at, null);
  assert.ok(run.started_at.length > 0);
});

test("recordIngestionRunLibrary writes one outcome row per library", async () => {
  const { startIngestionRun, recordIngestionRunLibrary } = await import("../index-db/commands/runs");
  const db = freshDb();
  const run = startIngestionRun(db, { triggeredBy: "operator", lockedSetSnapshotCount: 2 });

  recordIngestionRunLibrary(db, {
    runId: run.run_id,
    libraryName: "com.google.guava:guava",
    libraryVersion: "33.2.1-jre",
    outcome: "indexed",
    entriesWritten: 42,
  });
  recordIngestionRunLibrary(db, {
    runId: run.run_id,
    libraryName: "com.example:missing",
    libraryVersion: "1.0",
    outcome: "failed",
    reason: "no citable source found",
  });

  const rows = db
    .prepare("SELECT * FROM ingestion_run_libraries WHERE run_id = ? ORDER BY library_name")
    .all(run.run_id) as Record<string, unknown>[];
  assert.equal(rows.length, 2);
  const failed = rows.find((r) => r.library_name === "com.example:missing")!;
  assert.equal(failed.outcome, "failed");
  assert.equal(failed.reason, "no citable source found");
  assert.equal(failed.entries_written, 0);
});

test("recordIngestionRunLibrary requires a reason for skipped/failed outcomes", async () => {
  const { startIngestionRun, recordIngestionRunLibrary, IndexDbError } = await import("../index-db/commands/runs");
  const db = freshDb();
  const run = startIngestionRun(db, { triggeredBy: "operator", lockedSetSnapshotCount: 1 });
  assert.throws(
    () =>
      recordIngestionRunLibrary(db, {
        runId: run.run_id,
        libraryName: "com.example:x",
        libraryVersion: "1.0",
        outcome: "failed",
      }),
    (e: unknown) => e instanceof IndexDbError,
  );
  assert.throws(
    () =>
      recordIngestionRunLibrary(db, {
        runId: run.run_id,
        libraryName: "com.example:x",
        libraryVersion: "1.0",
        outcome: "skipped",
        reason: "  ",
      }),
    (e: unknown) => e instanceof IndexDbError,
  );
});

test("recordIngestionRunLibrary rejects an unknown outcome kind", async () => {
  const { startIngestionRun, recordIngestionRunLibrary, IndexDbError } = await import("../index-db/commands/runs");
  const db = freshDb();
  const run = startIngestionRun(db, { triggeredBy: "operator", lockedSetSnapshotCount: 1 });
  assert.throws(
    () =>
      recordIngestionRunLibrary(db, {
        runId: run.run_id,
        libraryName: "com.example:x",
        libraryVersion: "1.0",
        outcome: "bogus" as never,
      }),
    (e: unknown) => e instanceof IndexDbError,
  );
});

test("completeIngestionRun stamps completed_at on the run row", async () => {
  const { startIngestionRun, completeIngestionRun } = await import("../index-db/commands/runs");
  const db = freshDb();
  const run = startIngestionRun(db, { triggeredBy: "operator", lockedSetSnapshotCount: 0 });
  completeIngestionRun(db, run.run_id);
  const row = db.prepare("SELECT completed_at FROM ingestion_runs WHERE run_id = ?").get(run.run_id) as { completed_at: string | null };
  assert.ok(row.completed_at && row.completed_at.length > 0, "completed_at must be set");
});
