/**
 * artifacts-release-pending.test.ts
 *
 * US3 / #124 — `releaseTask` must accept an artifact that is `claimed-but-pending`
 * (the literal GETTING-STARTED.md crash-recovery trigger: `claimed_by` set,
 * `status='pending'`) as a releasable "stuck" state, in addition to the existing
 * `in-progress` case. A `planned` + unclaimed artifact must still be refused.
 *
 * Runs entirely in-memory — no network, no real DB file.
 */

import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { applySchema } from "../registry/db/schema";
import { registerArtifact } from "../registry/commands/artifacts";
import {
  releaseTask,
} from "../registry/commands/artifacts";
import { claimArtifactById } from "../registry/commands/claim";

function hasActiveClaim(db: Database.Database, id: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM artifact_claims WHERE artifact_id = ? AND state = 'active'`,
    )
    .get(id);
  return row !== undefined;
}

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function seedClaimedPending(
  db: Database.Database,
  id: string,
  claimedBy: string,
): void {
  registerArtifact(db, {
    id,
    kind: "legacy-source",
    path: `legacy/src/${id.replaceAll(":", "/")}.java`,
    tier: "first-class",
    module: "core",
  });
  db.prepare(
    `UPDATE artifacts SET status = 'pending', claimed_by = ?, claimed_at = datetime('now'), claimed_from = 'planned' WHERE id = ?`,
  ).run(claimedBy, id);
}

function seedInProgress(
  db: Database.Database,
  id: string,
  claimedBy: string,
): void {
  registerArtifact(db, {
    id,
    kind: "legacy-source",
    path: `legacy/src/${id.replaceAll(":", "/")}.java`,
    tier: "first-class",
    module: "core",
  });
  // Use the kit's real claim API so the active claim row + denormalized columns
  // match production exactly (manual INSERTs omit required columns like owner_id).
  claimArtifactById(db, { artifactId: id, agent: claimedBy, fromStatus: "pending" });
}

function seedPlannedUnclaimed(db: Database.Database, id: string): void {
  registerArtifact(db, {
    id,
    kind: "legacy-source",
    path: `legacy/src/${id.replaceAll(":", "/")}.java`,
    tier: "first-class",
    module: "core",
  });
  // registerArtifact defaults status to 'planned', claimed_by NULL.
}

test("US3 (a): claimed-but-pending artifact is releasable without throwing", () => {
  const db = createDb();
  const id = "legacy-source:core:PendingStuck";
  seedClaimedPending(db, id, "crashed-agent");

  let released!: ReturnType<typeof releaseTask>;
  assert.doesNotThrow(() => {
    released = releaseTask(db, id, "operator", "crashed");
  });

  assert.equal(released.claimed_by, null);
  assert.equal(released.claimed_at, null);
  assert.equal(released.claimed_from, null);
  // claimed_from was 'planned', so reset target is 'planned'.
  assert.equal(released.status, "planned");

  const event = db
    .prepare(
      `SELECT * FROM events WHERE artifact_id = ? AND type = 'status-changed'`,
    )
    .get(id) as { summary: string } | undefined;
  assert.ok(event, "a status-changed event must be written");
});

test("US3 (b): in-progress artifact with active claim still releases as before", () => {
  const db = createDb();
  const id = "legacy-source:core:InProgress";
  seedInProgress(db, id, "live-agent");

  const released = releaseTask(db, id, "operator", "done");
  assert.equal(released.claimed_by, null);
  // The claim was taken from 'pending', so release returns it to 'pending'
  // (release restores the pre-claim status, it does not force 'planned').
  assert.equal(released.status, "pending");
  assert.equal(hasActiveClaim(db, id), false);
});

test("US3 (c): planned + unclaimed artifact is still refused", () => {
  const db = createDb();
  const id = "legacy-source:core:NeverClaimed";
  seedPlannedUnclaimed(db, id);

  assert.throws(
    () => releaseTask(db, id, "operator", "why"),
    /Cannot release/,
  );
});

test("US3 (d): free-form reason with SQL metacharacters does not corrupt tables", () => {
  const db = createDb();
  const id = "legacy-source:core:Injection";
  seedClaimedPending(db, id, "crashed-agent");

  const evil = "crashed'; DROP TABLE artifacts; --";
  assert.doesNotThrow(() => releaseTask(db, id, "operator", evil));

  // Tables intact.
  const after = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='artifacts'`)
    .get();
  assert.ok(after, "artifacts table survived the injection attempt");
  const eventsAfter = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='events'`)
    .get();
  assert.ok(eventsAfter, "events table survived the injection attempt");
});
