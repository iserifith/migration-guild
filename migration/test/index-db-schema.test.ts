import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { applyIndexDbSchema } from "../index-db/schema";

/**
 * Foundational coverage for specs/007-doc-rag-lookup/contracts/index-db-schema.md.
 *
 * Mirrors disposition-schema.test.ts's PRAGMA-introspection approach: after
 * `applyIndexDbSchema(db)`, assert the four tables, indexes, the FTS5 virtual
 * table, and the two external-content sync triggers exist as specified.
 */

interface ColumnInfo { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }

function columns(db: Database.Database, table: string): ColumnInfo[] {
  return db.prepare(`SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?)`).all(table) as ColumnInfo[];
}

function names(db: Database.Database, type: "table" | "index" | "trigger"): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .pluck()
    .all(type) as string[];
}

function ddl(db: Database.Database, name: string): string {
  return (db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").pluck().get(name) as string | null) ?? "";
}

test("applyIndexDbSchema creates documentation_entries with the contract's columns and CHECK", () => {
  const db = new Database(":memory:");
  applyIndexDbSchema(db);

  const cols = columns(db, "documentation_entries");
  const byName = new Map(cols.map((c) => [c.name, c]));

  for (const name of [
    "entry_id", "library_name", "library_version", "symbol_kind", "symbol_name",
    "signature", "description", "return_type", "source_url", "source_excerpt",
    "ingestion_run_id", "indexed_at",
  ]) {
    assert.ok(byName.has(name), `missing column ${name}`);
  }
  assert.equal(byName.get("entry_id")!.pk, 1);
  for (const name of ["library_name", "library_version", "symbol_kind", "symbol_name", "description", "source_url", "source_excerpt", "ingestion_run_id"]) {
    assert.equal(byName.get(name)!.notnull, 1, `${name} must be NOT NULL`);
  }
  assert.equal(byName.get("signature")!.notnull, 0, "signature is NULL for class rows");
  assert.equal(byName.get("return_type")!.notnull, 0, "return_type is NULL for class rows");

  const tableDdl = ddl(db, "documentation_entries");
  assert.match(tableDdl, /symbol_kind IN \('class', 'method'\)/);
  assert.match(tableDdl, /UNIQUE \(library_name, library_version, symbol_kind, symbol_name, signature\)/);
});

test("applyIndexDbSchema creates the library+version index", () => {
  const db = new Database(":memory:");
  applyIndexDbSchema(db);
  assert.ok(names(db, "index").includes("idx_documentation_entries_library_version"));
});

test("applyIndexDbSchema creates the FTS5 virtual table over symbol_name + description", () => {
  const db = new Database(":memory:");
  applyIndexDbSchema(db);
  const ftsDdl = ddl(db, "documentation_entries_fts");
  assert.match(ftsDdl, /fts5/i);
  assert.match(ftsDdl, /symbol_name/);
  assert.match(ftsDdl, /description/);
  assert.match(ftsDdl, /content='documentation_entries'/);
  assert.match(ftsDdl, /content_rowid='rowid'/);
});

test("applyIndexDbSchema creates the FTS sync triggers", () => {
  const db = new Database(":memory:");
  applyIndexDbSchema(db);
  const triggers = names(db, "trigger");
  assert.ok(triggers.includes("documentation_entries_ai"));
  assert.ok(triggers.includes("documentation_entries_ad"));
});

test("applyIndexDbSchema creates ingestion_runs with the contract's columns", () => {
  const db = new Database(":memory:");
  applyIndexDbSchema(db);
  const cols = columns(db, "ingestion_runs");
  const byName = new Map(cols.map((c) => [c.name, c]));
  for (const name of ["run_id", "started_at", "completed_at", "triggered_by", "locked_set_snapshot_count"]) {
    assert.ok(byName.has(name), `missing column ${name}`);
  }
  assert.equal(byName.get("run_id")!.pk, 1);
  assert.equal(byName.get("triggered_by")!.notnull, 1);
  assert.equal(byName.get("locked_set_snapshot_count")!.notnull, 1);
  assert.equal(byName.get("completed_at")!.notnull, 0, "completed_at is NULL while in progress");
});

test("applyIndexDbSchema creates ingestion_run_libraries with outcome CHECK and composite PK", () => {
  const db = new Database(":memory:");
  applyIndexDbSchema(db);
  const cols = columns(db, "ingestion_run_libraries");
  const byName = new Map(cols.map((c) => [c.name, c]));
  for (const name of ["run_id", "library_name", "library_version", "outcome", "reason", "entries_written"]) {
    assert.ok(byName.has(name), `missing column ${name}`);
  }
  assert.ok(byName.get("run_id")!.pk >= 1, "run_id participates in the PK");
  assert.ok(byName.get("library_name")!.pk >= 1, "library_name participates in the PK");
  const tableDdl = ddl(db, "ingestion_run_libraries");
  assert.match(tableDdl, /outcome IN \('indexed', 'skipped', 'unchanged', 'failed'\)/);
});

test("applyIndexDbSchema is idempotent (safe to call on every open)", () => {
  const db = new Database(":memory:");
  applyIndexDbSchema(db);
  applyIndexDbSchema(db);
  assert.ok(names(db, "table").includes("documentation_entries"));
});

test("FTS sync triggers keep the virtual table in sync with documentation_entries", () => {
  const db = new Database(":memory:");
  applyIndexDbSchema(db);
  db.prepare(`INSERT INTO ingestion_runs (run_id, triggered_by, locked_set_snapshot_count) VALUES ('run-1', 'test', 1)`).run();
  db.prepare(`INSERT INTO documentation_entries (
      entry_id, library_name, library_version, symbol_kind, symbol_name, signature,
      description, return_type, source_url, source_excerpt, ingestion_run_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("doc-1", "com.google.guava:guava", "33.2.1-jre", "method", "Preconditions#checkNotNull",
      "(java.lang.Object)", "Checks that the given object reference is not null.", "java.lang.Object",
      "https://example.test/docs", "Checks that the given object reference is not null.", "run-1");

  const hits = db.prepare(`SELECT rowid FROM documentation_entries_fts WHERE documentation_entries_fts MATCH 'checkNotNull'`).all();
  assert.equal(hits.length, 1);

  db.prepare("DELETE FROM documentation_entries WHERE entry_id = 'doc-1'").run();
  const afterDelete = db.prepare(`SELECT rowid FROM documentation_entries_fts WHERE documentation_entries_fts MATCH 'checkNotNull'`).all();
  assert.equal(afterDelete.length, 0);
});
