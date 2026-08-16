import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { applyIndexDbSchema } from "../index-db/schema";

/**
 * specs/007-doc-rag-lookup — T024 (tests-first ahead of T026–T028 per
 * Constitution V): exact symbol lookup via lookupLibraryDoc (FR-002,
 * FR-011, contracts/mcp-tool-contract.md).
 */

const LIB = "com.google.guava:guava";
const VER = "33.2.1-jre";

function seededDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applyIndexDbSchema(db);
  db.prepare(
    "INSERT INTO ingestion_runs (run_id, started_at, completed_at, triggered_by, locked_set_snapshot_count) VALUES ('run-1', datetime('now'), datetime('now'), 'test', 1)",
  ).run();
  const insert = db.prepare(
    `INSERT INTO documentation_entries
       (entry_id, library_name, library_version, symbol_kind, symbol_name, signature, description, return_type, source_url, source_excerpt, ingestion_run_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'run-1')`,
  );
  insert.run("doc-c1", LIB, VER, "class", "com.google.common.base.Preconditions", null,
    "Static convenience methods that check argument validity.", null,
    "https://guava.dev/api/Preconditions.html", "Preconditions — static convenience methods.", );
  insert.run("doc-m1", LIB, VER, "method", "Preconditions#checkNotNull", "(java.lang.Object)",
    "Ensures that an object reference is not null.", "T",
    "https://guava.dev/api/Preconditions.html#checkNotNull", "checkNotNull(T reference)");
  insert.run("doc-m2", LIB, VER, "method", "Preconditions#checkNotNull", "(java.lang.Object,java.lang.Object)",
    "Ensures that an object reference is not null, with an error message.", "T",
    "https://guava.dev/api/Preconditions.html#checkNotNull-msg", "checkNotNull(T reference, Object errorMessage)");
  // Same symbol, older version — must never be returned for VER queries.
  insert.run("doc-m9", LIB, "32.0.0-jre", "method", "Preconditions#checkNotNull", "(java.lang.Object)",
    "STALE copy from the previous version.", "T",
    "https://guava.dev/old/Preconditions.html", "checkNotNull(T reference)");
  return db;
}

test("class lookup returns found with contract payload fields", async () => {
  const { lookupLibraryDoc } = await import("../mcp-doc-server/queries");
  const result = lookupLibraryDoc(seededDb(), {
    library_name: LIB, library_version: VER, symbol_kind: "class",
    symbol_name: "com.google.common.base.Preconditions",
  });
  assert.equal(result.status, "found");
  if (result.status !== "found") return;
  assert.ok(typeof result.entry.description === "string" && result.entry.description.length > 0);
  assert.ok(typeof result.entry.source_url === "string" && result.entry.source_url.length > 0);
  assert.deepEqual(result.entry.chunk, { index: 0, of: 1 });
});

test("method lookup with matching signature returns found (FR-011 overload disambiguation)", async () => {
  const { lookupLibraryDoc } = await import("../mcp-doc-server/queries");
  const result = lookupLibraryDoc(seededDb(), {
    library_name: LIB, library_version: VER, symbol_kind: "method",
    symbol_name: "Preconditions#checkNotNull", signature: "(java.lang.Object,java.lang.Object)",
  });
  assert.equal(result.status, "found");
  if (result.status !== "found") return;
  assert.match(String(result.entry.description), /error message/);
  assert.equal(result.entry.return_type, "T");
});

test("method lookup with a signature that isn't indexed returns not_found", async () => {
  const { lookupLibraryDoc } = await import("../mcp-doc-server/queries");
  const result = lookupLibraryDoc(seededDb(), {
    library_name: LIB, library_version: VER, symbol_kind: "method",
    symbol_name: "Preconditions#checkNotNull", signature: "(java.lang.Object,java.lang.String)",
  });
  assert.equal(result.status, "not_found");
});

test("an indexed library with no such symbol returns not_found (distinct from unavailable)", async () => {
  const { lookupLibraryDoc } = await import("../mcp-doc-server/queries");
  const result = lookupLibraryDoc(seededDb(), {
    library_name: LIB, library_version: VER, symbol_kind: "class",
    symbol_name: "com.google.common.base.DoesNotExist",
  });
  assert.equal(result.status, "not_found");
});

test("a library/version with no indexed rows returns unavailable with a reason", async () => {
  const { lookupLibraryDoc } = await import("../mcp-doc-server/queries");
  const result = lookupLibraryDoc(seededDb(), {
    library_name: "com.example:never-ingested", library_version: "1.0",
    symbol_kind: "class", symbol_name: "Anything",
  });
  assert.equal(result.status, "unavailable");
  if (result.status !== "unavailable") return;
  assert.ok(result.reason.length > 0);
});

test("exact lookup never crosses versions (FR-002, SC-002)", async () => {
  const { lookupLibraryDoc } = await import("../mcp-doc-server/queries");
  const db = seededDb();
  // Query the stale version: it IS indexed (seeded above), so found is fine…
  const stale = lookupLibraryDoc(db, {
    library_name: LIB, library_version: "32.0.0-jre", symbol_kind: "method",
    symbol_name: "Preconditions#checkNotNull", signature: "(java.lang.Object)",
  });
  assert.equal(stale.status, "found");
  if (stale.status !== "found") return;
  assert.match(String(stale.entry.description), /STALE/);
  // …but the new version's lookup must return ITS row, never the stale one.
  const current = lookupLibraryDoc(db, {
    library_name: LIB, library_version: VER, symbol_kind: "method",
    symbol_name: "Preconditions#checkNotNull", signature: "(java.lang.Object)",
  });
  assert.equal(current.status, "found");
  if (current.status !== "found") return;
  assert.doesNotMatch(String(current.entry.description), /STALE/);
  assert.match(String(current.entry.source_url), /Preconditions\.html#checkNotNull$/);
});

test("malformed input throws DocLookupValidationError (mapped to an MCP tool error, never not_found)", async () => {
  const { lookupLibraryDoc } = await import("../mcp-doc-server/queries");
  const { DocLookupValidationError } = await import("../mcp-doc-server/server");
  const db = seededDb();

  assert.throws(
    () => lookupLibraryDoc(db, { library_name: "", library_version: VER, symbol_kind: "class", symbol_name: "X" }),
    (e: unknown) => e instanceof DocLookupValidationError,
  );
  assert.throws(
    () => lookupLibraryDoc(db, { library_name: LIB, library_version: VER, symbol_kind: "module", symbol_name: "X" }),
    (e: unknown) => e instanceof DocLookupValidationError && /symbol_kind/.test((e as Error).message),
  );
  // FR-011: signature required for method lookups.
  assert.throws(
    () => lookupLibraryDoc(db, { library_name: LIB, library_version: VER, symbol_kind: "method", symbol_name: "Preconditions#checkNotNull" }),
    (e: unknown) => e instanceof DocLookupValidationError && /signature/.test((e as Error).message),
  );
});
