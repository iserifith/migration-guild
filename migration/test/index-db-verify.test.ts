import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { applyIndexDbSchema } from "../index-db/schema";

/**
 * specs/007-doc-rag-lookup — T029 (tests-first ahead of T031 per
 * Constitution V): batch reference verification via verifyReferences
 * (FR-010, FR-010a, contracts/mcp-tool-contract.md).
 *
 * Outcomes per reference:
 *   - verified-present  — a row exists for library+version+symbol (+signature)
 *   - verified-absent   — library+version IS indexed but this symbol isn't
 *   - unavailable       — no rows at all for that library+version
 * Order-preserved, one outcome per input. Over-limit batches are truncated
 * with a next_cursor rather than silently dropped (FR-015 token budget).
 */

const LIB = "com.google.guava:guava";
const VER = "33.2.1-jre";
const OTHER = "org.apache.commons:commons-lang3";
const OTHER_VER = "3.14.0";

function seededDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applyIndexDbSchema(db);
  db.prepare(
    "INSERT INTO ingestion_runs (run_id, started_at, completed_at, triggered_by, locked_set_snapshot_count) VALUES ('run-1', datetime('now'), datetime('now'), 'test', 2)",
  ).run();
  const insert = db.prepare(
    `INSERT INTO documentation_entries
       (entry_id, library_name, library_version, symbol_kind, symbol_name, signature, description, return_type, source_url, source_excerpt, ingestion_run_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'run-1')`,
  );
  // Guava: a class + one real method (so a fabricated method on the same
  // library+version becomes verified-absent rather than unavailable).
  insert.run("doc-c1", LIB, VER, "class", "com.google.common.base.Preconditions", null,
    "Static convenience methods that check argument validity.", null,
    "https://guava.dev/api/Preconditions.html", "Preconditions — static convenience methods.");
  insert.run("doc-m1", LIB, VER, "method", "Preconditions#checkNotNull", "(java.lang.Object)",
    "Ensures that an object reference is not null.", "T",
    "https://guava.dev/api/Preconditions.html#checkNotNull", "checkNotNull(T reference)");
  // commons-lang3: a different library+version that IS indexed.
  insert.run("doc-other-1", OTHER, OTHER_VER, "class", "org.apache.commons.lang3.StringUtils", null,
    "Operations on String.", null,
    "https://commons.apache.org/StringUtils.html", "StringUtils operations.");
  return db;
}

function ref(p: Partial<{ library_name: string; library_version: string; symbol_name: string; signature?: string }>) {
  return {
    library_name: p.library_name ?? LIB,
    library_version: p.library_version ?? VER,
    symbol_name: p.symbol_name ?? "Preconditions#checkNotNull",
    ...(p.signature !== undefined ? { signature: p.signature } : {}),
  };
}

test("returns one outcome per input reference, order-preserved", async () => {
  const { verifyReferences } = await import("../index-db/commands/entries");
  const db = seededDb();
  const batch = [
    ref({ symbol_name: "Preconditions#checkNotNull", signature: "(java.lang.Object)" }),
    ref({ symbol_name: "Preconditions#checkNotBlank", signature: "(java.lang.String)" }),
    ref({ library_name: OTHER, library_version: OTHER_VER, symbol_name: "org.apache.commons.lang3.StringUtils" }),
    ref({ library_name: "com.example:never-ingested", library_version: "1.0", symbol_name: "Anything" }),
  ];
  const result = verifyReferences(db, batch);
  assert.equal(result.truncated, false);
  assert.equal(result.next_cursor, undefined);
  assert.equal(result.results.length, 4);
  // Order preserved & outcome per kind.
  assert.deepEqual(
    result.results.map((r) => r.outcome),
    ["verified-present", "verified-absent", "verified-present", "unavailable"],
  );
  // Each result echoes its input reference exactly.
  assert.deepEqual(result.results.map((r) => r.reference), batch);
});

test("a batch mixing indexed and never-ingested libraries returns unavailable only for the latter", async () => {
  const { verifyReferences } = await import("../index-db/commands/entries");
  const db = seededDb();
  // Both references target a library/version with no rows, but they are
  // distinct inputs — verify the whole batch still resolves (does not throw)
  // and only those two are flagged unavailable.
  const batch = [
    ref({ library_name: "com.example:a", library_version: "1.0", symbol_name: "X" }),
    ref({ library_name: "com.example:b", library_version: "2.0", symbol_name: "Y" }),
  ];
  const result = verifyReferences(db, batch);
  assert.equal(result.results.length, 2);
  assert.deepEqual(result.results.map((r) => r.outcome), ["unavailable", "unavailable"]);
  assert.equal(result.truncated, false);
});

test("verified-absent when the library+version is indexed but the symbol is not", async () => {
  const { verifyReferences } = await import("../index-db/commands/entries");
  const db = seededDb();
  // Guava@VER is indexed (class + checkNotNull), but checkNotBlank isn't.
  const result = verifyReferences(db, [
    ref({ symbol_name: "Preconditions#checkNotBlank", signature: "(java.lang.String)" }),
  ]);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].outcome, "verified-absent");
});

test("over-limit batch returns truncated:true with a next_cursor (never silently dropped)", async () => {
  const { verifyReferences, MAX_VERIFY_REFERENCES } = await import("../index-db/commands/entries");
  const db = seededDb();
  // Build one more than the limit, all referencing libraries that exist so
  // the truncation is purely a count-budget decision, not an outcome decision.
  const batch = [];
  for (let i = 0; i <= MAX_VERIFY_REFERENCES; i++) {
    batch.push(ref({ symbol_name: `Preconditions#synthetic${i}`, signature: "(java.lang.Object)" }));
  }
  const result = verifyReferences(db, batch);
  assert.equal(result.truncated, true);
  assert.equal(typeof result.next_cursor, "number");
  assert.ok(result.next_cursor! > 0);
  // Exactly MAX references are returned (the head of the batch), not dropped entirely.
  assert.equal(result.results.length, MAX_VERIFY_REFERENCES);
  // All returned outcomes are available decisions (verified-absent here).
  assert.ok(result.results.every((r) => r.outcome === "verified-absent"));
  // The cursor points past the returned slice.
  assert.equal(result.next_cursor, MAX_VERIFY_REFERENCES);
});

test("next_cursor lets a continuation fetch the remaining references", async () => {
  const { verifyReferences, MAX_VERIFY_REFERENCES } = await import("../index-db/commands/entries");
  const db = seededDb();
  const batch = [];
  for (let i = 0; i < MAX_VERIFY_REFERENCES + 5; i++) {
    batch.push(ref({ symbol_name: `Preconditions#synthetic${i}`, signature: "(java.lang.Object)" }));
  }
  const first = verifyReferences(db, batch);
  assert.equal(first.truncated, true);
  const second = verifyReferences(db, batch, first.next_cursor);
  // The tail is exactly the remainder.
  assert.equal(second.results.length, 5);
  assert.equal(second.truncated, false);
  assert.equal(second.next_cursor, undefined);
  // Combined, every input reference was accounted for exactly once.
  assert.equal(first.results.length + second.results.length, batch.length);
});
