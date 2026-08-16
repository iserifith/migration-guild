import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { applyIndexDbSchema } from "../index-db/schema";

/**
 * specs/007-doc-rag-lookup — T025 (tests-first ahead of T026–T028):
 * FTS5 search via searchLibraryDocs (FR-002a, contracts/mcp-tool-contract.md,
 * quickstart Scenario 4).
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
  insert.run("doc-m1", LIB, VER, "method", "Preconditions#checkNotNull", "(java.lang.Object)",
    "Ensures that an object reference passed as a parameter to the calling method is not null; throws NullPointerException on a null argument.",
    "T", "https://guava.dev/api/Preconditions.html#checkNotNull", "checkNotNull(T reference)");
  insert.run("doc-m2", LIB, VER, "method", "Preconditions#checkArgument", "(boolean)",
    "Ensures the truth of an expression involving one or more parameters to the calling method.",
    "void", "https://guava.dev/api/Preconditions.html#checkArgument", "checkArgument(boolean expression)");
  insert.run("doc-m3", LIB, VER, "class", "com.google.common.collect.ImmutableList",
    null, "A high-performance, immutable, random-access list implementation.",
    null, "https://guava.dev/api/ImmutableList.html", "ImmutableList — immutable random-access list.");
  return db;
}

test("a behavior-description query ranks the relevant symbol in the top candidates (quickstart Scenario 4)", async () => {
  const { searchLibraryDocs } = await import("../mcp-doc-server/queries");
  const result = searchLibraryDocs(seededDb(), {
    library_name: LIB, library_version: VER, query: "argument null check", limit: 5,
  });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.ok(result.candidates.length > 0);
  const top = result.candidates.slice(0, 2).map((c) => c.symbol_name);
  assert.ok(
    top.some((s) => s.startsWith("Preconditions#check")),
    `expected a Preconditions#check* method in the top candidates, got ${JSON.stringify(top)}`,
  );
  for (const c of result.candidates) {
    assert.ok(typeof c.snippet === "string");
    assert.equal(typeof c.rank, "number");
  }
});

test("search against a library/version with no indexed rows returns empty (never an error)", async () => {
  const { searchLibraryDocs } = await import("../mcp-doc-server/queries");
  const result = searchLibraryDocs(seededDb(), {
    library_name: LIB, library_version: "99.0.0-not-ingested", query: "argument null check",
  });
  assert.equal(result.status, "empty");
});

test("a query with no matching terms returns status empty, distinct from lookup's not_found", async () => {
  const { searchLibraryDocs } = await import("../mcp-doc-server/queries");
  const result = searchLibraryDocs(seededDb(), {
    library_name: LIB, library_version: VER, query: "zqxwv nonexistentterm",
  });
  assert.equal(result.status, "empty");
});

test("search is scoped to the requested library+version only", async () => {
  const { searchLibraryDocs } = await import("../mcp-doc-server/queries");
  const db = seededDb();
  // Another library entirely must not leak into guava's scoped results.
  db.prepare(
    `INSERT INTO documentation_entries
       (entry_id, library_name, library_version, symbol_kind, symbol_name, description, source_url, source_excerpt, ingestion_run_id)
     VALUES ('doc-x1', 'org.other:lib', '1.0', 'method', 'Other#checkNotNull', 'Ensures argument is not null', 'https://x.test', 'excerpt', 'run-1')`,
  ).run();
  const result = searchLibraryDocs(db, {
    library_name: LIB, library_version: VER, query: "argument not null", limit: 10,
  });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.ok(result.candidates.every((c) => !String(c.symbol_name).startsWith("Other#")), "results must stay within the library+version scope");
});

test("malformed search input throws DocLookupValidationError", async () => {
  const { searchLibraryDocs } = await import("../mcp-doc-server/queries");
  const { DocLookupValidationError } = await import("../mcp-doc-server/server");
  assert.throws(
    () => searchLibraryDocs(seededDb(), { library_name: LIB, library_version: VER, query: "" }),
    (e: unknown) => e instanceof DocLookupValidationError,
  );
});
