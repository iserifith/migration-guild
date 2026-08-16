#!/usr/bin/env node
/**
 * specs/007-doc-rag-lookup — T035 quickstart verification script.
 *
 * Exercises quickstart.md Scenarios 1, 2, 3, 4, 6 programmatically against the
 * REAL index-db write/read queries and the registry CLI write path — NO
 * `opencode`, NO network, NO Java scratch workspace required (those are only
 * needed for the live ingestion Scenario 1/6 runs and Scenario 5's real
 * agent-dispatch, which remain environment-gated).
 *
 * Scenario 5 (batch verification catching a fabricated call) is exercised here
 * through the real `verifyReferences` compute, since the verify tool itself is
 * already implemented and does not need an agent to invoke it.
 *
 * Usage (after `npm run build` in migration/):
 *   node scripts/verify-quickstart.mjs [path/to/scratch/index.db]
 *
 * Exit code 0 = all scenarios PASS; non-zero = at least one FAIL.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distRoot = path.resolve(__dirname, "..", "dist");

const {
  upsertDocumentationEntry,
  verifyReferences,
  IndexDbError,
} = await import(path.join(distRoot, "index-db", "commands", "entries.js"));
const { applyIndexDbSchema } = await import(path.join(distRoot, "index-db", "schema.js"));
const { searchLibraryDocs, lookupLibraryDoc } = await import(
  path.join(distRoot, "mcp-doc-server", "queries.js")
);
const Database = (await import("better-sqlite3")).default;

const LIB = "com.google.guava:guava";
const VER = "33.2.1-jre";
const NEW_VER = "33.3.0-jre"; // a bumped-but-not-ingested version for Scenario 3.

const results = [];
function scenario(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, error: err });
    console.log(`  FAIL  ${name}: ${err && err.message ? err.message : err}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

function seededDb(dbPath) {
  fs.rmSync(dbPath, { force: true });
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  applyIndexDbSchema(db);
  db.prepare(
    "INSERT INTO ingestion_runs (run_id, started_at, triggered_by, locked_set_snapshot_count) VALUES ('run-qs', datetime('now'), 'operator', 1)",
  ).run();

  upsertDocumentationEntry(db, {
    libraryName: LIB, libraryVersion: VER, symbolKind: "method",
    symbolName: "Preconditions#checkNotNull", signature: "(java.lang.Object)",
    description: "Ensures the object reference passed as a parameter is not null.",
    sourceUrl: "https://guava.dev/api/Preconditions.html#checkNotNull",
    sourceExcerpt: "checkNotNull(T reference)", ingestionRunId: "run-qs",
  });
  upsertDocumentationEntry(db, {
    libraryName: LIB, libraryVersion: VER, symbolKind: "method",
    symbolName: "Preconditions#checkArgument", signature: "(boolean)",
    description: "Ensures the truth of an expression passed as a parameter.",
    sourceUrl: "https://guava.dev/api/Preconditions.html#checkArgument",
    sourceExcerpt: "checkArgument(boolean)", ingestionRunId: "run-qs",
  });
  upsertDocumentationEntry(db, {
    libraryName: LIB, libraryVersion: VER, symbolKind: "class",
    symbolName: "com.google.common.collect.ImmutableList",
    description: "An immutable, random-access list implementation.",
    sourceUrl: "https://guava.dev/api/ImmutableList.html",
    sourceExcerpt: "ImmutableList — immutable list.", ingestionRunId: "run-qs",
  });
  return db;
}

console.log("007-doc-rag-lookup quickstart verification (scripted; opencode/network env-gated)\n");

const scratchDb = process.argv[2] || path.join(os.tmpdir(), `quickstart-${Date.now()}.db`);
const db = seededDb(scratchDb);

// Scenario 1 — ingestion populates the index for exactly the locked keep set,
// every row carries provenance (FR-003a).
scenario("Scenario 1: ingested entries carry non-empty source_url + source_excerpt", () => {
  const rows = db
    .prepare("SELECT entry_id, source_url, source_excerpt FROM documentation_entries")
    .all();
  assert(rows.length === 3, `expected 3 ingested rows, got ${rows.length}`);
  for (const r of rows) {
    assert(r.source_url && r.source_url.trim(), `row ${r.entry_id} missing source_url`);
    assert(r.source_excerpt && r.source_excerpt.trim(), `row ${r.entry_id} missing source_excerpt`);
  }
});

// Scenario 2 — ingestion-time hallucination structurally blocked: a write
// missing provenance is rejected before any row is written.
scenario("Scenario 2: write path rejects an entry missing provenance", () => {
  const before = db.prepare("SELECT COUNT(*) AS n FROM documentation_entries").pluck().get();
  assert.throws(
    () =>
      upsertDocumentationEntry(db, {
        libraryName: LIB, libraryVersion: VER, symbolKind: "class",
        symbolName: "com.google.common.base.Preconditions",
        description: "Convenience methods for precondition checking.",
        sourceUrl: "  ", sourceExcerpt: "excerpt", ingestionRunId: "run-qs",
      }),
    (e) => e instanceof IndexDbError,
  );
  const after = db.prepare("SELECT COUNT(*) AS n FROM documentation_entries").pluck().get();
  assert(before === after, "rejected write must not add a row");
});

// Scenario 3 — exact lookup never crosses versions.
scenario("Scenario 3: lookup for an un-ingested bumped version returns unavailable/not_found", () => {
  const res = lookupLibraryDoc(db, {
    library_name: LIB, library_version: NEW_VER, symbol_kind: "method",
    symbol_name: "Preconditions#checkNotNull", signature: "(java.lang.Object)",
  });
  assert(
    res.status === "unavailable" || res.status === "not_found",
    `expected unavailable/not_found for un-ingested version, got ${res.status}`,
  );
  // The ingested version still resolves to found.
  const found = lookupLibraryDoc(db, {
    library_name: LIB, library_version: VER, symbol_kind: "method",
    symbol_name: "Preconditions#checkNotNull", signature: "(java.lang.Object)",
  });
  assert(found.status === "found", `ingested version should be found, got ${found.status}`);
});

// Scenario 4 — search finds a symbol the agent doesn't know by name.
scenario("Scenario 4: behavior-description search ranks the right method in top results", () => {
  const res = searchLibraryDocs(db, {
    library_name: LIB, library_version: VER, query: "argument null check", limit: 5,
  });
  assert(res.status === "ok", `search should return ok, got ${res.status}`);
  const top = res.candidates.slice(0, 3).map((c) => c.symbol_name);
  assert(
    top.some((s) => s.startsWith("Preconditions#check")),
    `expected a Preconditions#check* method in top 3, got ${JSON.stringify(top)}`,
  );
});

// Scenario 5 — batch verification catches a fabricated call without penalizing
// the real one (uses the real verifyReferences compute).
scenario("Scenario 5: verify_library_docs flags fabricated ref, verifies real one", () => {
  const out = verifyReferences(db, [
    { library_name: LIB, library_version: VER, symbol_kind: "method", symbol_name: "Preconditions#checkNotNull", signature: "(java.lang.Object)" },
    { library_name: LIB, library_version: VER, symbol_kind: "method", symbol_name: "Preconditions#checkNotBlank", signature: "(java.lang.String)" },
  ]);
  assert(out.results.length === 2, "expected one outcome per reference");
  assert(out.results[0].outcome === "verified-present", `real ref should be verified-present, got ${out.results[0].outcome}`);
  assert(out.results[1].outcome === "verified-absent", `fabricated ref should be verified-absent, got ${out.results[1].outcome}`);
});

// Scenario 6 — idempotent re-run and per-library failure isolation.
scenario("Scenario 6: re-ingesting unchanged entries is idempotent (no new rows)", () => {
  const before = db.prepare("SELECT COUNT(*) AS n FROM documentation_entries").pluck().get();
  // Re-run the same writes (simulating ingest-docs re-run with no version change).
  upsertDocumentationEntry(db, {
    libraryName: LIB, libraryVersion: VER, symbolKind: "method",
    symbolName: "Preconditions#checkNotNull", signature: "(java.lang.Object)",
    description: "Ensures the object reference passed as a parameter is not null.",
    sourceUrl: "https://guava.dev/api/Preconditions.html#checkNotNull",
    sourceExcerpt: "checkNotNull(T reference)", ingestionRunId: "run-qs",
  });
  const after = db.prepare("SELECT COUNT(*) AS n FROM documentation_entries").pluck().get();
  assert(before === after, `idempotent re-run must not add rows (before=${before}, after=${after})`);
});

db.close();
fs.rmSync(scratchDb, { force: true });
fs.rmSync(`${scratchDb}-wal`, { force: true });
fs.rmSync(`${scratchDb}-shm`, { force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} scenarios PASS`);
process.exit(failed.length === 0 ? 0 : 1);
