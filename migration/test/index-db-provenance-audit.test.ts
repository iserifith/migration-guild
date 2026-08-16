import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { applyIndexDbSchema } from "../index-db/schema";
import { upsertDocumentationEntry, IndexDbError } from "../index-db/commands/entries";

/**
 * specs/007-doc-rag-lookup — T037 (SC-009 provenance-completeness audit).
 *
 * After a fixture ingestion run writes several documentation_entries rows via
 * the real `upsertDocumentationEntry` write path, this audit performs a DIRECT
 * SQL scan over every row in `documentation_entries` and asserts that NONE has
 * an empty/null `source_url` or `source_excerpt`.
 *
 * Why a global scan rather than relying on the per-call rejection test (which
 * already lives in index-doc-entries.test.ts): the per-call test only proves a
 * single rejected call doesn't write. It does NOT guard against a FUTURE write
 * path added outside `upsertDocumentationEntry` (e.g. a bulk import, a
 * migration, a direct INSERT in a new command) silently reintroducing
 * unsourced rows. A full-table audit is the only thing that catches that class
 * of regression — it fails the moment any row in the table lacks provenance,
 * regardless of which code path wrote it.
 */

const GUAVA = "com.google.guava:guava";
const GUAVA_VER = "33.2.1-jre";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applyIndexDbSchema(db);
  db.prepare(
    "INSERT INTO ingestion_runs (run_id, started_at, triggered_by, locked_set_snapshot_count) VALUES ('run-audit', datetime('now'), 'operator', 1)",
  ).run();
  return db;
}

interface SeedSpec {
  symbolKind: "class" | "method";
  symbolName: string;
  signature?: string;
  description: string;
  sourceUrl: string;
  sourceExcerpt: string;
}

const SEEDS: SeedSpec[] = [
  {
    symbolKind: "method", symbolName: "Preconditions#checkNotNull", signature: "(java.lang.Object)",
    description: "Ensures the object reference passed as a parameter is not null.",
    sourceUrl: "https://guava.dev/api/Preconditions.html#checkNotNull",
    sourceExcerpt: "checkNotNull(T reference)",
  },
  {
    symbolKind: "method", symbolName: "Preconditions#checkArgument", signature: "(boolean)",
    description: "Ensures the truth of an expression passed as a parameter.",
    sourceUrl: "https://guava.dev/api/Preconditions.html#checkArgument",
    sourceExcerpt: "checkArgument(boolean)",
  },
  {
    symbolKind: "class", symbolName: "com.google.common.collect.ImmutableList",
    description: "An immutable, random-access list implementation.",
    sourceUrl: "https://guava.dev/api/ImmutableList.html",
    sourceExcerpt: "ImmutableList — immutable list.",
  },
  {
    symbolKind: "class", symbolName: "com.google.common.base.Splitter",
    description: "Splits strings into substrings on a separator.",
    sourceUrl: "https://guava.dev/api/Splitter.html",
    sourceExcerpt: "Splitter — split a string.",
  },
];

test("SC-009: every row written through upsertDocumentationEntry carries non-empty source_url and source_excerpt (full-table audit)", () => {
  const db = freshDb();
  for (const s of SEEDS) {
    upsertDocumentationEntry(db, {
      libraryName: GUAVA,
      libraryVersion: GUAVA_VER,
      symbolKind: s.symbolKind,
      symbolName: s.symbolName,
      signature: s.signature,
      description: s.description,
      sourceUrl: s.sourceUrl,
      sourceExcerpt: s.sourceExcerpt,
      ingestionRunId: "run-audit",
    });
  }

  const rows = db
    .prepare("SELECT entry_id, source_url, source_excerpt FROM documentation_entries")
    .all() as { entry_id: string; source_url: string; source_excerpt: string }[];

  assert.equal(rows.length, SEEDS.length, "all seeded entries should have been written");

  const unsourced = rows.filter(
    (r) => !r.source_url || !r.source_url.trim() || !r.source_excerpt || !r.source_excerpt.trim(),
  );
  assert.deepEqual(
    unsourced,
    [],
    `every documentation_entries row must have non-empty provenance; offending rows: ${JSON.stringify(unsourced)}`,
  );
  // Also assert the columns are present and non-null (defensive against a schema drift).
  for (const r of rows) {
    assert.ok(r.source_url && r.source_excerpt, `row ${r.entry_id} must have both provenance fields`);
  }
});

test("SC-009: a write path that omits provenance must be rejected before any row is written (regression guard for the write invariant)", () => {
  const db = freshDb();
  assert.throws(
    () =>
      upsertDocumentationEntry(db, {
        libraryName: GUAVA,
        libraryVersion: GUAVA_VER,
        symbolKind: "class",
        symbolName: "com.google.common.base.Preconditions",
        description: "Convenience methods for precondition checking.",
        sourceUrl: "  ", // empty/blank provenance must be rejected
        sourceExcerpt: "excerpt",
        ingestionRunId: "run-audit",
      }),
    (e: unknown) => e instanceof IndexDbError,
  );
  const n = db.prepare("SELECT COUNT(*) AS n FROM documentation_entries").pluck().get() as number;
  assert.equal(n, 0, "a rejected write must leave the table empty");

  // Direct SQL scan confirms zero unsourced rows even after the rejected attempt.
  const unsourced = db
    .prepare("SELECT COUNT(*) AS n FROM documentation_entries WHERE source_url IS NULL OR source_url = '' OR source_excerpt IS NULL OR source_excerpt = ''")
    .pluck().get() as number;
  assert.equal(unsourced, 0);
});
