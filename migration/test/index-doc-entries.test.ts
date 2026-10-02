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

test("version change only supersedes the changed symbol, not every sibling entry at the old version", async () => {
  const { upsertDocumentationEntry } = await import("../index-db/commands/entries");
  const db = freshDb();
  seedRun(db, "run-old");
  upsertDocumentationEntry(db, { ...BASE, ingestionRunId: "run-old" });
  const sibling = {
    ...BASE,
    symbolName: "Preconditions#checkArgument",
    signature: "(boolean)",
    sourceExcerpt: "public static void checkArgument(boolean expression) — Ensures the truth of an expression.",
    ingestionRunId: "run-old",
  };
  upsertDocumentationEntry(db, sibling);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM documentation_entries WHERE library_version = '33.2.1-jre'").pluck().get(),
    2,
  );

  seedRun(db, "run-new");
  upsertDocumentationEntry(db, { ...BASE, libraryVersion: "33.3.0-jre", ingestionRunId: "run-new" });

  const remainingSibling = db
    .prepare(
      "SELECT COUNT(*) AS n FROM documentation_entries WHERE library_name = ? AND library_version = ? AND symbol_name = ?",
    )
    .pluck()
    .get(BASE.libraryName, "33.2.1-jre", sibling.symbolName) as number;
  assert.equal(remainingSibling, 1, "sibling symbol still documented at the old version must survive an unrelated version-supersede write");
});

test("version change supersedes multiple older versions in one cleanup (issue #299)", async () => {
  const { upsertDocumentationEntry } = await import("../index-db/commands/entries");
  const db = freshDb();
  seedRun(db, "run-a");
  upsertDocumentationEntry(db, { ...BASE, libraryVersion: "33.0.0-jre", ingestionRunId: "run-a" });
  // The write path itself never lets two versions of one symbol/signature
  // coexist (each new version supersedes the previous one), so a second
  // older-version row is seeded directly to simulate pre-existing rows the
  // superseding write must still collect.
  db.prepare(
    `INSERT INTO documentation_entries
       (entry_id, library_name, library_version, symbol_kind, symbol_name, signature, description, return_type, source_url, source_excerpt, ingestion_run_id, indexed_at)
     VALUES ('doc-legacy-33-2', ?, '33.2.1-jre', 'method', ?, ?, 'legacy row', NULL, 'https://example.test/legacy', 'verbatim legacy excerpt', 'run-b', datetime('now'))`,
  ).run(BASE.libraryName, BASE.symbolName, BASE.signature);
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS n FROM documentation_entries WHERE library_name = ? AND symbol_name = ?")
      .pluck()
      .get(BASE.libraryName, BASE.symbolName),
    2,
    "two prior versions of the symbol are indexed before the superseding write",
  );

  seedRun(db, "run-c");
  upsertDocumentationEntry(db, { ...BASE, libraryVersion: "33.3.0-jre", ingestionRunId: "run-c" });

  const remaining = (
    db
      .prepare(
        "SELECT DISTINCT library_version FROM documentation_entries WHERE library_name = ? AND symbol_name = ? ORDER BY library_version",
      )
      .all(BASE.libraryName, BASE.symbolName) as { library_version: string }[]
  ).map((r) => r.library_version);
  assert.deepEqual(
    remaining,
    ["33.3.0-jre"],
    "every prior version of the symbol must be superseded by the incoming write",
  );
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS n FROM documentation_entries WHERE library_name = ? AND library_version = ?")
      .pluck()
      .get(BASE.libraryName, "33.3.0-jre"),
    1,
  );
});

