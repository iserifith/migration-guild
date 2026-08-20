import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import {
  acquireVerifySlot,
  countLiveVerifySlots,
  releaseVerifySlot,
  withVerifySlot,
} from "../registry/commands/verifySlot";
import { startRun } from "../registry/commands/runs";
import { applySchema } from "../registry/db/schema";

// US5 (#151) / T020: bounded verify concurrency. `acquireVerifySlot` must
// refuse acquisition beyond `verification.max_concurrent` live slots, and
// `releaseVerifySlot` must free capacity for the next waiter — the same
// atomic-lease discipline the artifact-claim path already enforces.

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function makeConfig(maxConcurrent: number): { verification: { budget_seconds: number; max_concurrent: number } } {
  return { verification: { budget_seconds: 120, max_concurrent: maxConcurrent } };
}

test("US5: acquireVerifySlot enforces max_concurrent; release frees capacity for the next waiter", async () => {
  const db = createDb();
  try {
    startRun(db, { runId: "run-slot-1", agent: "guildctl-verify", ownerId: "guildctl", phase: "verify" });
    const config = makeConfig(2);

    const slot1 = await acquireVerifySlot(db, { runId: "run-slot-1", artifactId: "artifact-a", config });
    const slot2 = await acquireVerifySlot(db, { runId: "run-slot-1", artifactId: "artifact-b", config });
    assert.equal(countLiveVerifySlots(db), 2);

    // The pool is full: a third acquire must not succeed while both slots are
    // held. Bound the wait so the assertion is deterministic.
    await assert.rejects(
      acquireVerifySlot(db, { runId: "run-slot-1", artifactId: "artifact-c", config, maxWaitMs: 200, pollMs: 20 }),
      /verify slot not acquired/,
    );
    assert.equal(countLiveVerifySlots(db), 2);

    // Releasing one slot frees capacity for the next waiter.
    releaseVerifySlot(db, slot1.slot_id);
    assert.equal(countLiveVerifySlots(db), 1);
    const slot3 = await acquireVerifySlot(db, { runId: "run-slot-1", artifactId: "artifact-c", config });
    assert.ok(slot3.slot_id);
    assert.equal(countLiveVerifySlots(db), 2);

    releaseVerifySlot(db, slot2.slot_id);
    releaseVerifySlot(db, slot3.slot_id);
    assert.equal(countLiveVerifySlots(db), 0);
  } finally {
    db.close();
  }
});

test("US5: releaseVerifySlot is idempotent and a released slot never counts against the cap", async () => {
  const db = createDb();
  try {
    const config = makeConfig(1);
    const slot = await acquireVerifySlot(db, { artifactId: "artifact-a", config });
    releaseVerifySlot(db, slot.slot_id);
    releaseVerifySlot(db, slot.slot_id); // second release is a no-op
    assert.equal(countLiveVerifySlots(db), 0);
    const next = await acquireVerifySlot(db, { artifactId: "artifact-a", config });
    assert.notEqual(next.slot_id, slot.slot_id, "a new row is created per acquisition");
    releaseVerifySlot(db, next.slot_id);
  } finally {
    db.close();
  }
});

test("US5: a stale lease is reclaimed so a crashed holder never permanently consumes a slot", async () => {
  const db = createDb();
  try {
    const config = makeConfig(1);
    let nowMs = 1_000_000;
    const now = () => nowMs;
    // Acquire a slot that never gets released (simulating a crashed holder).
    // Assert liveness against the same injected clock (countLiveVerifySlots
    // reads the wall clock, which is meaningless next to a synthetic `now`).
    await acquireVerifySlot(db, { artifactId: "artifact-a", config, now });
    const liveBefore = db
      .prepare("SELECT COUNT(*) AS n FROM verify_slots WHERE released_at IS NULL AND lease_expires_at > ?")
      .get(new Date(nowMs).toISOString().replace("T", " ").replace("Z", "")) as { n: number };
    assert.equal(liveBefore.n, 1);

    // Advance the clock past the lease ceiling (2x the 120s budget = 240s).
    nowMs += 300_000;
    // The next acquire reclaims the stale lease instead of blocking forever.
    const reclaimed = await acquireVerifySlot(db, { artifactId: "artifact-b", config, now });
    assert.ok(reclaimed.slot_id);
  } finally {
    db.close();
  }
});

test("US5: withVerifySlot releases the slot even when the wrapped check rejects", async () => {
  const db = createDb();
  try {
    const config = makeConfig(1);
    await assert.rejects(
      withVerifySlot(db, { artifactId: "artifact-a", config }, async () => {
        assert.equal(countLiveVerifySlots(db), 1);
        throw new Error("check blew up");
      }),
      /check blew up/,
    );
    assert.equal(countLiveVerifySlots(db), 0, "the slot is freed exactly once on settle");
  } finally {
    db.close();
  }
});
