import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { applySchema } from "../registry/db/schema";

/**
 * Foundational coverage for specs/006-dependency-disposition/contracts/registry-schema.md.
 *
 * Mirrors registry-schema-delta.test.ts's PRAGMA-introspection approach: after
 * `applySchema(db)`, assert the two new disposition tables exist with every
 * column and CHECK constraint from the contract, plus the three new indexes.
 */

interface ColumnInfo { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }

function columns(db: Database.Database, table: string): ColumnInfo[] {
  // `notnull` is a SQLite keyword; it must be quoted when selected by name.
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

const DISPOSITION_COLUMNS = [
  "disposition_id", "library_name", "current_version", "disposition", "status",
  "native_replacement", "inline_note", "locked_target_version", "rationale",
  "usage_json", "proposed_by", "confirmed_by", "confirmed_at",
  "pending_disposition", "pending_native_replacement", "pending_inline_note",
  "pending_locked_target_version", "pending_rationale", "pending_proposed_by",
  "pending_at", "created_at", "updated_at",
];

const HISTORY_COLUMNS = [
  "history_id", "disposition_id", "library_name", "snapshot_json",
  "change_kind", "change_actor", "superseded_at",
];

const NEW_INDEXES = [
  "idx_dependency_dispositions_status",
  "idx_dependency_dispositions_pending",
  "idx_dependency_disposition_history_library",
];

test("a fresh registry ends with dependency_dispositions carrying every contract column and CHECK", () => {
  const db = new Database(":memory:");
  try {
    applySchema(db);

    assert.ok(names(db, "table").includes("dependency_dispositions"),
      "dependency_dispositions table is missing");

    const dispositionColumns = columns(db, "dependency_dispositions");
    assert.deepEqual(dispositionColumns.map((c) => c.name), DISPOSITION_COLUMNS);

    const byName = new Map(dispositionColumns.map((c) => [c.name, c]));
    assert.equal(byName.get("disposition_id")?.pk, 1);
    for (const column of ["library_name", "disposition", "status", "rationale", "proposed_by", "created_at", "updated_at"]) {
      assert.equal(byName.get(column)?.notnull, 1, `${column} must be NOT NULL`);
    }
    for (const column of [
      "current_version", "native_replacement", "inline_note", "locked_target_version",
      "usage_json", "confirmed_by", "confirmed_at", "pending_disposition",
      "pending_native_replacement", "pending_inline_note", "pending_locked_target_version",
      "pending_rationale", "pending_proposed_by", "pending_at",
    ]) {
      assert.equal(byName.get(column)?.notnull, 0, `${column} must be nullable`);
    }

    const tableDdl = ddl(db, "dependency_dispositions");
    for (const kind of ["keep", "replace-with-native", "inline"]) {
      assert.match(tableDdl, new RegExp(`'${kind}'`), `disposition CHECK is missing '${kind}'`);
    }
    assert.match(tableDdl, /CHECK\s*\(\s*disposition\s+IN\s*\('keep',\s*'replace-with-native',\s*'inline'\)\s*\)/i,
      "disposition CHECK constraint must enumerate exactly the three kinds");
    assert.match(tableDdl, /CHECK\s*\(\s*status\s+IN\s*\('proposed',\s*'confirmed'\)\s*\)/i,
      "status CHECK constraint must enumerate proposed/confirmed");
    assert.match(tableDdl, /CHECK\s*\(\s*pending_disposition\s+IN\s*\('keep',\s*'replace-with-native',\s*'inline'\)\s*\)/i,
      "pending_disposition CHECK constraint must enumerate exactly the three kinds");
    assert.match(tableDdl, /library_name\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i,
      "library_name must be NOT NULL UNIQUE (SC-001: one row per library)");
  } finally {
    db.close();
  }
});

test("a fresh registry ends with dependency_disposition_history carrying every contract column and CHECK", () => {
  const db = new Database(":memory:");
  try {
    applySchema(db);

    assert.ok(names(db, "table").includes("dependency_disposition_history"),
      "dependency_disposition_history table is missing");

    const historyColumns = columns(db, "dependency_disposition_history");
    assert.deepEqual(historyColumns.map((c) => c.name), HISTORY_COLUMNS);

    const byName = new Map(historyColumns.map((c) => [c.name, c]));
    assert.equal(byName.get("history_id")?.pk, 1);
    for (const column of ["disposition_id", "library_name", "snapshot_json", "change_kind", "change_actor", "superseded_at"]) {
      assert.equal(byName.get(column)?.notnull, 1, `${column} must be NOT NULL`);
    }

    const tableDdl = ddl(db, "dependency_disposition_history");
    assert.match(tableDdl, /CHECK\s*\(\s*change_kind\s+IN\s*\('propose',\s*'refine',\s*'confirm',\s*'override',\s*'auto-confirm',\s*'re-propose'\)\s*\)/i,
      "change_kind CHECK constraint must enumerate the six change kinds");
  } finally {
    db.close();
  }
});

test("the three disposition indexes exist and schema application is idempotent", () => {
  const db = new Database(":memory:");
  try {
    applySchema(db);
    for (const index of NEW_INDEXES) {
      assert.ok(names(db, "index").includes(index), `missing index ${index}`);
    }

    // Applying twice must remain idempotent.
    applySchema(db);
    assert.equal(columns(db, "dependency_dispositions").filter((c) => c.name === "library_name").length, 1);
    for (const index of NEW_INDEXES) {
      assert.ok(names(db, "index").includes(index), `index ${index} lost on re-apply`);
    }
  } finally {
    db.close();
  }
});
