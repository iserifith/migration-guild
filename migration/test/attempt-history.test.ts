/**
 * T017 / US3 (spec 013): attempt-history regression tests for the new
 * `registry/commands/attempts.ts` module (recordAttemptOutcome,
 * getAttemptHistory, getPersistedBudgetState).
 *
 * Tests-first: that module does NOT exist yet (lands with T019), so this
 * suite currently fails at import time with module-not-found — the intended
 * fail-for-the-right-reason. Coverage per spec.md FR-009/FR-010,
 * data-model.md §3, and contracts/registry-commands.md "attempts" section.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  getAttemptHistory,
  getPersistedBudgetState,
  recordAttemptOutcome,
} from "../registry/commands/attempts";
import { RegistryError } from "../registry/types";
import { FailureBudget } from "../guildctl/supervisor/failures";
import {
  ATTEMPT_ARTIFACT_ID,
  createAttemptFixtureDb,
  getAttemptHistory as readAttemptRows,
  seedAttemptRecord,
} from "./attempt-fixtures";

test("recordAttemptOutcome: outcome 'succeeded' inserts exactly one row with failure_kind NULL", () => {
  const { db, artifactId } = createAttemptFixtureDb();
  try {
    recordAttemptOutcome(db, {
      artifactId,
      attemptNo: 1,
      outcome: "succeeded",
      startedAt: "2026-01-01 00:00:01",
    });

    const rows = readAttemptRows(db, artifactId);
    assert.equal(rows.length, 1, "exactly one attempt_records row must be inserted");
    assert.equal(rows[0].artifact_id, artifactId);
    assert.equal(rows[0].attempt_no, 1);
    assert.equal(rows[0].phase, "migrate", "phase defaults to 'migrate' per the contract");
    assert.equal(rows[0].outcome, "succeeded");
    assert.equal(rows[0].failure_kind, null, "failure_kind must be NULL when outcome is 'succeeded'");
    assert.equal(rows[0].failure_signature, null);
    assert.equal(rows[0].started_at, "2026-01-01 00:00:01");
  } finally {
    db.close();
  }
});

test("recordAttemptOutcome: 'failed'/'budget-exhausted' require failureKind and persist kind + signature", () => {
  const { db, artifactId } = createAttemptFixtureDb();
  try {
    recordAttemptOutcome(db, {
      artifactId,
      attemptNo: 1,
      outcome: "failed",
      failureKind: "build-failure",
      failureSignature: "error in <path> at line <n>",
      startedAt: "2026-01-01 00:00:01",
    });
    recordAttemptOutcome(db, {
      artifactId,
      attemptNo: 2,
      outcome: "budget-exhausted",
      failureKind: "agent-timeout",
      failureSignature: "killed: inactivity",
      startedAt: "2026-01-01 00:05:01",
    });

    const rows = readAttemptRows(db, artifactId);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].outcome, "failed");
    assert.equal(rows[0].failure_kind, "build-failure");
    assert.equal(rows[0].failure_signature, "error in <path> at line <n>");
    assert.equal(rows[1].outcome, "budget-exhausted");
    assert.equal(rows[1].failure_kind, "agent-timeout");
    assert.equal(rows[1].failure_signature, "killed: inactivity");

    // data-model.md §3: failureKind is required whenever outcome !== 'succeeded'.
    for (const outcome of ["failed", "budget-exhausted"] as const) {
      assert.throws(
        () =>
          recordAttemptOutcome(db, {
            artifactId,
            attemptNo: outcome === "failed" ? 3 : 4,
            outcome,
            startedAt: "2026-01-01 00:10:01",
          }),
        (err: unknown) => err instanceof RegistryError,
        `outcome '${outcome}' without failureKind must throw RegistryError`,
      );
    }
    assert.equal(readAttemptRows(db, artifactId).length, 2, "rejected writes must not insert rows");
  } finally {
    db.close();
  }
});

test("recordAttemptOutcome: duplicate (artifactId, attemptNo) throws RegistryError, never silently overwrites", () => {
  const { db, artifactId } = createAttemptFixtureDb();
  try {
    recordAttemptOutcome(db, {
      artifactId,
      attemptNo: 1,
      outcome: "failed",
      failureKind: "test-failure",
      failureSignature: "1 test failed",
      startedAt: "2026-01-01 00:00:01",
    });

    assert.throws(
      () =>
        recordAttemptOutcome(db, {
          artifactId,
          attemptNo: 1,
          outcome: "succeeded",
          startedAt: "2026-01-01 00:02:01",
        }),
      (err: unknown) =>
        err instanceof RegistryError && /Attempt 1 already recorded/.test((err as Error).message),
      "second write for the same (artifactId, attemptNo) must throw RegistryError naming the attempt",
    );

    const rows = readAttemptRows(db, artifactId);
    assert.equal(rows.length, 1, "the original row must not be overwritten or duplicated");
    assert.equal(rows[0].outcome, "failed", "original outcome must survive the rejected overwrite");
    assert.equal(rows[0].failure_kind, "test-failure");
  } finally {
    db.close();
  }
});

test("getAttemptHistory: returns the artifact's attempt rows ordered by attempt_no (FR-010)", () => {
  const { db, artifactId } = createAttemptFixtureDb();
  try {
    // Record out of order to prove the read — not insertion order — sorts.
    recordAttemptOutcome(db, {
      artifactId,
      attemptNo: 2,
      outcome: "failed",
      failureKind: "build-failure",
      failureSignature: "sig-b",
      startedAt: "2026-01-01 00:05:00",
    });
    recordAttemptOutcome(db, {
      artifactId,
      attemptNo: 1,
      outcome: "failed",
      failureKind: "test-failure",
      failureSignature: "sig-a",
      startedAt: "2026-01-01 00:00:00",
    });
    recordAttemptOutcome(db, {
      artifactId,
      attemptNo: 3,
      outcome: "succeeded",
      startedAt: "2026-01-01 00:10:00",
    });

    const history = getAttemptHistory(db, artifactId);
    assert.deepEqual(
      history.map((row) => row.attempt_no ?? row.attemptNo),
      [1, 2, 3],
      "history must be ordered by attempt_no",
    );
    assert.deepEqual(
      history.map((row) => row.outcome),
      ["failed", "failed", "succeeded"],
    );
    assert.equal(history.length, 3, "queryable after the fact without process logs (FR-010)");

    // History is per-artifact: another artifact's rows must not leak in.
    assert.deepEqual(getAttemptHistory(db, "legacy-source:com.acme.attempt:NoSuchThing"), []);
  } finally {
    db.close();
  }
});

test("getPersistedBudgetState: re-seeds a fresh FailureBudget so a restart blocks at the cap (FR-009)", () => {
  const { db, artifactId } = createAttemptFixtureDb();
  try {
    // Durable history as it exists when a process restarts mid-artifact:
    // two failures sharing one signature, then budget exhaustion on another.
    seedAttemptRecord(db, {
      artifactId,
      attemptNo: 1,
      outcome: "failed",
      failureKind: "build-failure",
      failureSignature: "error in <path> at line <n>",
    });
    seedAttemptRecord(db, {
      artifactId,
      attemptNo: 2,
      outcome: "failed",
      failureKind: "build-failure",
      failureSignature: "error in <path> at line <n>",
    });
    seedAttemptRecord(db, {
      artifactId,
      attemptNo: 3,
      outcome: "budget-exhausted",
      failureKind: "agent-timeout",
      failureSignature: "killed: inactivity",
    });

    const state = getPersistedBudgetState(db, artifactId);
    assert.equal(state.attemptsUsed, 3, "attemptsUsed must equal the seeded attempt_records row count");
    assert.deepEqual(
      state.playbookSignatureCounts,
      { "error in <path> at line <n>": 2, "killed: inactivity": 1 },
      "playbookSignatureCounts must map failure_signature to its durable count",
    );

    // FR-009 restart-resumption: reconstruct a FRESH FailureBudget from the
    // persisted state (identical accounting to a no-restart run) and confirm
    // it does NOT re-allow attempts already consumed — it blocks at the cap.
    const budget = new FailureBudget(3, 2);
    for (let i = 0; i < state.attemptsUsed; i += 1) {
      budget.recordAttempt(artifactId);
    }
    assert.equal(
      budget.canAttemptArtifact(artifactId),
      false,
      "a budget reconstructed from persisted state must block attempts already consumed before the restart",
    );
  } finally {
    db.close();
  }
});

test("recordAttemptOutcome: enforces failure_kind NULL iff outcome='succeeded' (rejects failureKind on success)", () => {
  const { db, artifactId } = createAttemptFixtureDb();
  try {
    assert.throws(
      () =>
        recordAttemptOutcome(db, {
          artifactId,
          attemptNo: 1,
          outcome: "succeeded",
          failureKind: "unknown",
          startedAt: "2026-01-01 00:00:01",
        }),
      (err: unknown) => err instanceof RegistryError,
      "passing failureKind with outcome 'succeeded' must be rejected",
    );
    assert.equal(readAttemptRows(db, artifactId).length, 0, "rejected write must not insert a row");

    // The other half of the invariant already holds via the command: a plain
    // success records NULL, and a failure without a kind is rejected (above).
    recordAttemptOutcome(db, {
      artifactId,
      attemptNo: 1,
      outcome: "succeeded",
      startedAt: "2026-01-01 00:00:01",
    });
    const rows = readAttemptRows(db, artifactId);
    assert.equal(rows[0].failure_kind, null);
    assert.equal(rows[0].failure_signature, null);
  } finally {
    db.close();
  }
});

test("fixture sanity: seeded history reader orders by attempt_no (guards against fixture regressions)", () => {
  const { db, artifactId } = createAttemptFixtureDb();
  try {
    seedAttemptRecord(db, {
      artifactId,
      attemptNo: 2,
      outcome: "failed",
      failureKind: "review-rejection",
    });
    seedAttemptRecord(db, {
      artifactId,
      attemptNo: 1,
      outcome: "failed",
      failureKind: "build-failure",
    });
    assert.deepEqual(
      readAttemptRows(db, artifactId).map((row) => row.attempt_no),
      [1, 2],
    );
    assert.equal(artifactId, ATTEMPT_ARTIFACT_ID);
  } finally {
    db.close();
  }
});
