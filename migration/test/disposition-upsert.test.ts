import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { listDispositions, upsertProposedDisposition } from "../registry/commands/dispositions";
import { applySchema } from "../registry/db/schema";
import { RegistryError } from "../registry/types";

/**
 * T007 — upsert/validation coverage for
 * specs/006-dependency-disposition/contracts/registry-schema.md's
 * commands-module API.
 */

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function historyFor(db: Database.Database, library: string) {
  return db.prepare(
    "SELECT change_kind, change_actor, snapshot_json FROM dependency_disposition_history WHERE library_name = ? ORDER BY superseded_at, rowid",
  ).all(library) as Array<{ change_kind: string; change_actor: string; snapshot_json: string }>;
}

const KEEP = {
  libraryName: "org.apache.commons:commons-lang3",
  currentVersion: "3.12.0",
  disposition: "keep" as const,
  lockedTargetVersion: "3.14.0",
  rationale: "Widely used across legacy services",
  proposedBy: "planner-collector",
};

test("upsertProposedDisposition INSERTs when no row exists (status=proposed, history propose)", () => {
  const db = createDb();
  try {
    const row = upsertProposedDisposition(db, KEEP);
    assert.equal(row.status, "proposed");
    assert.equal(row.disposition, "keep");
    assert.equal(row.library_name, KEEP.libraryName);
    assert.equal(row.proposed_by, "planner-collector");
    assert.equal(row.confirmed_by, null);

    const history = historyFor(db, KEEP.libraryName);
    assert.equal(history.length, 1);
    assert.equal(history[0]!.change_kind, "propose");
    assert.equal(history[0]!.change_actor, "planner-collector");
  } finally {
    db.close();
  }
});

test("upsertProposedDisposition UPDATEs proposal fields in place on a proposed row (history refine)", () => {
  const db = createDb();
  try {
    const first = upsertProposedDisposition(db, KEEP);
    const refined = upsertProposedDisposition(db, {
      ...KEEP,
      rationale: "Refined rationale with AST-level evidence",
      currentVersion: "3.13.0",
    });
    assert.equal(refined.status, "proposed");
    assert.equal(refined.rationale, "Refined rationale with AST-level evidence");
    assert.equal(refined.current_version, "3.13.0");
    assert.equal(refined.created_at, first.created_at, "same row — refined in place");

    const history = historyFor(db, KEEP.libraryName);
    assert.deepEqual(history.map((h) => h.change_kind), ["propose", "refine"]);
  } finally {
    db.close();
  }
});

test("replace-with-native without nativeReplacement is rejected", () => {
  const db = createDb();
  try {
    assert.throws(
      () => upsertProposedDisposition(db, {
        ...KEEP,
        disposition: "replace-with-native",
        rationale: "java.time supersedes",
      }),
      (err: unknown) => {
        assert.ok(err instanceof RegistryError);
        assert.match(err.message, /native/i);
        return true;
      },
    );
  } finally {
    db.close();
  }
});

test("inline without inlineNote is rejected", () => {
  const db = createDb();
  try {
    assert.throws(
      () => upsertProposedDisposition(db, {
        ...KEEP,
        disposition: "inline",
        rationale: "Two helper methods only",
      }),
      (err: unknown) => {
        assert.ok(err instanceof RegistryError);
        assert.match(err.message, /inline/i);
        return true;
      },
    );
  } finally {
    db.close();
  }
});

test("an empty rationale is rejected", () => {
  const db = createDb();
  try {
    assert.throws(
      () => upsertProposedDisposition(db, { ...KEEP, rationale: "   " }),
      (err: unknown) => {
        assert.ok(err instanceof RegistryError);
        assert.match(err.message, /rationale/i);
        return true;
      },
    );
  } finally {
    db.close();
  }
});

test("listDispositions returns rows ORDER BY library_name ASC, filterable by status and pendingOnly", () => {
  const db = createDb();
  try {
    upsertProposedDisposition(db, { ...KEEP, libraryName: "zeta:zlib" });
    upsertProposedDisposition(db, { ...KEEP, libraryName: "alpha:alib" });
    upsertProposedDisposition(db, { ...KEEP, libraryName: "mid:mlib" });

    const all = listDispositions(db);
    assert.deepEqual(all.map((r) => r.library_name), ["alpha:alib", "mid:mlib", "zeta:zlib"]);

    const proposed = listDispositions(db, { status: "proposed" });
    assert.equal(proposed.length, 3);
    assert.equal(listDispositions(db, { status: "confirmed" }).length, 0);

    // Plant a confirmed row carrying a pending re-proposal directly (US2 owns
    // the write path; here we only assert the read filter).
    db.prepare(`
      UPDATE dependency_dispositions
      SET status = 'confirmed', confirmed_by = 'operator', confirmed_at = datetime('now'),
          pending_disposition = 'replace-with-native', pending_native_replacement = 'java.util',
          pending_rationale = 're-run evidence', pending_proposed_by = 'planner-collector',
          pending_at = datetime('now')
      WHERE library_name = 'mid:mlib'
    `).run();

    const confirmed = listDispositions(db, { status: "confirmed" });
    assert.deepEqual(confirmed.map((r) => r.library_name), ["mid:mlib"]);

    const pendingOnly = listDispositions(db, { pendingOnly: true });
    assert.deepEqual(pendingOnly.map((r) => r.library_name), ["mid:mlib"]);
  } finally {
    db.close();
  }
});
