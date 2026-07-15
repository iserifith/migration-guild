import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { claimNextTask, createRunOperatorCredential } from "../registry/commands/claim";
import { registerArtifact, setArtifactStatus, setArtifactWave } from "../registry/commands/artifacts";
import { startRun } from "../registry/commands/runs";
import { applySchema } from "../registry/db/schema";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function planned(db: Database.Database, id: string): void {
  registerArtifact(db, {
    id,
    kind: "legacy-source",
    tier: "first-class",
    path: `legacy/src/main/java/${id.replaceAll(":", "/")}.java`,
  });
  setArtifactWave(db, id, 1);
  setArtifactStatus(db, id, "planned");
}

test("privileged role names cannot bypass active claim tokens", () => {
  const db = createDb();
  try {
    const id = "legacy-source:com.acme:ActorToken";
    startRun(db, { runId: "run-actor-token", agent: "code-writer-agent", ownerId: "owner-actor-token" });
    planned(db, id);
    claimNextTask(db, "code-writer-agent", undefined, "planned", "test-model", "first-class", "run-actor-token", "owner-actor-token");

    for (const agent of ["operator", "remediation-agent", "guildctl"]) {
      assert.throws(
        () => setArtifactStatus(db, id, "migrated", { agent }),
        /requires an active claim token or valid run operator credential/,
      );
    }
  } finally {
    db.close();
  }
});

test("run operator credential can finalize a claimed artifact without exposing claim token", () => {
  const db = createDb();
  try {
    const id = "legacy-source:com.acme:OperatorCredential";
    startRun(db, { runId: "run-operator-credential", agent: "guildctl-auto", ownerId: "guildctl-auto" });
    const credential = createRunOperatorCredential(db, "run-operator-credential");
    planned(db, id);
    claimNextTask(db, "code-writer-agent", undefined, "planned", "test-model", "first-class", "run-operator-credential", "worker-owner");

    setArtifactStatus(db, id, "migrated", {
      agent: "guildctl",
      runId: "run-operator-credential",
      operatorToken: credential.token,
    });

    const row = db.prepare("SELECT status FROM artifacts WHERE id = ?").get(id) as { status: string };
    assert.equal(row.status, "migrated");
  } finally {
    db.close();
  }
});

test("one run cannot hold more than one active artifact claim", () => {
  const db = createDb();
  try {
    startRun(db, { runId: "run-single-active", agent: "guildctl-auto", ownerId: "guildctl-auto" });
    planned(db, "legacy-source:com.acme:One");
    planned(db, "legacy-source:com.acme:Two");
    claimNextTask(db, "code-writer-agent", undefined, "planned", "test-model", "first-class", "run-single-active", "worker-owner");

    assert.throws(
      () => claimNextTask(db, "code-writer-agent", undefined, "planned", "test-model", "first-class", "run-single-active", "worker-owner"),
      /already has an active claim/,
    );
  } finally {
    db.close();
  }
});
