import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { runArbitrate } from "../guildctl/commands/arbitrate";
import { signRuntimeEvidence, sha256 } from "../guildctl/verify";
import { createRunOperatorCredential } from "../registry/commands/claim";
import { registerArtifact, setArtifactStatus } from "../registry/commands/artifacts";
import { addVerifierRuntimeEvidence } from "../registry/commands/evidence";
import { getArtifactById } from "../registry/commands/queries";
import { applySchema } from "../registry/db/schema";
import { RegistryError } from "../registry/types";
import { DEFAULT_GUILD_CONFIG, stringifySimpleYaml } from "../guildctl/config";
import { makeTempDir, repoMigrationRoot, tsxLoaderUrl } from "./truthful-run-state-fixtures";

// US1 (#153) / T002: manual `guildctl arbitrate` must be usable outside an
// `auto` run. Before the fix, `runArbitrate` never passed runId/operatorToken,
// so every manual `--approve` failed with an uncaught
// `Approval requires a valid run operator credential.` RegistryError (raw Node
// stack trace). The registry's evidence-authenticity design (HMAC bound to the
// *signing* run's operator token) means approval requires the credential of the
// run that produced the evidence — the CLI now accepts that via --run-id/
// --operator-token; anything else fails as a clean, single-line RegistryError.

const ARTIFACT_ID = "legacy-source:com.acme.manual:ManualArbitrationService";
const OTHER_ARTIFACT_ID = "legacy-source:com.acme.manual:ManualArbitrationServiceB";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  for (const [id, cls] of [
    [ARTIFACT_ID, "ManualArbitrationService"],
    [OTHER_ARTIFACT_ID, "ManualArbitrationServiceB"],
  ] as const) {
    registerArtifact(db, {
      id,
      kind: "legacy-source",
      path: `legacy/src/main/java/com/acme/manual/${cls}.java`,
      tier: "first-class",
    });
  }
  return db;
}

function markMigrated(db: Database.Database, artifactId: string): void {
  setArtifactStatus(db, artifactId, "migrated", {
    agent: "builder-agent",
    reason: "builder submitted migration proposal",
  });
}

/**
 * Verifier-signed runtime evidence under its own run + operator credential —
 * the state a manual `guildctl arbitrate` arrives at after a pipeline verify
 * step, with no `auto` supervisor session active.
 */
function signedRuntimeEvidence(
  db: Database.Database,
  opts: { artifactId: string; producedBy?: string },
): { evidenceId: string; runId: string; operatorToken: string; dir: string } {
  const runId = `run-${Math.random().toString(16).slice(2)}`;
  db.prepare("INSERT INTO runs (run_id, agent, owner_id, status) VALUES (?, 'guildctl-verify', 'guildctl', 'running')").run(runId);
  const operatorToken = createRunOperatorCredential(db, runId).token;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guild-arbitrate-manual-"));
  const log = "runtime ok\n";
  const logPath = path.join(dir, "runtime.log");
  fs.writeFileSync(logPath, log);
  const logSha256 = sha256(log);
  const command = "npm test";
  const exitCode = 0;
  const pass = 1 as const;
  const evidence = addVerifierRuntimeEvidence(db, {
    artifactId: opts.artifactId,
    producedBy: opts.producedBy ?? "critic-agent",
    runId,
    command,
    exitCode,
    pass,
    summary: "runtime passed",
    outputPath: logPath,
    outputExcerpt: log,
    logSha256,
    durationMs: 10,
    authenticity: signRuntimeEvidence({ artifactId: opts.artifactId, runId, command, exitCode, pass, logSha256 }, operatorToken),
  });
  return { evidenceId: evidence.evidence_id, runId, operatorToken, dir };
}

