import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { runVerify } from "../guildctl/verify";
import { createRunOperatorCredential } from "../registry/commands/claim";
import { registerArtifact, setArtifactStatus } from "../registry/commands/artifacts";
import { addAcceptanceEvidence, approveArtifactWithEvidence } from "../registry/commands/evidence";
import { startRun } from "../registry/commands/runs";
import { applySchema } from "../registry/db/schema";

const ARTIFACT_ID = "legacy-source:com.acme:RuntimeEvidence";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function seed(db: Database.Database): string {
  registerArtifact(db, {
    id: ARTIFACT_ID,
    kind: "legacy-source",
    tier: "first-class",
    path: "legacy/src/main/java/com/acme/RuntimeEvidence.java",
  });
  setArtifactStatus(db, ARTIFACT_ID, "migrated");
  startRun(db, { runId: "verify-run", agent: "guildctl-verify", ownerId: "guildctl" });
  return createRunOperatorCredential(db, "verify-run").token;
}

test("runVerify records passing runtime evidence with log hash and authenticity", async () => {
  const db = createDb();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "guild-runtime-pass-"));
  try {
    const operatorToken = seed(db);
    const result = await runVerify(db, {
      artifactId: ARTIFACT_ID,
      workspaceRoot: workspace,
      runId: "verify-run",
      commands: ["node -e \"console.log('build ok')\""],
      outputDir: path.join(workspace, ".guild", "evidence"),
      operatorToken,
    });

    assert.equal(result.pass, true);
    assert.equal(result.evidence.length, 1);
    assert.equal(result.evidence[0]?.evidence_type, "runtime");
    assert.equal(result.evidence[0]?.pass, 1);
    assert.ok(result.evidence[0]?.output_path);
    assert.match(result.evidence[0]?.output_excerpt ?? "", /build ok/);
    assert.match(result.evidence[0]?.log_sha256 ?? "", /^[a-f0-9]{64}$/);
    assert.match(result.evidence[0]?.authenticity ?? "", /^hmac-sha256:[a-f0-9]{64}$/);
  } finally {
    db.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("runVerify records failing runtime evidence and does not approve", async () => {
  const db = createDb();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "guild-runtime-fail-"));
  try {
    const operatorToken = seed(db);
    const result = await runVerify(db, {
      artifactId: ARTIFACT_ID,
      workspaceRoot: workspace,
      runId: "verify-run",
      commands: ["node -e \"console.error('build failed'); process.exit(7)\""],
      outputDir: path.join(workspace, ".guild", "evidence"),
      operatorToken,
    });

    assert.equal(result.pass, false);
    assert.equal(result.evidence[0]?.pass, 0);
    assert.equal(result.evidence[0]?.exit_code, 7);
    assert.throws(
      () => approveArtifactWithEvidence(db, { artifactId: ARTIFACT_ID, arbiter: "arbiter-agent", reason: "should fail" }),
      /latest runtime evidence failed/,
    );
  } finally {
    db.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("direct callers cannot create approvable runtime evidence", () => {
  const db = createDb();
  try {
    seed(db);
    assert.throws(
      () => addAcceptanceEvidence(db, {
        artifactId: ARTIFACT_ID,
        producedBy: "review-agent",
        evidenceType: "runtime",
        command: "npm test",
        exitCode: 0,
        pass: 1,
        summary: "forged runtime",
      }),
      /runtime evidence must be recorded by guildctl verify/,
    );
  } finally {
    db.close();
  }
});

test("legacy executable evidence remains readable but cannot approve runtime-gated work", () => {
  const db = createDb();
  try {
    seed(db);
    addAcceptanceEvidence(db, {
      artifactId: ARTIFACT_ID,
      producedBy: "critic-agent",
      evidenceType: "test-command",
      command: "npm test",
      exitCode: 0,
      pass: 1,
      summary: "legacy evidence",
    });

    assert.throws(
      () => approveArtifactWithEvidence(db, { artifactId: ARTIFACT_ID, arbiter: "arbiter-agent", reason: "legacy only" }),
      /no verifier-generated runtime evidence/,
    );
  } finally {
    db.close();
  }
});

test("approval rejects tampered runtime logs even with a valid operator credential", async () => {
  const db = createDb();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "guild-runtime-tamper-"));
  try {
    const operatorToken = seed(db);
    const result = await runVerify(db, {
      artifactId: ARTIFACT_ID,
      workspaceRoot: workspace,
      runId: "verify-run",
      operatorToken,
      commands: ["node -e \"console.log('build ok')\""],
      outputDir: path.join(workspace, ".guild", "evidence"),
    });
    fs.appendFileSync(result.evidence[0].output_path!, "tampered\n");

    assert.throws(
      () => approveArtifactWithEvidence(db, {
        artifactId: ARTIFACT_ID,
        arbiter: "arbiter-agent",
        reason: "tampered proof",
        runId: "verify-run",
        operatorToken,
      }),
      /log digest/i,
    );
  } finally {
    db.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("runVerify scrubs secret env vars from subprocesses and redacts leaked values", async () => {
  const db = createDb();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "guild-runtime-secret-"));
  const previous = process.env.ROOTSYS_API_KEY;
  process.env.ROOTSYS_API_KEY = "secret-value-for-redaction";
  try {
    const operatorToken = seed(db);
    const result = await runVerify(db, {
      artifactId: ARTIFACT_ID,
      workspaceRoot: workspace,
      runId: "verify-run",
      operatorToken,
      commands: [
        "node -e \"console.log(process.env.ROOTSYS_API_KEY || 'missing'); console.error('secret-value-for-redaction')\"",
      ],
      outputDir: path.join(workspace, ".guild", "evidence"),
    });

    const log = fs.readFileSync(result.evidence[0].output_path!, "utf8");
    assert.match(log, /missing/);
    assert.match(log, /<redacted>/);
    assert.doesNotMatch(log, /secret-value-for-redaction/);
    assert.doesNotMatch(result.evidence[0].output_excerpt ?? "", /secret-value-for-redaction/);
  } finally {
    if (previous === undefined) delete process.env.ROOTSYS_API_KEY;
    else process.env.ROOTSYS_API_KEY = previous;
    db.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
