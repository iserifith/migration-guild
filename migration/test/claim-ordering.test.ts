import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { claimNextTask } from "../registry/commands/claim";
import { registerArtifact, setArtifactStatus, setArtifactWave } from "../registry/commands/artifacts";
import { startRun } from "../registry/commands/runs";
import { applySchema } from "../registry/db/schema";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function registerPlanned(
  db: Database.Database,
  id: string,
  wave: number,
  legacyPath?: string,
): void {
  registerArtifact(db, {
    id,
    kind: "legacy-source",
    tier: "first-class",
    path: legacyPath ?? `legacy/src/main/java/${id.replaceAll(":", "/")}.java`,
  });
  setArtifactWave(db, id, wave);
  setArtifactStatus(db, id, "planned");
}

function addSourceDependency(
  db: Database.Database,
  dependentId: string,
  dependencyId: string,
  signal: "import" | "inheritance" | "manual" = "import",
): void {
  db.prepare(
    `INSERT OR IGNORE INTO source_dependencies (dependent_id, dependency_id, signal, created_by)
     VALUES (?, ?, ?, 'auto')`,
  ).run(dependentId, dependencyId, signal);
}

test("#45: high-in-degree artifact claimed first within same wave", () => {
  const db = createDb();
  try {
    startRun(db, { runId: "run-1", agent: "code-writer-agent", ownerId: "owner-A" });

    // SystemGlobals has in_degree=2 (two dependents)
    registerPlanned(db, "legacy-source:net.jforum:SystemGlobals", 1);
    registerPlanned(db, "legacy-source:net.jforum.dao:FooDAOImpl", 1);
    registerPlanned(db, "legacy-source:net.jforum.dao:BarDAOImpl", 1);

    addSourceDependency(db, "legacy-source:net.jforum.dao:FooDAOImpl", "legacy-source:net.jforum:SystemGlobals");
    addSourceDependency(db, "legacy-source:net.jforum.dao:BarDAOImpl", "legacy-source:net.jforum:SystemGlobals");

    const claimed = claimNextTask(db, "code-writer-agent", undefined, "planned", undefined, "first-class", "run-1", "owner-A");

    // SystemGlobals should be claimed first because it has the highest in-degree
    assert.equal(claimed.id, "legacy-source:net.jforum:SystemGlobals");
  } finally {
    db.close();
  }
});

test("#45: equal in-degree ordered by created_at (deterministic)", () => {
  const db = createDb();
  try {
    startRun(db, { runId: "run-1", agent: "code-writer-agent", ownerId: "owner-A" });

    // Two artifacts with no source dependencies — should be ordered by created_at
    registerPlanned(db, "legacy-source:com.acme:First", 1);
    registerPlanned(db, "legacy-source:com.acme:Second", 1);

    const claimed = claimNextTask(db, "code-writer-agent", undefined, "planned", undefined, "first-class", "run-1", "owner-A");

    // First registered should be claimed first
    assert.equal(claimed.id, "legacy-source:com.acme:First");
  } finally {
    db.close();
  }
});

test("#45: in-degree is a hint not a gate — non-planned high-in-degree artifact is skipped", () => {
  const db = createDb();
  try {
    startRun(db, { runId: "run-1", agent: "code-writer-agent", ownerId: "owner-A" });

    registerPlanned(db, "legacy-source:net.jforum:SystemGlobals", 1);
    registerPlanned(db, "legacy-source:net.jforum.dao:FooDAOImpl", 1);

    addSourceDependency(db, "legacy-source:net.jforum.dao:FooDAOImpl", "legacy-source:net.jforum:SystemGlobals");

    // Set SystemGlobals to 'analyzed' — it's not in the 'planned' pool
    setArtifactStatus(db, "legacy-source:net.jforum:SystemGlobals", "analyzed");

    // Claim from 'planned' pool — only FooDAOImpl is planned
    const claimed = claimNextTask(db, "code-writer-agent", undefined, "planned", undefined, "first-class", "run-1", "owner-A");

    assert.equal(claimed.id, "legacy-source:net.jforum.dao:FooDAOImpl");
  } finally {
    db.close();
  }
});

test("#45: serial mode benefits — after high-in-degree migrates, dependents become claimable", () => {
  const db = createDb();
  try {
    startRun(db, { runId: "run-1", agent: "code-writer-agent", ownerId: "owner-A" });

    registerPlanned(db, "legacy-source:net.jforum:SystemGlobals", 1);
    registerPlanned(db, "legacy-source:net.jforum.dao:FooDAOImpl", 1);
    registerPlanned(db, "legacy-source:net.jforum.dao:BarDAOImpl", 1);

    addSourceDependency(db, "legacy-source:net.jforum.dao:FooDAOImpl", "legacy-source:net.jforum:SystemGlobals");
    addSourceDependency(db, "legacy-source:net.jforum.dao:BarDAOImpl", "legacy-source:net.jforum:SystemGlobals");

    // First claim: SystemGlobals (highest in-degree)
    const first = claimNextTask(db, "code-writer-agent", undefined, "planned", undefined, "first-class", "run-1", "owner-A");
    assert.equal(first.id, "legacy-source:net.jforum:SystemGlobals");

    // Complete SystemGlobals
    setArtifactStatus(db, "legacy-source:net.jforum:SystemGlobals", "migrated", {
      agent: "code-writer-agent",
      claimId: first.claim_id,
      claimToken: first.claim_token,
      runId: "run-1",
    });

    // Second claim: one of the dependents (both have in_degree=0 now)
    const second = claimNextTask(db, "code-writer-agent", undefined, "planned", undefined, "first-class", "run-1", "owner-A");
    assert.ok(
      second.id === "legacy-source:net.jforum.dao:FooDAOImpl" ||
      second.id === "legacy-source:net.jforum.dao:BarDAOImpl",
      `expected a DAOImpl, got ${second.id}`,
    );
  } finally {
    db.close();
  }
});

test("#45: cross-wave dependents don't prevent in-degree ordering within wave", () => {
  const db = createDb();
  try {
    startRun(db, { runId: "run-1", agent: "code-writer-agent", ownerId: "owner-A" });

    // SystemGlobals in wave 1 with dependents in wave 2
    registerPlanned(db, "legacy-source:net.jforum:SystemGlobals", 1);
    registerPlanned(db, "legacy-source:net.jforum:Wave1Standalone", 1);
    registerPlanned(db, "legacy-source:net.jforum:Wave2Dependent", 2);

    addSourceDependency(db, "legacy-source:net.jforum:Wave2Dependent", "legacy-source:net.jforum:SystemGlobals");

    // Claiming from wave 1 — SystemGlobals has in_degree=1, Standalone has in_degree=0
    const claimed = claimNextTask(db, "code-writer-agent", 1, "planned", undefined, "first-class", "run-1", "owner-A");

    assert.equal(claimed.id, "legacy-source:net.jforum:SystemGlobals");
  } finally {
    db.close();
  }
});
