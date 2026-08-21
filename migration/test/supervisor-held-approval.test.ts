import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { runAuto } from "../guildctl/supervisor/loop";
import { runAutoQueue, type AutoQueueRemaining } from "../guildctl/supervisor/queue";
import { getClaimabilityStats, getStatusCounts } from "../guildctl/monitoring";
import { claimArtifactById, claimNextTask } from "../registry/commands/claim";
import { registerArtifact, setArtifactStatus, setArtifactWave } from "../registry/commands/artifacts";
import { applySchema } from "../registry/db/schema";
import { RegistryError } from "../registry/types";

// T009 (spec 013, US1): a `pending-approval` artifact is HELD awaiting a human
// decision — it is never claimable work, and the supervisor must surface it as
// "held for approval", never crash on it. Claim eligibility is already safe by
// construction (claimNextTask binds `status = @fromStatus` with explicit
// allow-lists; claimArtifactById allow-lists `fromStatuses`; the queue's
// selectCandidate filters by explicit status lists), so these tests pin the
// exclusion and the clean held-surfacing contract.

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function seedHeld(db: Database.Database, name: string): string {
  const id = `legacy-source:com.acme:${name}`;
  registerArtifact(db, { id, kind: "legacy-source", tier: "first-class", path: `legacy/${name}.java` });
  setArtifactWave(db, id, 1);
  setArtifactStatus(db, id, "pending-approval");
  return id;
}

test("T009: claimNextTask never claims a pending-approval artifact (excluded from claim eligibility)", () => {
  const db = createDb();
  try {
    const held = seedHeld(db, "HeldNotClaimable");
    // The ONLY artifact in the registry is pending-approval. Any fromStatus
    // must skip it: pending-approval is never in the claim allow-list.
    assert.throws(
      () => claimNextTask(db, "code-writer-agent", undefined, "planned"),
      (error: unknown) => {
        assert.ok(error instanceof RegistryError, `expected RegistryError, got ${error}`);
        return true;
      },
    );
    assert.throws(
      () => claimNextTask(db, "code-writer-agent", undefined, "migrated"),
      (error: unknown) => {
        assert.ok(error instanceof RegistryError, `expected RegistryError, got ${error}`);
        return true;
      },
    );
    // The held artifact is untouched — never moved to in-progress.
    const row = db.prepare("SELECT status FROM artifacts WHERE id = ?").get(held) as { status: string };
    assert.equal(row.status, "pending-approval");
  } finally {
    db.close();
  }
});

test("T009: claimArtifactById refuses a pending-approval artifact with a clean RegistryError, not a crash", () => {
  const db = createDb();
  try {
    const held = seedHeld(db, "HeldById");
    db.prepare("INSERT INTO runs (run_id, agent, owner_id, status) VALUES ('run-t009-claim', 'guildctl-auto', 'guildctl', 'running')").run();
    assert.throws(
      () =>
        claimArtifactById(db, {
          artifactId: held,
          agent: "code-writer-agent",
          ownerId: "guildctl-auto:test",
          runId: "run-t009-claim",
          fromStatuses: ["planned", "migrated", "blocked"],
        }),
      (error: unknown) => {
        assert.ok(error instanceof RegistryError, `expected RegistryError, got ${error}`);
        return true;
      },
    );
    const row = db.prepare("SELECT status FROM artifacts WHERE id = ?").get(held) as { status: string };
    assert.equal(row.status, "pending-approval");
  } finally {
    db.close();
  }
});

