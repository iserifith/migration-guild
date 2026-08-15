import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { claimArtifactById, claimNextTask } from "../registry/commands/claim";
import { registerArtifact, setArtifactStatus, setArtifactWave } from "../registry/commands/artifacts";
import { startRun } from "../registry/commands/runs";
import { applySchema } from "../registry/db/schema";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function registerPlanned(db: Database.Database, id: string, wave = 1): void {
  registerArtifact(db, {
    id,
    kind: "legacy-source",
    tier: "first-class",
    path: `legacy/src/main/java/${id.replaceAll(":", "/")}.java`,
  });
  setArtifactWave(db, id, wave);
  setArtifactStatus(db, id, "planned");
}

function setRiskDecision(db: Database.Database, id: string, decision: "pending" | "confirmed" | "declined"): void {
  db.prepare(
    `INSERT INTO risk_confirmations (artifact_id, decision, decided_by, decided_at)
     VALUES (?, ?, CASE WHEN ? = 'pending' THEN NULL ELSE 'operator' END,
                      CASE WHEN ? = 'pending' THEN NULL ELSE datetime('now') END)
     ON CONFLICT(artifact_id) DO UPDATE SET decision = excluded.decision`,
  ).run(id, decision, decision, decision);
}

const next = (db: Database.Database) =>
  claimNextTask(db, "code-writer-agent", undefined, "planned", undefined, "first-class", "run-1", "owner-A");

test("pending high-risk artifact is not selected by claimNextTask (US3)", () => {
  const db = createDb();
  try {
    startRun(db, { runId: "run-1", agent: "code-writer-agent", ownerId: "owner-A" });
    registerPlanned(db, "legacy-source:com.acme:Risky");
    registerPlanned(db, "legacy-source:com.acme:Safe");
    setRiskDecision(db, "legacy-source:com.acme:Risky", "pending");

    const claimed = next(db);
    assert.equal(claimed.id, "legacy-source:com.acme:Safe", "pending artifact is skipped in favor of safe work");
  } finally {
    db.close();
  }
});

test("declined high-risk artifact is not selected by claimNextTask", () => {
  const db = createDb();
  try {
    startRun(db, { runId: "run-1", agent: "code-writer-agent", ownerId: "owner-A" });
    registerPlanned(db, "legacy-source:com.acme:Declined");
    registerPlanned(db, "legacy-source:com.acme:Safe");
    setRiskDecision(db, "legacy-source:com.acme:Declined", "declined");

    assert.equal(next(db).id, "legacy-source:com.acme:Safe");
  } finally {
    db.close();
  }
});

test("confirmed artifact and no-row artifact are both claimable via claimNextTask", () => {
  const db = createDb();
  try {
    startRun(db, { runId: "run-1", agent: "code-writer-agent", ownerId: "owner-A" });
    registerPlanned(db, "legacy-source:com.acme:WasRisky");
    setRiskDecision(db, "legacy-source:com.acme:WasRisky", "confirmed");
    assert.equal(next(db).id, "legacy-source:com.acme:WasRisky");
  } finally {
    db.close();
  }
});

test("claimArtifactById rejects pending/declined, allows confirmed (US3)", () => {
  const db = createDb();
  try {
    startRun(db, { runId: "run-1", agent: "code-writer-agent", ownerId: "owner-A" });
    registerPlanned(db, "legacy-source:com.acme:Pending");
    registerPlanned(db, "legacy-source:com.acme:Declined");
    registerPlanned(db, "legacy-source:com.acme:Confirmed");
    setRiskDecision(db, "legacy-source:com.acme:Pending", "pending");
    setRiskDecision(db, "legacy-source:com.acme:Declined", "declined");
    setRiskDecision(db, "legacy-source:com.acme:Confirmed", "confirmed");

    assert.throws(
      () => claimArtifactById(db, { artifactId: "legacy-source:com.acme:Pending", agent: "code-writer-agent", ownerId: "owner-A", runId: "run-1" }),
      /pending human risk confirmation/i,
    );
    assert.throws(
      () => claimArtifactById(db, { artifactId: "legacy-source:com.acme:Declined", agent: "code-writer-agent", ownerId: "owner-A", runId: "run-1" }),
      /declined for migration|pending human risk confirmation/i,
    );
    const claimed = claimArtifactById(db, { artifactId: "legacy-source:com.acme:Confirmed", agent: "code-writer-agent", ownerId: "owner-A", runId: "run-1" });
    assert.equal(claimed.id, "legacy-source:com.acme:Confirmed");
  } finally {
    db.close();
  }
});

test("artifact with no risk_confirmations row claims normally via claimArtifactById (FR-013)", () => {
  const db = createDb();
  try {
    startRun(db, { runId: "run-1", agent: "code-writer-agent", ownerId: "owner-A" });
    registerPlanned(db, "legacy-source:com.acme:Plain");
    const claimed = claimArtifactById(db, { artifactId: "legacy-source:com.acme:Plain", agent: "code-writer-agent", ownerId: "owner-A", runId: "run-1" });
    assert.equal(claimed.id, "legacy-source:com.acme:Plain");
  } finally {
    db.close();
  }
});
