import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import {
  confirmDisposition,
  listDispositions,
  upsertProposedDisposition,
} from "../registry/commands/dispositions";
import { applySchema } from "../registry/db/schema";
import { RegistryError } from "../registry/types";
import type { DependencyDispositionChangeKind } from "../registry/types";

/**
 * T016 — US2 confirm / override / re-propose coverage for
 * specs/006-dependency-disposition (FR-005, FR-008, FR-011, quickstart
 * Scenarios 2 and 4).
 */

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function historyKinds(db: Database.Database, libraryName: string): DependencyDispositionChangeKind[] {
  const rows = db.prepare(
    "SELECT change_kind FROM dependency_disposition_history WHERE library_name = ? ORDER BY rowid",
  ).all(libraryName) as Array<{ change_kind: DependencyDispositionChangeKind }>;
  return rows.map((row) => row.change_kind);
}

function seedProposed(
  db: Database.Database,
  libraryName: string,
  overrides: Partial<Parameters<typeof upsertProposedDisposition>[1]> = {},
) {
  return upsertProposedDisposition(db, {
    libraryName,
    currentVersion: "1.2.17",
    disposition: "replace-with-native",
    nativeReplacement: "java.util.Objects",
    rationale: "Collector seed: utility-only usage.",
    proposedBy: "planner-collector",
    ...overrides,
  });
}

test("confirmDisposition flips status and sets confirmed_by + confirmed_at atomically (never a bare flip)", () => {
  const db = createDb();
  try {
    seedProposed(db, "org.apache.commons:commons-lang3");

    const confirmed = confirmDisposition(db, {
      libraryName: "org.apache.commons:commons-lang3",
      confirmedBy: "operator",
    });

    assert.equal(confirmed.status, "confirmed");
    assert.equal(confirmed.confirmed_by, "operator");
    assert.ok(confirmed.confirmed_at, "confirmed_at recorded in the same statement as the flip");
    // Proposal fields unchanged — no override args given, no pending group.
    assert.equal(confirmed.disposition, "replace-with-native");
    assert.equal(confirmed.native_replacement, "java.util.Objects");
    assert.deepEqual(historyKinds(db, "org.apache.commons:commons-lang3"), ["propose", "confirm"]);
    // The 'confirm' history row snapshots the pre-confirm state.
    const last = db.prepare(
      "SELECT snapshot_json FROM dependency_disposition_history WHERE library_name = ? AND change_kind = 'confirm'",
    ).get("org.apache.commons:commons-lang3") as { snapshot_json: string };
    assert.equal(JSON.parse(last.snapshot_json).status, "proposed");
  } finally {
    db.close();
  }
});

test("any override arg present replaces the proposal fields and records change_kind='override'", () => {
  const db = createDb();
  try {
    seedProposed(db, "joda-time:joda-time");

    const confirmed = confirmDisposition(db, {
      libraryName: "joda-time:joda-time",
      confirmedBy: "operator",
      disposition: "keep",
      lockedTargetVersion: "2.12.7",
      rationale: "Deep Joda usage in scheduling module — keep with a version lock.",
    });

    assert.equal(confirmed.status, "confirmed");
    assert.equal(confirmed.disposition, "keep");
    assert.equal(confirmed.native_replacement, null, "override clears stale replace-with-native target");
    assert.equal(confirmed.locked_target_version, "2.12.7");
    assert.equal(confirmed.rationale, "Deep Joda usage in scheduling module — keep with a version lock.");
    assert.equal(confirmed.confirmed_by, "operator");
    assert.deepEqual(historyKinds(db, "joda-time:joda-time"), ["propose", "override"]);
  } finally {
    db.close();
  }
});

