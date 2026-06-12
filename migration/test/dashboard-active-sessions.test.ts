import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { printInProgress } from "../legmod/dashboard";
import { registerArtifact } from "../registry/commands/artifacts";
import { applySchema } from "../registry/db/schema";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    chunks.push(args.map(String).join(" "));
  };

  try {
    fn();
  } finally {
    console.log = originalLog;
  }

  return chunks.join("\n");
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

test("printInProgress shows only live claimed sessions", () => {
  const db = createDb();

  try {
    registerArtifact(db, {
      id: "legacy-source:com.acme:Fresh",
      kind: "legacy-source",
      tier: "first-class",
      path: "legacy/Fresh.java",
    });
    registerArtifact(db, {
      id: "legacy-source:com.acme:Expired",
      kind: "legacy-source",
      tier: "first-class",
      path: "legacy/Expired.java",
    });
    registerArtifact(db, {
      id: "legacy-source:com.acme:Stopped",
      kind: "legacy-source",
      tier: "first-class",
      path: "legacy/Stopped.java",
    });

    db.exec(`
      UPDATE artifacts
      SET status = 'in-progress', claimed_by = 'test-agent', claimed_at = datetime('now', '-5 minutes')
      WHERE id = 'legacy-source:com.acme:Fresh';
      UPDATE artifacts
      SET status = 'in-progress', claimed_by = 'test-agent', claimed_at = datetime('now', '-200 minutes')
      WHERE id = 'legacy-source:com.acme:Expired';
      UPDATE artifacts
      SET status = 'in-progress', claimed_by = 'test-agent', claimed_at = datetime('now', '-120 minutes')
      WHERE id = 'legacy-source:com.acme:Stopped';

      INSERT INTO runs (run_id, agent, status)
      VALUES ('run-live', 'test-agent', 'running');

      INSERT INTO runs (run_id, agent, status, finished_at)
      VALUES ('run-dead', 'test-agent', 'failed', datetime('now', '-90 minutes'));

      INSERT INTO artifact_claims (
        claim_id, artifact_id, run_id, owner_id, agent, from_status,
        claim_token, state, attempt_no, claimed_at, heartbeat_at, lease_expires_at
      ) VALUES (
        'claim-live', 'legacy-source:com.acme:Fresh', 'run-live', 'test-agent', 'test-agent', 'planned',
        'token-live', 'active', 1, datetime('now', '-5 minutes'), datetime('now', '-1 minutes'), datetime('now', '+25 minutes')
      );

      INSERT INTO artifact_claims (
        claim_id, artifact_id, run_id, owner_id, agent, from_status,
        claim_token, state, attempt_no, claimed_at, heartbeat_at, lease_expires_at
      ) VALUES (
        'claim-expired', 'legacy-source:com.acme:Expired', 'run-live', 'test-agent', 'test-agent', 'planned',
        'token-expired', 'active', 1, datetime('now', '-200 minutes'), datetime('now', '-120 minutes'), datetime('now', '-30 minutes')
      );

      INSERT INTO artifact_claims (
        claim_id, artifact_id, run_id, owner_id, agent, from_status,
        claim_token, state, attempt_no, claimed_at, heartbeat_at, lease_expires_at
      ) VALUES (
        'claim-stopped', 'legacy-source:com.acme:Stopped', 'run-dead', 'test-agent', 'test-agent', 'planned',
        'token-stopped', 'active', 1, datetime('now', '-120 minutes'), datetime('now', '-110 minutes'), datetime('now', '+25 minutes')
      );
    `);

    const output = stripAnsi(captureStdout(() => {
      printInProgress(db);
    }));

    assert.match(output, /Active Sessions/);
    assert.match(output, /Fresh\.java/);
    assert.doesNotMatch(output, /Expired\.java/);
    assert.doesNotMatch(output, /Stopped\.java/);
  } finally {
    db.close();
  }
});
