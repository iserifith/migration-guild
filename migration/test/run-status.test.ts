/**
 * T003 (spec 016, #220) — registry-layer tests for the four-state run-status
 * derivation function (queryRunStatusForUI, migration/registry/commands/queries.ts).
 *
 * Written to FAIL before T004 implements queryRunStatusForUI; covers the
 * data-model.md precedence rules:
 *
 *   1. rejected             — most recent arbitration_decisions row is `rejected`
 *   2. waiting-for-approval — artifact currently held at pending-approval
 *   3. working               — active claim with a recent heartbeat_at/claimed_at
 *   4. idle                  — everything else (no active claim, or stale heartbeat)
 *
 * Also covers FR-006 (NULL heartbeat_at falls back to claimed_at) and the
 * terminal-status exclusion from spec.md Assumptions.
 */
import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { registerArtifact } from "../registry/commands/artifacts";
import { recordArbitrationDecision } from "../registry/commands/evidence";
import { queryRunStatusForUI } from "../registry/commands/queries";
import { applySchema } from "../registry/db/schema";
import { WORKING_RECENCY_THRESHOLD_MS } from "../registry/types";
import type { RunStatusEntry } from "../registry/types";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function registerAndClaim(
  db: Database.Database,
  opts: {
    artifactId: string;
    status?: string;
    claim?: {
      claimId: string;
      heartbeatOffset?: string | null;
      claimedOffset?: string;
      state?: string;
    };
  },
): void {
  registerArtifact(db, {
    id: opts.artifactId,
    kind: "legacy-source",
    tier: "first-class",
    path: `legacy/${opts.artifactId}.java`,
  });
  if (opts.status && opts.status !== "pending") {
    db.prepare("UPDATE artifacts SET status = ? WHERE id = ?").run(opts.status, opts.artifactId);
  }
  if (opts.claim) {
    const { claimId, heartbeatOffset, claimedOffset, state } = opts.claim;
    const claimedAtExpr = claimedOffset
      ? `datetime('now', '${claimedOffset}')`
      : "datetime('now')";
    const heartbeatAtExpr =
      heartbeatOffset === null
        ? "NULL"
        : heartbeatOffset
          ? `datetime('now', '${heartbeatOffset}')`
          // Not explicitly overridden: default to the same timestamp as
          // claimed_at (a claim whose heartbeat has never fired separately).
          : claimedAtExpr;
    db.prepare(
      `INSERT INTO artifact_claims (
         claim_id, artifact_id, owner_id, agent, from_status,
         claim_token, state, attempt_no, claimed_at, heartbeat_at, lease_expires_at
       ) VALUES (
         ?, ?, 'test-agent', 'test-agent', 'planned',
         'token', ?, 1, ${claimedAtExpr}, ${heartbeatAtExpr}, datetime('now', '+30 minutes')
       )`,
    ).run(claimId, opts.artifactId, state ?? "active");
  }
}

function findEntry(entries: RunStatusEntry[], artifactId: string): RunStatusEntry | undefined {
  return entries.find((e) => e.artifact_id === artifactId);
}

test("US1: an active claim with a recent heartbeat reads as working", () => {
  const db = createDb();
  try {
    registerAndClaim(db, {
      artifactId: "legacy-source:com.acme:Working",
      status: "in-progress",
      claim: { claimId: "claim-working", heartbeatOffset: "-1 minutes" },
    });

    const entries = queryRunStatusForUI(db);
    const entry = findEntry(entries, "legacy-source:com.acme:Working");
    assert.ok(entry, "expected an entry for the claimed artifact");
    assert.equal(entry!.label, "working");
    assert.ok(entry!.heartbeat_age_ms != null && entry!.heartbeat_age_ms < WORKING_RECENCY_THRESHOLD_MS);
  } finally {
    db.close();
  }
});

test("US2: a stale-heartbeat active claim reads as idle, not working", () => {
  const db = createDb();
  try {
    registerAndClaim(db, {
      artifactId: "legacy-source:com.acme:Stale",
      status: "in-progress",
      claim: { claimId: "claim-stale", heartbeatOffset: "-10 minutes" },
    });

    const entries = queryRunStatusForUI(db);
    const entry = findEntry(entries, "legacy-source:com.acme:Stale");
    assert.ok(entry);
    assert.equal(entry!.label, "idle");
    assert.ok(entry!.heartbeat_age_ms != null && entry!.heartbeat_age_ms > WORKING_RECENCY_THRESHOLD_MS);
  } finally {
    db.close();
  }
});

test("US2: an artifact with no active claim reads as idle", () => {
  const db = createDb();
  try {
    registerArtifact(db, {
      id: "legacy-source:com.acme:NoClaim",
      kind: "legacy-source",
      tier: "first-class",
      path: "legacy/NoClaim.java",
    });

    const entries = queryRunStatusForUI(db);
    const entry = findEntry(entries, "legacy-source:com.acme:NoClaim");
    assert.ok(entry);
    assert.equal(entry!.label, "idle");
    assert.equal(entry!.heartbeat_age_ms, null);
  } finally {
    db.close();
  }
});

test("US3: an artifact held at pending-approval reads as waiting-for-approval", () => {
  const db = createDb();
  try {
    registerAndClaim(db, {
      artifactId: "legacy-source:com.acme:Pending",
      status: "pending-approval",
    });

    const entries = queryRunStatusForUI(db);
    const entry = findEntry(entries, "legacy-source:com.acme:Pending");
    assert.ok(entry);
    assert.equal(entry!.label, "waiting-for-approval");
    assert.equal(entry!.heartbeat_age_ms, null);
  } finally {
    db.close();
  }
});