test("US1: manual approve succeeds when --run-id/--operator-token for the evidence's run are supplied", async () => {
  const db = createDb();
  try {
    markMigrated(db, ARTIFACT_ID);
    const ev = signedRuntimeEvidence(db, { artifactId: ARTIFACT_ID });

    await runArbitrate(db, {
      artifact: ARTIFACT_ID,
      approve: true,
      arbiter: "operator",
      reason: "manual review ok",
      evidence: [ev.evidenceId],
      runId: ev.runId,
      operatorToken: ev.operatorToken,
    });

    assert.equal(getArtifactById(db, ARTIFACT_ID).status, "reviewed");
  } finally {
    db.close();
  }
});

test("US1: runArbitrate rejects a migrated artifact manually and moves it to needs-rework", async () => {
  const db = createDb();
  try {
    markMigrated(db, OTHER_ARTIFACT_ID);

    await runArbitrate(db, {
      artifact: OTHER_ARTIFACT_ID,
      reject: true,
      arbiter: "operator",
      reason: "manual review rejected the proposal",
    });

    assert.equal(getArtifactById(db, OTHER_ARTIFACT_ID).status, "needs-rework");
  } finally {
    db.close();
  }
});

test("US1: an explicit --run-id whose credential is missing is a clean RegistryError, not an uncaught exception", async () => {
  const db = createDb();
  try {
    markMigrated(db, ARTIFACT_ID);
    const ev = signedRuntimeEvidence(db, { artifactId: ARTIFACT_ID });

    // Run exists but its operator credential row was deleted: validation must
    // fail cleanly with the registry's own single-line message.
    db.prepare("DELETE FROM run_operator_credentials WHERE run_id = ?").run(ev.runId);

    await assert.rejects(
      runArbitrate(db, {
        artifact: ARTIFACT_ID,
        approve: true,
        arbiter: "operator",
        reason: "manual review ok",
        evidence: [ev.evidenceId],
        runId: ev.runId,
      }),
      (error: unknown) => {
        assert.ok(error instanceof RegistryError, `expected RegistryError, got ${error}`);
        assert.match(error.message, /credential/i);
        return true;
      },
    );
    assert.equal(getArtifactById(db, ARTIFACT_ID).status, "migrated");
  } finally {
    db.close();
  }
});

test("US1: a run-id/token pair that does not match the evidence run is a clean RegistryError", async () => {
  const db = createDb();
  try {
    markMigrated(db, ARTIFACT_ID);
    const ev = signedRuntimeEvidence(db, { artifactId: ARTIFACT_ID });

    // A *different* run's valid credential: validateRuntimeEvidence must reject
    // the mismatch as a RegistryError with a single clean message.
    await assert.rejects(
      runArbitrate(db, {
        artifact: ARTIFACT_ID,
        approve: true,
        arbiter: "operator",
        reason: "manual review ok",
        evidence: [ev.evidenceId],
        runId: "run-does-not-match-evidence",
        operatorToken: ev.operatorToken,
      }),
      (error: unknown) => {
        assert.ok(error instanceof RegistryError, `expected RegistryError, got ${error}`);
        return true;
      },
    );
    assert.equal(getArtifactById(db, ARTIFACT_ID).status, "migrated");
  } finally {
    db.close();
  }
});

test("US1: an arbiter identical to the evidence producer is refused with a clean RegistryError (independence check)", async () => {
  const db = createDb();
  try {
    markMigrated(db, ARTIFACT_ID);
    const ev = signedRuntimeEvidence(db, { artifactId: ARTIFACT_ID, producedBy: "operator" });

    await assert.rejects(
      runArbitrate(db, {
        artifact: ARTIFACT_ID,
        approve: true,
        arbiter: "operator",
        reason: "self approval attempt",
        evidence: [ev.evidenceId],
        runId: ev.runId,
        operatorToken: ev.operatorToken,
      }),
      (error: unknown) => {
        assert.ok(error instanceof RegistryError, `expected RegistryError, got ${error}`);
        assert.match(error.message, /independent/i);
        return true;
      },
    );
    assert.equal(getArtifactById(db, ARTIFACT_ID).status, "migrated");
  } finally {
    db.close();
  }
});

