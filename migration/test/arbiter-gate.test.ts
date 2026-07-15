import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { signRuntimeEvidence, sha256 } from "../guildctl/verify";
import { createRunOperatorCredential } from "../registry/commands/claim";
import { registerArtifact, setArtifactStatus } from "../registry/commands/artifacts";
import { getEvents } from "../registry/commands/events";
import {
  addAcceptanceEvidence,
  addVerifierRuntimeEvidence,
  approveArtifactWithEvidence,
  canApproveArtifact,
  getLatestArbitrationDecision,
  rejectArtifactWithEvidence,
} from "../registry/commands/evidence";
import { getArtifactById } from "../registry/commands/queries";
import { applySchema } from "../registry/db/schema";
import { RegistryError } from "../registry/types";

const ARTIFACT_ID = "legacy-source:com.acme.customer:LegacyCustomerService";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  registerArtifact(db, {
    id: ARTIFACT_ID,
    kind: "legacy-source",
    path: "legacy/src/main/java/com/acme/customer/LegacyCustomerService.java",
    tier: "first-class",
  });
  return db;
}

function markMigrated(db: Database.Database): void {
  setArtifactStatus(db, ARTIFACT_ID, "migrated", {
    agent: "builder-agent",
    reason: "builder submitted migration proposal",
  });
}

function signedRuntimeEvidence(
  db: Database.Database,
  opts: { producedBy?: string; pass?: 0 | 1; exitCode?: number; command?: string; log?: string } = {},
): { evidenceId: string; runId: string; operatorToken: string; dir: string } {
  const runId = `run-${Math.random().toString(16).slice(2)}`;
  db.prepare("INSERT INTO runs (run_id, agent, owner_id, status) VALUES (?, 'guildctl-verify', 'guildctl', 'running')").run(runId);
  const operatorToken = createRunOperatorCredential(db, runId).token;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guild-arbiter-evidence-"));
  const log = opts.log ?? "runtime ok\n";
  const logPath = path.join(dir, "runtime.log");
  fs.writeFileSync(logPath, log);
  const logSha256 = sha256(log);
  const command = opts.command ?? "npm test";
  const exitCode = opts.exitCode ?? 0;
  const pass = opts.pass ?? 1;
  const evidence = addVerifierRuntimeEvidence(db, {
    artifactId: ARTIFACT_ID,
    producedBy: opts.producedBy ?? "critic-agent",
    runId,
    command,
    exitCode,
    pass,
    summary: pass ? "runtime passed" : "runtime failed",
    outputPath: logPath,
    outputExcerpt: log,
    logSha256,
    durationMs: 10,
    authenticity: signRuntimeEvidence({ artifactId: ARTIFACT_ID, runId, command, exitCode, pass, logSha256 }, operatorToken),
  });
  return { evidenceId: evidence.evidence_id, runId, operatorToken, dir };
}

test("cannot approve a planned artifact", () => {
  const db = createDb();
  try {
    const result = canApproveArtifact(db, ARTIFACT_ID, "arbiter-agent");

    assert.equal(result.ok, false);
    assert.match(result.reason, /status.*migrated/i);
    assert.throws(
      () => approveArtifactWithEvidence(db, {
        artifactId: ARTIFACT_ID,
        arbiter: "arbiter-agent",
        reason: "accept proposal",
      }),
      RegistryError,
    );
    assert.equal(getArtifactById(db, ARTIFACT_ID).status, "pending");
  } finally {
    db.close();
  }
});

test("cannot approve a migrated artifact with no evidence", () => {
  const db = createDb();
  try {
    markMigrated(db);

    const result = canApproveArtifact(db, ARTIFACT_ID, "arbiter-agent");

    assert.equal(result.ok, false);
    assert.match(result.reason, /runtime evidence/i);
  } finally {
    db.close();
  }
});

test("cannot approve when latest executable evidence fails", () => {
  const db = createDb();
  const dirs: string[] = [];
  try {
    markMigrated(db);
    dirs.push(signedRuntimeEvidence(db).dir);
    const failing = signedRuntimeEvidence(db, { pass: 0, exitCode: 1, log: "tests failed after retry\n" });
    dirs.push(failing.dir);

    const result = canApproveArtifact(db, ARTIFACT_ID, "arbiter-agent");

    assert.equal(result.ok, false);
    assert.deepEqual(result.evidenceIds, [failing.evidenceId]);
    assert.match(result.reason, /runtime evidence failed/i);
  } finally {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    db.close();
  }
});

test("cannot approve when arbiter equals evidence producer", () => {
  const db = createDb();
  let dir: string | undefined;
  try {
    markMigrated(db);
    dir = signedRuntimeEvidence(db, { producedBy: "arbiter-agent", command: "npm run build" }).dir;

    const result = canApproveArtifact(db, ARTIFACT_ID, "arbiter-agent");

    assert.equal(result.ok, false);
    assert.match(result.reason, /arbiter.*evidence producer/i);
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    db.close();
  }
});

test("can approve with independent passing runtime evidence", () => {
  const db = createDb();
  try {
    markMigrated(db);
    const signed = signedRuntimeEvidence(db, { command: "npm test --prefix migration" });
    try {
      const decision = approveArtifactWithEvidence(db, {
        artifactId: ARTIFACT_ID,
        arbiter: "arbiter-agent",
        reason: "independent executable evidence passed",
        runId: signed.runId,
        operatorToken: signed.operatorToken,
      });

      assert.equal(decision.decision, "approved");
      assert.deepEqual(JSON.parse(decision.evidence_ids), [signed.evidenceId]);
      assert.equal(getArtifactById(db, ARTIFACT_ID).status, "reviewed");
      assert.equal(getLatestArbitrationDecision(db, ARTIFACT_ID)?.decision_id, decision.decision_id);
      const events = getEvents(db, ARTIFACT_ID, "arbitration-approved", 1);
      assert.equal(events.length, 1);
      assert.match(events[0].summary, /approved/i);
    } finally {
      fs.rmSync(signed.dir, { recursive: true, force: true });
    }
  } finally {
    db.close();
  }
});

test("rejection sets needs-rework and records decision", () => {
  const db = createDb();
  try {
    markMigrated(db);
    const evidence = addAcceptanceEvidence(db, {
      artifactId: ARTIFACT_ID,
      producedBy: "critic-agent",
      evidenceType: "test-command",
      command: "npm test",
      exitCode: 1,
      pass: 0,
      summary: "tests failed",
    });

    const decision = rejectArtifactWithEvidence(db, {
      artifactId: ARTIFACT_ID,
      arbiter: "arbiter-agent",
      reason: "tests failed",
      evidenceIds: [evidence.evidence_id],
    });

    assert.equal(decision.decision, "rejected");
    assert.deepEqual(JSON.parse(decision.evidence_ids), [evidence.evidence_id]);
    assert.equal(getArtifactById(db, ARTIFACT_ID).status, "needs-rework");
    const events = getEvents(db, ARTIFACT_ID, "arbitration-rejected", 1);
    assert.equal(events.length, 1);
    assert.match(events[0].summary, /rejected/i);
  } finally {
    db.close();
  }
});