test("confirming a row with pending_* folds the pending group into primary and NULLs it (change_kind='confirm')", () => {
  const db = createDb();
  try {
    // Confirm an initial keep proposal first…
    upsertProposedDisposition(db, {
      libraryName: "com.google.guava:guava",
      currentVersion: "31.1-jre",
      disposition: "keep",
      lockedTargetVersion: "31.1-jre",
      rationale: "Collections usage is deep.",
      proposedBy: "planner-collector",
    });
    confirmDisposition(db, { libraryName: "com.google.guava:guava", confirmedBy: "operator" });

    // …then a re-run proposes a different disposition → pending_* group only.
    upsertProposedDisposition(db, {
      libraryName: "com.google.guava:guava",
      currentVersion: "33.4.0-jre",
      disposition: "replace-with-native",
      nativeReplacement: "java.util.Optional",
      rationale: "Re-run evidence: only Optional/Precondition imports remain.",
      proposedBy: "planner-collector",
    });

    const pending = listDispositions(db, { status: "confirmed", pendingOnly: true });
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.pending_disposition, "replace-with-native");

    const folded = confirmDisposition(db, {
      libraryName: "com.google.guava:guava",
      confirmedBy: "operator",
    });

    assert.equal(folded.disposition, "replace-with-native", "pending group folded into primary");
    assert.equal(folded.native_replacement, "java.util.Optional");
    assert.equal(folded.rationale, "Re-run evidence: only Optional/Precondition imports remain.");
    assert.equal(folded.pending_disposition, null, "pending group NULLed on fold");
    assert.equal(folded.pending_rationale, null);
    assert.equal(folded.pending_proposed_by, null);
    assert.equal(folded.pending_at, null);
    assert.equal(folded.status, "confirmed");
    assert.equal(folded.confirmed_by, "operator");
    assert.deepEqual(historyKinds(db, "com.google.guava:guava"), ["propose", "confirm", "re-propose", "confirm"]);
  } finally {
    db.close();
  }
});

test("confirming disposition='keep' without locked_target_version is rejected (FR-008)", () => {
  const db = createDb();
  try {
    upsertProposedDisposition(db, {
      libraryName: "com.acme:legacy-helper",
      disposition: "keep",
      rationale: "No native equivalent declared.",
      proposedBy: "planner-collector",
    });

    assert.throws(
      () => confirmDisposition(db, { libraryName: "com.acme:legacy-helper", confirmedBy: "operator" }),
      (error: unknown) => error instanceof RegistryError && /locked/i.test(error.message),
    );

    // Row untouched — the validation failure happens before any mutation.
    const row = listDispositions(db, { status: "proposed" });
    assert.equal(row.length, 1);
    assert.equal(row[0]!.confirmed_by, null);
    assert.deepEqual(historyKinds(db, "com.acme:legacy-helper"), ["propose"]);
  } finally {
    db.close();
  }
});

test("confirming an unknown library is rejected (RegistryError code 2)", () => {
  const db = createDb();
  try {
    assert.throws(
      () => confirmDisposition(db, { libraryName: "com.acme:missing", confirmedBy: "operator" }),
      (error: unknown) => error instanceof RegistryError && error.code === 2,
    );
  } finally {
    db.close();
  }
});

test("re-running the collector against a confirmed row writes ONLY the pending_* group (FR-011, Scenario 4)", () => {
  const db = createDb();
  try {
    // Confirmed keep (operator override), per Scenario 4 step 1.
    upsertProposedDisposition(db, {
      libraryName: "joda-time:joda-time",
      currentVersion: "2.10",
      disposition: "replace-with-native",
      nativeReplacement: "java.time",
      rationale: "Native-equivalent seed.",
      proposedBy: "planner-collector",
    });
    confirmDisposition(db, {
      libraryName: "joda-time:joda-time",
      confirmedBy: "operator",
      disposition: "keep",
      lockedTargetVersion: "2.10",
      rationale: "Keep — scheduling logic depends on Joda intervals.",
    });

    // Collector re-run: fresh evidence still suggests replace-with-native.
    upsertProposedDisposition(db, {
      libraryName: "joda-time:joda-time",
      currentVersion: "2.12.7",
      disposition: "replace-with-native",
      nativeReplacement: "java.time",
      rationale: "Re-run evidence: java.time supersedes Joda-Time.",
      proposedBy: "planner-collector",
    });

    const row = listDispositions(db, { status: "confirmed", pendingOnly: true })[0]!;
    assert.equal(row.disposition, "keep", "primary/current columns untouched");
    assert.equal(row.locked_target_version, "2.10");
    assert.equal(row.rationale, "Keep — scheduling logic depends on Joda intervals.");
    assert.equal(row.current_version, "2.10", "primary current_version untouched");
    assert.equal(row.pending_disposition, "replace-with-native");
    assert.equal(row.pending_native_replacement, "java.time");
    assert.equal(row.pending_rationale, "Re-run evidence: java.time supersedes Joda-Time.");
    assert.equal(row.pending_proposed_by, "planner-collector");
    assert.ok(row.pending_at);
    assert.deepEqual(historyKinds(db, "joda-time:joda-time"), ["propose", "override", "re-propose"]);
  } finally {
    db.close();
  }
});