// ─── CLI boundary (T006): clean message + exit code, no stack trace ─────────

const repoRoot = path.resolve(repoMigrationRoot(), "..");

function fixtureWorkspace(): string {
  const root = makeTempDir("guild-arbitrate-cli-");
  fs.mkdirSync(path.join(root, ".guild"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".guild", "config.yaml"),
    stringifySimpleYaml({ ...DEFAULT_GUILD_CONFIG, stack: "java-spring" } as unknown as Record<string, unknown>),
  );
  return root;
}

function runCli(root: string, dbPath: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ["--import", tsxLoaderUrl(), path.join(repoMigrationRoot(), "guildctl", "cli.ts"), "--workspace", root, "--db", dbPath, ...args],
    {
      cwd: repoMigrationRoot(),
      encoding: "utf8",
      env: { ...process.env, DOTENV_CONFIG_SILENT: "true" },
    },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("US1: guildctl arbitrate --approve via the CLI exits 0 with a confirmation, no stack trace", async () => {
  const root = fixtureWorkspace();
  try {
    const dbPath = path.join(root, ".guild", "registry.db");
    const db = new Database(dbPath);
    let ev;
    try {
      applySchema(db);
      registerArtifact(db, { id: ARTIFACT_ID, kind: "legacy-source", tier: "first-class", path: "legacy/x.java" });
      setArtifactStatus(db, ARTIFACT_ID, "migrated", { agent: "builder-agent", reason: "done" });
      ev = signedRuntimeEvidence(db, { artifactId: ARTIFACT_ID });
    } finally {
      db.close();
    }

    const { status, stdout, stderr } = runCli(root, dbPath, [
      "arbitrate",
      "--artifact", ARTIFACT_ID,
      "--approve",
      "--arbiter", "operator",
      "--reason", "manual review ok",
      "--evidence", ev!.evidenceId,
      "--run-id", ev!.runId,
      "--operator-token", ev!.operatorToken,
    ]);

    assert.equal(status, 0, `expected exit 0\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    assert.match(stdout, /approved/i);
    assert.doesNotMatch(stderr, /Command\.listener|at\s|node_modules[\\/]commander/);

    const after = new Database(dbPath);
    try {
      assert.equal(getArtifactById(after, ARTIFACT_ID).status, "reviewed");
    } finally {
      after.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("US1: guildctl arbitrate --approve with a bad credential exits non-zero with one clean stderr line, no stack trace", async () => {
  const root = fixtureWorkspace();
  try {
    const dbPath = path.join(root, ".guild", "registry.db");
    const db = new Database(dbPath);
    let ev;
    try {
      applySchema(db);
      registerArtifact(db, { id: ARTIFACT_ID, kind: "legacy-source", tier: "first-class", path: "legacy/x.java" });
      setArtifactStatus(db, ARTIFACT_ID, "migrated", { agent: "builder-agent", reason: "done" });
      ev = signedRuntimeEvidence(db, { artifactId: ARTIFACT_ID });
      db.prepare("DELETE FROM run_operator_credentials WHERE run_id = ?").run(ev.runId);
    } finally {
      db.close();
    }

    const { status, stderr } = runCli(root, dbPath, [
      "arbitrate",
      "--artifact", ARTIFACT_ID,
      "--approve",
      "--arbiter", "operator",
      "--reason", "manual review ok",
      "--evidence", ev!.evidenceId,
      "--run-id", ev!.runId,
      "--operator-token", "garbage-token",
    ]);

    assert.notEqual(status, 0, `expected non-zero exit, got ${status}\nstderr:\n${stderr}`);
    assert.match(stderr, /credential/i);
    // The whole point of #153: no raw commander/Node stack trace on stderr.
    assert.doesNotMatch(stderr, /Command\.listener|Command\._parseCommand|node_modules[\\/]commander/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
