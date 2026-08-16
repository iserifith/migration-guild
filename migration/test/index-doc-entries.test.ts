import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { applyIndexDbSchema } from "../index-db/schema";

/**
 * specs/007-doc-rag-lookup — T013: write-path invariant coverage for
 * upsertDocumentationEntry (FR-003a) and the version-change lifecycle
 * (data-model.md: superseded-version rows are deleted in the same transaction
 * that writes the new version's rows).
 */

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applyIndexDbSchema(db);
  return db;
}

function seedRun(db: Database.Database, runId = "run-1"): void {
  db.prepare(
    "INSERT INTO ingestion_runs (run_id, started_at, triggered_by, locked_set_snapshot_count) VALUES (?, datetime('now'), 'operator', 1)",
  ).run(runId);
}

const BASE = {
  libraryName: "com.google.guava:guava",
  libraryVersion: "33.2.1-jre",
  symbolKind: "method" as const,
  symbolName: "Preconditions#checkNotNull",
  signature: "(java.lang.Object)",
  description: "Ensures the truth of an expression involving one or more parameters.",
  returnType: "T",
  sourceUrl: "https://guava.dev/releases/33.2.1-jre/api/docs/com/google/common/base/Preconditions.html",
  sourceExcerpt: "public static <T> T checkNotNull(T reference) — Ensures that an object reference passed as a parameter is not null.",
  ingestionRunId: "run-1",
};

test("upsertDocumentationEntry rejects an empty source_url (FR-003a write-time guarantee)", async () => {
  const { upsertDocumentationEntry, IndexDbError } = await import("../index-db/commands/entries");
  const db = freshDb();
  seedRun(db);
  assert.throws(
    () => upsertDocumentationEntry(db, { ...BASE, sourceUrl: "  " }),
    (e: unknown) => e instanceof IndexDbError,
  );
  const n = db.prepare("SELECT COUNT(*) AS n FROM documentation_entries").pluck().get() as number;
  assert.equal(n, 0, "rejected write must not reach documentation_entries");
});

test("upsertDocumentationEntry rejects an empty source_excerpt (FR-003a)", async () => {
  const { upsertDocumentationEntry, IndexDbError } = await import("../index-db/commands/entries");
  const db = freshDb();
  seedRun(db);
  assert.throws(
    () => upsertDocumentationEntry(db, { ...BASE, sourceExcerpt: "" }),
    (e: unknown) => e instanceof IndexDbError,
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM documentation_entries").pluck().get(), 0);
});

test("upsertDocumentationEntry derives a deterministic entry_id and populates the FTS index", async () => {
  const { upsertDocumentationEntry } = await import("../index-db/commands/entries");
  const db = freshDb();
  seedRun(db);
  const first = upsertDocumentationEntry(db, BASE);
  assert.match(first.entry_id, /^doc-[0-9a-f]{12}$/);

  const row = db.prepare("SELECT * FROM documentation_entries WHERE entry_id = ?").get(first.entry_id) as Record<string, unknown>;
  assert.equal(row.library_name, BASE.libraryName);
  assert.equal(row.signature, BASE.signature);

  const fts = db.prepare("SELECT COUNT(*) AS n FROM documentation_entries_fts WHERE documentation_entries_fts MATCH 'checkNotNull'").pluck().get() as number;
  assert.equal(fts, 1, "FTS5 external-content trigger must index the new row");

  // Deterministic id: re-upserting the identical entry is a no-op write (FR-007).
  const again = upsertDocumentationEntry(db, BASE);
  assert.equal(again.entry_id, first.entry_id);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM documentation_entries").pluck().get(), 1);
});

test("version change deletes superseded rows in the same transaction that writes the new version", async () => {
  const { upsertDocumentationEntry } = await import("../index-db/commands/entries");
  const db = freshDb();
  seedRun(db, "run-old");
  upsertDocumentationEntry(db, { ...BASE, ingestionRunId: "run-old" });
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM documentation_entries WHERE library_version = '33.2.1-jre'").pluck().get(),
    1,
  );

  seedRun(db, "run-new");
  const newer = { ...BASE, libraryVersion: "33.3.0-jre", ingestionRunId: "run-new" };
  upsertDocumentationEntry(db, newer);

  const oldRows = db
    .prepare("SELECT COUNT(*) AS n FROM documentation_entries WHERE library_name = ? AND library_version = ?")
    .pluck().get(BASE.libraryName, BASE.libraryVersion) as number;
  assert.equal(oldRows, 0, "old-version rows must not remain queryable after the new version is written");

  const newRows = db
    .prepare("SELECT COUNT(*) AS n FROM documentation_entries WHERE library_name = ? AND library_version = ?")
    .pluck().get(BASE.libraryName, newer.libraryVersion) as number;
  assert.equal(newRows, 1);

  // FTS must not serve the superseded version either (delete trigger fired in-transaction).
  const ftsHits = db
    .prepare(
      `SELECT e.library_version AS v FROM documentation_entries_fts
       JOIN documentation_entries e ON e.rowid = documentation_entries_fts.rowid
       WHERE documentation_entries_fts MATCH 'checkNotNull'`,
    )
    .all() as { v: string }[];
  assert.deepEqual(ftsHits.map((r) => r.v), ["33.3.0-jre"]);
});

test("index-doc-entry CLI command enforces the same write-path invariant (quickstart Scenario 2)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guild-indexdb-cli-"));
  const indexDbPath = path.join(dir, ".guild", "index.db");
  const cli = path.resolve(__dirname, "..", "registry", "cli.ts");

  const run = (args: string[]): { status: number; stdout: string } => {
    try {
      const stdout = execFileSync(
        process.execPath,
        ["--import", "tsx", cli, ...args, "--index-db", indexDbPath],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      return { status: 0, stdout };
    } catch (e) {
      const err = e as { status?: number; stdout?: string };
      return { status: err.status ?? 1, stdout: String(err.stdout ?? "") };
    }
  };

  // Missing provenance ⇒ rejected (non-zero exit, error payload), nothing written.
  const bad = run([
    "index-doc-entry",
    "--library", "com.google.guava:guava",
    "--version", "33.2.1-jre",
    "--symbol-kind", "class",
    "--symbol-name", "com.google.common.base.Preconditions",
    "--description", "Preconditions for method arguments.",
    "--source-url", "",
    "--source-excerpt", "",
  ]);
  assert.notEqual(bad.status, 0, "empty provenance must be rejected");
  const badPayload = JSON.parse(bad.stdout) as { ok: boolean; error?: string };
  assert.equal(badPayload.ok, false);
  assert.match(badPayload.error ?? "", /source/i);

  const db = new Database(indexDbPath);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM documentation_entries").pluck().get(), 0);

  // A well-formed write succeeds and returns the deterministic entry_id.
  const good = run([
    "index-doc-entry",
    "--library", "com.google.guava:guava",
    "--version", "33.2.1-jre",
    "--symbol-kind", "class",
    "--symbol-name", "com.google.common.base.Preconditions",
    "--description", "Preconditions for method arguments.",
    "--source-url", "https://guava.dev/releases/33.2.1-jre/api/docs/com/google/common/base/Preconditions.html",
    "--source-excerpt", "Static convenience methods that help a method or constructor check whether it was invoked correctly.",
  ]);
  assert.equal(good.status, 0, good.stdout);
  const goodPayload = JSON.parse(good.stdout) as { entry_id: string };
  assert.match(goodPayload.entry_id, /^doc-[0-9a-f]{12}$/);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