test("version change leaves a same-symbol overload (sibling signature) at the old version untouched (issue #299)", async () => {
  const { upsertDocumentationEntry } = await import("../index-db/commands/entries");
  const db = freshDb();
  seedRun(db, "run-old");
  upsertDocumentationEntry(db, { ...BASE, ingestionRunId: "run-old" });
  // Sibling SIGNATURE: same symbol, different overload, documented at the old
  // version. Supersession is scoped to the incoming normalized signature, so
  // the overload must survive the new version's write.
  const overload = {
    ...BASE,
    signature: "(java.lang.Object,int)",
    sourceExcerpt: "public static <T> T checkNotNull(T reference, Object errorMessage) — variant.",
    ingestionRunId: "run-old",
  };
  upsertDocumentationEntry(db, overload);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM documentation_entries WHERE library_version = '33.2.1-jre'").pluck().get(),
    2,
  );

  seedRun(db, "run-new");
  upsertDocumentationEntry(db, { ...BASE, libraryVersion: "33.3.0-jre", ingestionRunId: "run-new" });

  const remainingOverload = db
    .prepare(
      "SELECT COUNT(*) AS n FROM documentation_entries WHERE library_name = ? AND library_version = ? AND symbol_name = ? AND signature = ?",
    )
    .pluck()
    .get(BASE.libraryName, "33.2.1-jre", BASE.symbolName, "(java.lang.Object,int)") as number;
  assert.equal(
    remainingOverload,
    1,
    "a sibling signature at the old version is outside this symbol/signature supersession",
  );
});

test("class-kind supersession runs on the normalized (NULL) signature (issue #299)", async () => {
  const { upsertDocumentationEntry } = await import("../index-db/commands/entries");
  const db = freshDb();
  seedRun(db, "run-old");
  // A stray signature on a class entry normalizes to NULL for both the id and
  // the stored column — the superseding write must still match the old row.
  upsertDocumentationEntry(db, {
    ...BASE,
    symbolKind: "class",
    symbolName: "com.google.common.base.Preconditions",
    ingestionRunId: "run-old",
  });

  seedRun(db, "run-new");
  upsertDocumentationEntry(db, {
    ...BASE,
    symbolKind: "class",
    symbolName: "com.google.common.base.Preconditions",
    libraryVersion: "33.3.0-jre",
    ingestionRunId: "run-new",
  });

  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS n FROM documentation_entries WHERE library_version = '33.2.1-jre' AND symbol_kind = 'class'")
      .pluck()
      .get(),
    0,
    "old-version class row (signature normalized to NULL) must be superseded",
  );
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS n FROM documentation_entries WHERE library_version = '33.3.0-jre' AND symbol_kind = 'class'")
      .pluck()
      .get(),
    1,
  );
});

test("supersession matches a legacy empty-string signature row like NULL (COALESCE semantics, issue #299)", async () => {
  const { upsertDocumentationEntry } = await import("../index-db/commands/entries");
  const db = freshDb();
  seedRun(db, "run-old");
  upsertDocumentationEntry(db, { ...BASE, signature: null, ingestionRunId: "run-old" });
  // A pre-existing legacy row at the old version carrying an EMPTY-STRING
  // signature is equivalent under the COALESCE predicate and must be
  // superseded together with the NULL-signature row.
  db.prepare(
    `INSERT INTO documentation_entries
       (entry_id, library_name, library_version, symbol_kind, symbol_name, signature, description, return_type, source_url, source_excerpt, ingestion_run_id, indexed_at)
     VALUES ('doc-legacy-empty-sig', ?, ?, 'method', ?, '', 'legacy row', NULL, 'https://example.test/legacy', 'verbatim legacy excerpt', 'run-old', datetime('now'))`,
  ).run(BASE.libraryName, BASE.libraryVersion, BASE.symbolName);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM documentation_entries WHERE library_version = ?").pluck().get(BASE.libraryVersion),
    2,
  );

  seedRun(db, "run-new");
  upsertDocumentationEntry(db, { ...BASE, signature: null, libraryVersion: "33.3.0-jre", ingestionRunId: "run-new" });

  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM documentation_entries WHERE library_version = ?").pluck().get(BASE.libraryVersion),
    0,
    "both the NULL-signature and the empty-string-signature rows at the old version must be superseded",
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM documentation_entries WHERE library_version = '33.3.0-jre'").pluck().get(),
    1,
  );
});