test("T009: runAuto surfaces a pending-approval artifact as held for approval — no claim, no crash, no status change", async () => {
  const db = createDb();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "guild-t009-held-"));
  try {
    fs.mkdirSync(path.join(workspace, "legacy"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "legacy", "HeldAuto.java"), "class HeldAuto {}\n");
    const held = seedHeld(db, "HeldAuto");

    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    const capture = (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      stderrChunks.push(String(chunk));
      return (originalWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
    };
    process.stderr.write = capture as typeof process.stderr.write;

    let result;
    try {
      result = await runAuto(db, {
        artifactId: held,
        workspaceRoot: workspace,
        commands: ["true"],
        worker: async () => {
          throw new Error("worker must not run for a held artifact");
        },
      });
    } finally {
      process.stderr.write = originalWrite;
    }

    // Held, surfaced distinctly — not blocked, not failed, not complete.
    assert.equal(result.status, "held");
    assert.equal((result as { heldForApproval?: boolean }).heldForApproval, true);
    // The artifact stays held; the supervisor neither advanced nor blocked it.
    const row = db.prepare("SELECT status FROM artifacts WHERE id = ?").get(held) as { status: string };
    assert.equal(row.status, "pending-approval");
    // The held-for-approval reason is surfaced on stderr, not a stack trace.
    assert.ok(
      stderrChunks.some((line) => /held for approval/i.test(line)),
      `expected a 'held for approval' stderr line, got: ${stderrChunks.join("")}`,
    );
  } finally {
    db.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("T009: the auto queue never dispatches a pending-approval artifact and counts it as held", async () => {
  const db = createDb();
  try {
    const held = seedHeld(db, "HeldInQueue");
    const calls: string[] = [];
    const result = await runAutoQueue(db, {
      executeArtifact: async ({ artifactId }) => {
        calls.push(artifactId);
        return { status: "complete", runId: "run-x", attempts: 1 };
      },
    });

    // Never selected for execution — held work is not claimable work.
    assert.deepEqual(calls, []);
    assert.equal(result.completed, 0);
    // The held artifact is surfaced in the remaining counts, distinct from blocked.
    assert.equal(result.remaining.heldForApproval, 1);
    const row = db.prepare("SELECT status FROM artifacts WHERE id = ?").get(held) as { status: string };
    assert.equal(row.status, "pending-approval");
  } finally {
    db.close();
  }
});

test("T009: runAutoQueue reports heldForApproval alongside blocked without conflating them", async () => {
  const db = createDb();
  try {
    seedHeld(db, "HeldOne");
    const blocked = `legacy-source:com.acme:BlockedOne`;
    registerArtifact(db, { id: blocked, kind: "legacy-source", tier: "first-class", path: "legacy/BlockedOne.java" });
    setArtifactWave(db, blocked, 1);
    setArtifactStatus(db, blocked, "blocked");

    const result = await runAutoQueue(db, {
      executeArtifact: async () => ({ status: "complete", runId: "run-y", attempts: 1 }),
    });

    const remaining: AutoQueueRemaining = result.remaining;
    assert.equal(remaining.heldForApproval, 1);
    assert.equal(remaining.blocked, 1);
  } finally {
    db.close();
  }
});

// T010 (spec 013, FR-005): the held-for-approval count must be exposed wherever
// run/queue status counts are reported — distinct from blocked.

test("T010: getStatusCounts reports pending-approval artifacts as held, distinct from blocked", () => {
  const db = createDb();
  try {
    seedHeld(db, "StatusHeld");
    const blocked = `legacy-source:com.acme:StatusBlocked`;
    registerArtifact(db, { id: blocked, kind: "legacy-source", tier: "first-class", path: "legacy/StatusBlocked.java" });
    setArtifactWave(db, blocked, 1);
    setArtifactStatus(db, blocked, "blocked");

    const counts = getStatusCounts(db);
    assert.equal(counts["pending-approval"], 1);
    assert.equal(counts["blocked"], 1);
  } finally {
    db.close();
  }
});

test("T010: getClaimabilityStats exposes an additive heldForApproval count distinct from blocked", () => {
  const db = createDb();
  try {
    seedHeld(db, "ClaimHeld");
    const blocked = `legacy-source:com.acme:ClaimBlocked`;
    registerArtifact(db, { id: blocked, kind: "legacy-source", tier: "first-class", path: "legacy/ClaimBlocked.java" });
    setArtifactWave(db, blocked, 1);
    setArtifactStatus(db, blocked, "blocked");

    const stats = getClaimabilityStats(db, "planned", undefined) as {
      total: number;
      ready: number;
      blocked: number;
      inProgress: number;
      heldForApproval?: number;
    };
    assert.equal(stats.heldForApproval, 1);
    assert.equal(stats.blocked, 0);
  } finally {
    db.close();
  }
});

test("T010: runAutoQueue remaining counts a seeded pending-approval artifact as heldForApproval", async () => {
  const db = createDb();
  try {
    seedHeld(db, "QueueHeldCount");
    const result = await runAutoQueue(db, {
      executeArtifact: async () => ({ status: "complete", runId: "run-z", attempts: 1 }),
    });
    assert.equal(result.remaining.heldForApproval, 1);
    assert.equal(result.remaining.blocked, 0);
  } finally {
    db.close();
  }
});
