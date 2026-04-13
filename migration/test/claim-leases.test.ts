import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { claimNextTask, heartbeatClaim, reconcileStaleClaims } from "../registry/commands/claim";
import { registerArtifact, setArtifactStatus, setArtifactWave } from "../registry/commands/artifacts";
import { finishRun, startRun } from "../registry/commands/runs";
import { applySchema } from "../registry/db/schema";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function registerPlannedArtifact(db: Database.Database, id: string): void {
  registerArtifact(db, {
    id,
    kind: "legacy-source",
    tier: "first-class",
    path: `legacy/src/main/java/${id.replaceAll(":", "/")}.java`,
  });
  setArtifactWave(db, id, 1);
  setArtifactStatus(db, id, "planned");
}

test("claimNextTask creates an active claim linked to the owning run", () => {
  const db = createDb();

  try {
    const id = "legacy-source:com.acme:LeaseLinkedService";
    startRun(db, {
      runId: "run-lease-1",
      agent: "analyze-agent",
      ownerId: "analyze-agent:owner-1",
      phase: "analysis",
    });
    registerPlannedArtifact(db, id);

    const claimed = claimNextTask(
      db,
      "analyze-agent",
      undefined,
      "planned",
      "gpt-5.4-mini",
      "first-class",
      "run-lease-1",
      "analyze-agent:owner-1",
      15,
    );

    assert.equal(claimed.id, id);
    assert.equal(claimed.claim_run_id, "run-lease-1");
    assert.equal(claimed.claim_owner_id, "analyze-agent:owner-1");
    assert.ok(claimed.claim_id);
    assert.ok(claimed.claim_token);

    const stored = db.prepare(`
      SELECT run_id, owner_id, state, attempt_no
      FROM artifact_claims
      WHERE artifact_id = ?
    `).get(id) as {
      run_id: string | null;
      owner_id: string;
      state: string;
      attempt_no: number;
    };

    assert.equal(stored.run_id, "run-lease-1");
    assert.equal(stored.owner_id, "analyze-agent:owner-1");
    assert.equal(stored.state, "active");
    assert.equal(stored.attempt_no, 1);
  } finally {
    db.close();
  }
});

test("setArtifactStatus requires a claim token to finalize an active claimed artifact", () => {
  const db = createDb();

  try {
    const id = "legacy-source:com.acme:LeaseProtectedService";
    startRun(db, {
      runId: "run-lease-2",
      agent: "analyze-agent",
      ownerId: "analyze-agent:owner-2",
      phase: "analysis",
    });
    registerPlannedArtifact(db, id);

    const claimed = claimNextTask(
      db,
      "analyze-agent",
      undefined,
      "planned",
      "gpt-5.4-mini",
      "first-class",
      "run-lease-2",
      "analyze-agent:owner-2",
    );

    assert.throws(
      () => setArtifactStatus(db, id, "analyzed", { agent: "analyze-agent" }),
      /requires an active claim token/,
    );

    setArtifactStatus(db, id, "analyzed", {
      agent: "analyze-agent",
      claimId: claimed.claim_id,
      claimToken: claimed.claim_token,
    });

    const artifact = db.prepare(`
      SELECT status, claimed_by, claimed_at, claimed_from
      FROM artifacts
      WHERE id = ?
    `).get(id) as {
      status: string;
      claimed_by: string | null;
      claimed_at: string | null;
      claimed_from: string | null;
    };
    const claimState = db.prepare(`
      SELECT state, finish_reason
      FROM artifact_claims
      WHERE claim_id = ?
    `).get(claimed.claim_id) as {
      state: string;
      finish_reason: string | null;
    };

    assert.equal(artifact.status, "analyzed");
    assert.equal(artifact.claimed_by, null);
    assert.equal(artifact.claimed_at, null);
    assert.equal(artifact.claimed_from, null);
    assert.equal(claimState.state, "completed");
    assert.match(claimState.finish_reason ?? "", /planned -> analyzed/);
  } finally {
    db.close();
  }
});

test("heartbeatClaim reports the missing claim id when the claim is gone", () => {
  const db = createDb();

  try {
    assert.throws(
      () => heartbeatClaim(db, "missing-claim", "missing-token", "analyze-agent"),
      /Active claim "missing-claim" not found/,
    );
  } finally {
    db.close();
  }
});

test("reconcileStaleClaims keeps run-stopped claims released even if Date.now drifts forward", () => {
  const db = createDb();
  const RealDate = Date;

  try {
    const id = "legacy-source:com.acme:LeaseReleasedService";
    startRun(db, {
      runId: "run-lease-3",
      agent: "analyze-agent",
      ownerId: "analyze-agent:owner-3",
      phase: "analysis",
    });
    registerPlannedArtifact(db, id);

    const claimed = claimNextTask(
      db,
      "analyze-agent",
      undefined,
      "planned",
      "gpt-5.4-mini",
      "first-class",
      "run-lease-3",
      "analyze-agent:owner-3",
      30,
    );
    finishRun(db, { runId: "run-lease-3", exitCode: 0 });

    const future = new RealDate(Date.now() + 60 * 60 * 1000);
    globalThis.Date = class extends RealDate {
      constructor(value?: string | number | Date) {
        super(value ?? future);
      }

      static now(): number {
        return future.getTime();
      }
    } as DateConstructor;

    reconcileStaleClaims(db, "system");

    const claim = db.prepare(`
      SELECT state, finish_reason
      FROM artifact_claims
      WHERE claim_id = ?
    `).get(claimed.claim_id) as {
      state: string;
      finish_reason: string | null;
    };

    assert.equal(claim.state, "released");
    assert.match(claim.finish_reason ?? "", /Recovered stale claim/);
  } finally {
    globalThis.Date = RealDate;
    db.close();
  }
});