test("supersession never deletes rows at the incoming version (incoming preservation, issue #299)", async () => {
  const { upsertDocumentationEntry } = await import("../index-db/commands/entries");
  const db = freshDb();
  seedRun(db, "run-old");
  upsertDocumentationEntry(db, { ...BASE, ingestionRunId: "run-old" });

  seedRun(db, "run-new");
  // A sibling overload of the SAME symbol already documented AT the incoming
  // version must survive the primary signature's superseding write.
  upsertDocumentationEntry(db, {
    ...BASE,
    libraryVersion: "33.3.0-jre",
    signature: "(java.lang.Object,int)",
    sourceExcerpt: "public static <T> T checkNotNull(T reference, Object errorMessage) — variant.",
    ingestionRunId: "run-new",
  });
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM documentation_entries WHERE library_version = '33.3.0-jre'").pluck().get(),
    1,
  );

  upsertDocumentationEntry(db, { ...BASE, libraryVersion: "33.3.0-jre", ingestionRunId: "run-new" });

  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM documentation_entries WHERE library_version = '33.3.0-jre'").pluck().get(),
    2,
    "the incoming version keeps both the new row and the pre-existing sibling overload",
  );
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS n FROM documentation_entries WHERE library_version = '33.2.1-jre' AND symbol_name = ?")
      .pluck()
      .get(BASE.symbolName),
    0,
    "the old-version row is still superseded",
  );
});

test("explicit supersedesVersion stays accepted and compatible: naming the prior version still ends with its rows gone, siblings untouched (issue #299)", async () => {
  const { upsertDocumentationEntry } = await import("../index-db/commands/entries");
  const db = freshDb();
  seedRun(db, "run-old");
  upsertDocumentationEntry(db, { ...BASE, ingestionRunId: "run-old" });
  seedRun(db, "run-sibling");
  upsertDocumentationEntry(db, {
    ...BASE,
    symbolName: "Preconditions#checkState",
    signature: "(boolean)",
    sourceExcerpt: "public static void checkState(boolean expression) — Ensures the truth of an expression.",
    ingestionRunId: "run-sibling",
  });

  seedRun(db, "run-new");
  const written = upsertDocumentationEntry(db, {
    ...BASE,
    libraryVersion: "33.3.0-jre",
    ingestionRunId: "run-new",
    supersedesVersion: "33.2.1-jre",
  });
  assert.match(written.entry_id, /^doc-[0-9a-f]{12}$/);

  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS n FROM documentation_entries WHERE library_version = '33.2.1-jre' AND symbol_name = ?")
      .pluck()
      .get(BASE.symbolName),
    0,
    "the explicitly named prior version's rows are deleted",
  );
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS n FROM documentation_entries WHERE library_version = '33.2.1-jre' AND symbol_name = 'Preconditions#checkState'")
      .pluck()
      .get(),
    1,
    "sibling symbols at the superseded version remain untouched",
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM documentation_entries WHERE library_version = '33.3.0-jre'").pluck().get(),
    1,
  );
});

test("explicit supersedesVersion equal to the incoming version remains a no-op on incoming rows (issue #299)", async () => {
  const { upsertDocumentationEntry } = await import("../index-db/commands/entries");
  const db = freshDb();
  seedRun(db, "run-v");
  upsertDocumentationEntry(db, BASE);
  const written = upsertDocumentationEntry(db, {
    ...BASE,
    description: "Updated description.",
    supersedesVersion: BASE.libraryVersion,
  });

  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS n FROM documentation_entries WHERE library_version = ?")
      .pluck()
      .get(BASE.libraryVersion),
    1,
    "self-referential supersedesVersion must not delete the incoming version's row",
  );
  const row = db.prepare("SELECT description FROM documentation_entries WHERE entry_id = ?").get(written.entry_id) as {
    description: string;
  };
  assert.equal(row.description, "Updated description.", "the upsert still applies the content update");
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