test("US3: an artifact with a recorded rejected arbitration decision reads as rejected", () => {
  const db = createDb();
  try {
    registerAndClaim(db, {
      artifactId: "legacy-source:com.acme:Rejected",
      status: "needs-rework",
    });
    recordArbitrationDecision(db, {
      artifactId: "legacy-source:com.acme:Rejected",
      arbiter: "arbiter-agent",
      decision: "rejected",
      reason: "Evidence did not demonstrate behavior parity.",
      evidenceIds: [],
    });

    const entries = queryRunStatusForUI(db);
    const entry = findEntry(entries, "legacy-source:com.acme:Rejected");
    assert.ok(entry);
    assert.equal(entry!.label, "rejected");
    assert.equal(entry!.heartbeat_age_ms, null);
  } finally {
    db.close();
  }
});

test("precedence: an active recent claim AND a rejected decision resolves to rejected", () => {
  const db = createDb();
  try {
    registerAndClaim(db, {
      artifactId: "legacy-source:com.acme:BothSignals",
      status: "in-progress",
      claim: { claimId: "claim-both", heartbeatOffset: "-1 minutes" },
    });
    recordArbitrationDecision(db, {
      artifactId: "legacy-source:com.acme:BothSignals",
      arbiter: "arbiter-agent",
      decision: "rejected",
      reason: "Rejected despite an active in-progress claim.",
      evidenceIds: [],
    });

    const entries = queryRunStatusForUI(db);
    const entry = findEntry(entries, "legacy-source:com.acme:BothSignals");
    assert.ok(entry);
    assert.equal(entry!.label, "rejected");
  } finally {
    db.close();
  }
});

test("precedence: a rejected-then-later-approved decision no longer reads as rejected", () => {
  const db = createDb();
  try {
    registerAndClaim(db, {
      artifactId: "legacy-source:com.acme:Reworked",
      status: "in-progress",
    });
    recordArbitrationDecision(db, {
      artifactId: "legacy-source:com.acme:Reworked",
      arbiter: "arbiter-agent",
      decision: "rejected",
      reason: "First attempt rejected.",
      evidenceIds: [],
    });
    recordArbitrationDecision(db, {
      artifactId: "legacy-source:com.acme:Reworked",
      arbiter: "arbiter-agent",
      decision: "approved",
      reason: "Second attempt approved.",
      evidenceIds: [],
    });

    const entries = queryRunStatusForUI(db);
    const entry = findEntry(entries, "legacy-source:com.acme:Reworked");
    assert.ok(entry);
    assert.notEqual(entry!.label, "rejected");
  } finally {
    db.close();
  }
});

// FR-006 says the recency signal falls back to claimed_at when heartbeat_at
// is NULL. `artifact_claims.heartbeat_at` is NOT NULL in registry_schema.sql
// (defaulted to claimed_at at insert time and on every heartbeat), so that
// branch is unreachable through real data and is defensive-only in
// queryRunStatusForUI (mirrors guildctl doctor.ts's identical fallback
// pattern). What IS reachable and load-bearing: a freshly claimed artifact
// whose heartbeat has never been sent separately from claimed_at still ages
// correctly off that shared timestamp.
test("FR-006: a claim whose heartbeat_at still equals claimed_at ages correctly off that shared timestamp", () => {
  const db = createDb();
  try {
    registerAndClaim(db, {
      artifactId: "legacy-source:com.acme:FreshNoHeartbeatYet",
      status: "in-progress",
      claim: { claimId: "claim-fresh-shared", claimedOffset: "-1 minutes" },
    });
    registerAndClaim(db, {
      artifactId: "legacy-source:com.acme:StaleNoHeartbeatYet",
      status: "in-progress",
      claim: { claimId: "claim-stale-shared", claimedOffset: "-10 minutes" },
    });

    const entries = queryRunStatusForUI(db);
    const fresh = findEntry(entries, "legacy-source:com.acme:FreshNoHeartbeatYet");
    const stale = findEntry(entries, "legacy-source:com.acme:StaleNoHeartbeatYet");
    assert.ok(fresh);
    assert.ok(stale);
    assert.equal(fresh!.label, "working");
    assert.equal(stale!.label, "idle");
  } finally {
    db.close();
  }
});

test("terminal statuses (migrated/reviewed/completed/skipped) are excluded from the vocabulary", () => {
  const db = createDb();
  try {
    for (const status of ["migrated", "reviewed", "completed", "skipped"]) {
      registerAndClaim(db, {
        artifactId: `legacy-source:com.acme:Terminal${status}`,
        status,
      });
    }

    const entries = queryRunStatusForUI(db);
    for (const status of ["migrated", "reviewed", "completed", "skipped"]) {
      assert.equal(
        findEntry(entries, `legacy-source:com.acme:Terminal${status}`),
        undefined,
        `expected no run-status entry for terminal status "${status}"`,
      );
    }
  } finally {
    db.close();
  }
});

test("every non-terminal artifact gets exactly one label", () => {
  const db = createDb();
  try {
    registerAndClaim(db, { artifactId: "legacy-source:com.acme:Plain", status: "planned" });
    const entries = queryRunStatusForUI(db);
    const labels = ["working", "idle", "waiting-for-approval", "rejected"];
    for (const entry of entries) {
      assert.ok(labels.includes(entry.label), `unexpected label ${entry.label}`);
    }
    // Exactly one entry per artifact id.
    const ids = entries.map((e) => e.artifact_id);
    assert.equal(new Set(ids).size, ids.length);
  } finally {
    db.close();
  }
});
