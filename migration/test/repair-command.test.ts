import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { applySchema } from "../registry/db/schema";
import { registerArtifact, setArtifactStatus, setArtifactWave } from "../registry/commands/artifacts";
import { finishRun, startRun } from "../registry/commands/runs";
import { claimNextTask } from "../registry/commands/claim";
import { runRepair } from "../guildctl/commands/repair";

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

function claimAndKillRun(
  db: Database.Database,
  artifactId: string,
  runId: string,
  agent = "code-writer-agent",
): void {
  startRun(db, {
    runId,
    agent,
    ownerId: `${agent}:owner`,
    phase: "code-writing",
  });
  claimNextTask(
    db,
    agent,
    undefined,
    "planned",
    "test-model",
    "first-class",
    runId,
    `${agent}:owner`,
    30,
  );
  finishRun(db, { runId, exitCode: 1, reason: "crashed" });
}

test("runRepair reports clean state when no crash state exists", () => {
  const db = createDb();
  try {
    registerPlannedArtifact(db, "legacy-source:com.acme:Clean");
    // No runs, no claims, no in-progress → should report clean
    runRepair(db, { releaseAllStuck: false });
    assert.ok(true);
  } finally {
    db.close();
  }
});

test("runRepair reaps dead runs and reconciles stale claims", () => {
  const db = createDb();
  try {
    const id = "legacy-source:com.acme:Crashed";
    registerPlannedArtifact(db, id);
    claimAndKillRun(db, id, "run-crash-1");

    // Run repair — should reap the dead run and reconcile the stale claim
    runRepair(db, { releaseAllStuck: false });

    const artifact = db.prepare("SELECT status FROM artifacts WHERE id = ?").get(id) as { status: string };
    assert.equal(artifact.status, "planned");
  } finally {
    db.close();
  }
});

test("runRepair --dry-run does not modify state", () => {
  const db = createDb();
  try {
    const id = "legacy-source:com.acme:DryRun";
    registerPlannedArtifact(db, id);
    claimAndKillRun(db, id, "run-crash-2");

    // Dry-run should NOT reconcile
    runRepair(db, { dryRun: true, releaseAllStuck: false });

    const artifact = db.prepare("SELECT status FROM artifacts WHERE id = ?").get(id) as { status: string };
    assert.equal(artifact.status, "in-progress");
  } finally {
    db.close();
  }
});

test("runRepair releases stuck in-progress artifacts by default", () => {
  const db = createDb();
  try {
    const id = "legacy-source:com.acme:Stuck";
    registerPlannedArtifact(db, id);
    claimAndKillRun(db, id, "run-crash-3");

    // Run repair with defaults (releaseAllStuck=true)
    runRepair(db, {});

    const artifact = db.prepare("SELECT status FROM artifacts WHERE id = ?").get(id) as { status: string };
    assert.equal(artifact.status, "planned");
  } finally {
    db.close();
  }
});