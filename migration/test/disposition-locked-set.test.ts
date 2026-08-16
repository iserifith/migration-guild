import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import {
  confirmDisposition,
  getLockedDependencySet,
  upsertProposedDisposition,
} from "../registry/commands/dispositions";
import { applySchema } from "../registry/db/schema";

/**
 * T024 — getLockedDependencySet determinism + content coverage for
 * specs/006-dependency-disposition (FR-009/FR-011, quickstart Scenario 5,
 * data-model.md Entity 3).
 */

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function seedConfirmed(db: Database.Database): void {
  // Proposed out of alphabetical order on purpose — the locked set must still
  // come back ORDER BY library_name ASC.
  upsertProposedDisposition(db, {
    libraryName: "org.apache.commons:commons-lang3",
    currentVersion: "3.12.0",
    disposition: "replace-with-native",
    nativeReplacement: "java.lang.String / java.util.Objects",
    rationale: "Helper methods have direct JDK equivalents",
    proposedBy: "planner-collector",
  });
  confirmDisposition(db, { libraryName: "org.apache.commons:commons-lang3", confirmedBy: "operator" });

  upsertProposedDisposition(db, {
    libraryName: "joda-time:joda-time",
    currentVersion: "2.10.14",
    disposition: "keep",
    lockedTargetVersion: "2.12.7",
    rationale: "Date math too entangled to replace in v1",
    proposedBy: "planner-collector",
  });
  confirmDisposition(db, { libraryName: "joda-time:joda-time", confirmedBy: "operator" });

  upsertProposedDisposition(db, {
    libraryName: "com.google.code.gson:gson",
    currentVersion: "2.8.9",
    disposition: "inline",
    inlineNote: "Only JsonParser.parseString used; inline the two call sites",
    rationale: "Single-use helper; removal avoids the dependency",
    proposedBy: "planner-collector",
  });
  confirmDisposition(db, { libraryName: "com.google.code.gson:gson", confirmedBy: "operator" });

  // A merely-proposed row must NOT appear in the locked set.
  upsertProposedDisposition(db, {
    libraryName: "commons-io:commons-io",
    currentVersion: "2.11.0",
    disposition: "keep",
    lockedTargetVersion: "2.15.1",
    rationale: "Proposed only — awaiting operator confirmation",
    proposedBy: "planner-collector",
  });
}

test("getLockedDependencySet returns only confirmed rows, ORDER BY library_name ASC", () => {
  const db = createDb();
  try {
    seedConfirmed(db);
    const set = getLockedDependencySet(db);
    assert.deepEqual(
      set.map((e) => e.library_name),
      [
        "com.google.code.gson:gson",
        "joda-time:joda-time",
        "org.apache.commons:commons-lang3",
      ],
    );
    assert.ok(!set.some((e) => e.library_name === "commons-io:commons-io"), "proposed rows excluded");
  } finally {
    db.close();
  }
});

test("getLockedDependencySet is byte-for-byte deterministic across repeated calls", () => {
  const db = createDb();
  try {
    seedConfirmed(db);
    const first = JSON.stringify(getLockedDependencySet(db));
    const second = JSON.stringify(getLockedDependencySet(db));
    const third = JSON.stringify(getLockedDependencySet(db));
    assert.equal(first, second);
    assert.equal(second, third);
  } finally {
    db.close();
  }
});

test("locked-set entries carry the kind-paired target fields (FR-008/FR-009)", () => {
  const db = createDb();
  try {
    seedConfirmed(db);
    const set = getLockedDependencySet(db);
    const byName = new Map(set.map((e) => [e.library_name, e]));

    const keep = byName.get("joda-time:joda-time")!;
    assert.equal(keep.disposition, "keep");
    assert.ok(keep.locked_target_version != null && keep.locked_target_version !== "",
      "every keep entry carries a non-null locked_target_version");
    assert.equal(keep.locked_target_version, "2.12.7");

    const replaced = byName.get("org.apache.commons:commons-lang3")!;
    assert.equal(replaced.disposition, "replace-with-native");
    assert.equal(replaced.native_replacement, "java.lang.String / java.util.Objects");

    const inlined = byName.get("com.google.code.gson:gson")!;
    assert.equal(inlined.disposition, "inline");
    assert.equal(inlined.inline_note, "Only JsonParser.parseString used; inline the two call sites");

    for (const entry of set) {
      assert.ok(entry.confirmed_by, "confirmed_by present on every entry");
      assert.ok(entry.confirmed_at, "confirmed_at present on every entry");
    }
  } finally {
    db.close();
  }
});

test("a confirmed row with pending_disposition contributes its CURRENT confirmed decision (FR-011)", () => {
  const db = createDb();
  try {
    upsertProposedDisposition(db, {
      libraryName: "joda-time:joda-time",
      currentVersion: "2.10.14",
      disposition: "replace-with-native",
      nativeReplacement: "java.time",
      rationale: "Initial proposal",
      proposedBy: "planner-collector",
    });
    // Operator overrides to keep — the confirmed decision is now keep@2.12.7.
    confirmDisposition(db, {
      libraryName: "joda-time:joda-time",
      confirmedBy: "operator",
      disposition: "keep",
      lockedTargetVersion: "2.12.7",
      rationale: "Date math too entangled to replace in v1",
    });

    // A collector re-run re-proposes replace-with-native → pending_* group set;
    // the confirmed keep must remain in effect in the locked set.
    upsertProposedDisposition(db, {
      libraryName: "joda-time:joda-time",
      currentVersion: "2.10.14",
      disposition: "replace-with-native",
      nativeReplacement: "java.time",
      rationale: "Re-run evidence still suggests java.time",
      proposedBy: "planner-collector",
    });

    const row = db.prepare(
      "SELECT pending_disposition FROM dependency_dispositions WHERE library_name = ?",
    ).get("joda-time:joda-time") as { pending_disposition: string | null };
    assert.equal(row.pending_disposition, "replace-with-native", "fixture: pending re-proposal in place");

    const set = getLockedDependencySet(db);
    assert.equal(set.length, 1);
    assert.equal(set[0]!.library_name, "joda-time:joda-time");
    assert.equal(set[0]!.disposition, "keep", "current confirmed decision remains in effect");
    assert.equal(set[0]!.locked_target_version, "2.12.7");
  } finally {
    db.close();
  }
});

test("getLockedDependencySet returns an empty array when nothing is confirmed", () => {
  const db = createDb();
  try {
    assert.deepEqual(getLockedDependencySet(db), []);
  } finally {
    db.close();
  }
});
