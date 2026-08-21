import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { runAuto } from "../guildctl/supervisor/loop";
import { runVerify } from "../guildctl/verify";
import { claimArtifactById, createRunOperatorCredential } from "../registry/commands/claim";
import { registerArtifact, setArtifactStatus, setArtifactWave } from "../registry/commands/artifacts";
import { startRun } from "../registry/commands/runs";
import { applySchema } from "../registry/db/schema";
import { RegistryError } from "../registry/types";
import { repoMigrationRoot } from "./truthful-run-state-fixtures";

// US3 (#155): resuming a `blocked` artifact. Before the fix the supervisor only
// ever reclaimed from `planned`/`migrated`, so `--resume` on a blocked artifact
// crashed with an uncaught RegistryError ("expected \"planned\"") instead of
// either resuming cleanly or failing with one clean line. These tests pin both
// the successful resume and the clean-failure contract.

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function seedBlocked(db: Database.Database, name: string): string {
  const id = `legacy-source:com.acme:${name}`;
  registerArtifact(db, { id, kind: "legacy-source", tier: "first-class", path: `legacy/${name}.java` });
  setArtifactWave(db, id, 1);
  setArtifactStatus(db, id, "blocked");
  return id;
}

test("US3: a blocked artifact resumes cleanly through the supervisor without an uncaught RegistryError", async () => {
  const db = createDb();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "guild-us3-resume-blocked-"));
  try {
    fs.mkdirSync(path.join(workspace, "legacy"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "legacy", "BlockedResume.js"), "module.exports = 0;\n");
    fs.mkdirSync(path.join(workspace, "modern"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "modern", "BlockedResume.js"), "function ok() { return 1; }\n");
    const id = seedBlocked(db, "BlockedResume");

    // A blocked artifact resumed with a passing verifier drives straight to
    // review + approval — no claim error, no stack trace. Leave `verify`
    // unset so runAuto uses its default verifier, which binds the runtime
    // evidence to the supervisor's own run + operator token; the arbitration
    // approval below then validates that same credential.
    const result = await runAuto(db, {
      artifactId: id,
      workspaceRoot: workspace,
      commands: ["node --check modern/BlockedResume.js"],
      resume: true,
      worker: async () => {
        throw new Error("worker must not run for a blocked artifact whose verify passes");
      },
      review: async () => ({
        approved: true,
        reason: "blocked artifact re-verified clean",
        reviewerAgent: "review-agent",
        reviewerModel: "review-model",
      }),
    });

    assert.equal(result.status, "complete");
    const row = db.prepare("SELECT status FROM artifacts WHERE id = ?").get(id) as { status: string };
    assert.equal(row.status, "reviewed");
  } finally {
    db.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("US3: runAuto seeds its attempt counter from persisted attempt_records on resume (no UNIQUE collision)", async () => {
  const db = createDb();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "guild-us3-resume-attempts-"));
  try {
    fs.mkdirSync(path.join(workspace, "legacy"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "legacy", "AttemptResume.js"), "module.exports = 0;\n");
    fs.mkdirSync(path.join(workspace, "modern"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "modern", "AttemptResume.js"), "function ok() { return 1; }\n");
    const id = seedBlocked(db, "AttemptResume");

    // Two attempts already persisted from a prior (crashed/restarted) run.
    // Before the fix, runAuto's local `attempts` counter always started at 0,
    // so the first attempt of a resumed run would try to record attempt_no=1
    // again and throw on attempt_records' UNIQUE(artifact_id, attempt_no).
    db.prepare(
      `INSERT INTO attempt_records (artifact_id, attempt_no, phase, outcome, failure_kind, started_at)
       VALUES (?, 1, 'migrate', 'failed', 'build-failure', datetime('now')),
              (?, 2, 'repair', 'failed', 'build-failure', datetime('now'))`,
    ).run(id, id);

    const result = await runAuto(db, {
      artifactId: id,
      workspaceRoot: workspace,
      commands: ["node --check modern/AttemptResume.js"],
      resume: true,
      worker: async () => {
        throw new Error("worker must not run for a blocked artifact whose verify passes");
      },
      review: async () => ({
        approved: true,
        reason: "blocked artifact re-verified clean",
        reviewerAgent: "review-agent",
        reviewerModel: "review-model",
      }),
    });

    assert.equal(result.status, "complete");
    // The counter picked up where persisted history left off instead of
    // resetting to 0 and colliding with the already-persisted rows.
    assert.equal(result.attempts, 2);
  } finally {
    db.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("US3: claimArtifactById accepts blocked as a resume-eligible from-status", () => {
  const db = createDb();
  try {
    const id = seedBlocked(db, "ClaimFromBlocked");
    db.prepare("INSERT INTO runs (run_id, agent, owner_id, status) VALUES ('run-us3-claim', 'guildctl-auto', 'guildctl', 'running')").run();
    const claim = claimArtifactById(db, {
      artifactId: id,
      agent: "code-writer-agent",
      ownerId: "guildctl-auto:test",
      runId: "run-us3-claim",
      fromStatuses: ["planned", "blocked"],
    });
    assert.equal(claim.id, id);
    const claimRow = db.prepare("SELECT from_status FROM artifact_claims WHERE claim_id = ?").get(claim.claim_id) as { from_status: string };
    assert.equal(claimRow.from_status, "blocked");
    const row = db.prepare("SELECT status FROM artifacts WHERE id = ?").get(id) as { status: string };
    assert.equal(row.status, "in-progress");
  } finally {
    db.close();
  }
});

test("US3: a resume that still cannot proceed fails as a clean single-line RegistryError, not a stack trace", async () => {
  const db = createDb();
  try {
    // reviewed is not a resume-eligible status, so this must reject cleanly.
    const id = `legacy-source:com.acme:NotResumable`;
    registerArtifact(db, { id, kind: "legacy-source", tier: "first-class", path: "legacy/NotResumable.java" });
    setArtifactWave(db, id, 1);
    setArtifactStatus(db, id, "reviewed");
    db.prepare("INSERT INTO runs (run_id, agent, owner_id, status) VALUES ('run-us3-x', 'guildctl-auto', 'guildctl', 'running')").run();

    await assert.rejects(
      Promise.resolve().then(() =>
        claimArtifactById(db, {
          artifactId: id,
          agent: "code-writer-agent",
          ownerId: "guildctl-auto:test",
          runId: "run-us3-x",
          fromStatuses: ["planned", "blocked"],
        }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof RegistryError, `expected RegistryError, got ${error}`);
        // The message names the actual status and the eligible set in one line.
        assert.match(error.message, /reviewed/);
        assert.match(error.message, /planned|blocked/);
        return true;
      },
    );
  } finally {
    db.close();
  }
});

// US3 (#155) / T015: at the CLI boundary, a RegistryError raised while resuming
// is one clean stderr line and a non-zero exit — never an uncaught stack trace.
test("US3: the auto CLI surfaces a resume refusal as a clean one-line error, not a stack trace", () => {
  // The registry DB must live OUTSIDE the target workspace: the supervisor
  // refuses to run when REGISTRY_DB is inside GUILD_WORKSPACE. Keep the DB in
  // its own sibling dir so the resume refusal — not the placement guard — is
  // the error surfaced as a clean one-liner.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guild-us3-cli-"));
  const workspace = path.join(dir, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  try {
    const dbPath = path.join(dir, "registry.db");
    const db = new Database(dbPath);
    applySchema(db);
    // A `reviewed` artifact is not resume-eligible, so --resume must refuse.
    const id = "legacy-source:com.acme:CliResume";
    registerArtifact(db, { id, kind: "legacy-source", tier: "first-class", path: "legacy/CliResume.java" });
    setArtifactWave(db, id, 1);
    setArtifactStatus(db, id, "reviewed");
    db.close();

    const migrationRoot = repoMigrationRoot();
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", path.join(migrationRoot, "guildctl", "cli.ts"), "--db", dbPath, "auto", "--artifact", id, "--resume"],
      {
        cwd: migrationRoot,
        encoding: "utf8",
        env: { ...process.env, DOTENV_CONFIG_SILENT: "true", GUILD_WORKSPACE: workspace },
      },
    );

    assert.notEqual(result.status, 0, `expected non-zero exit, got ${result.status}: ${result.stdout}`);
    const combined = `${result.stdout}\n${result.stderr}`;
    assert.match(combined, /reviewed|planned|blocked|expected one of/i);
    assert.ok(!/at\s+\w+\s+\(/.test(result.stderr), `no stack trace frames in stderr:\n${result.stderr}`);
    assert.ok(!/RegistryError\s*$/m.test(result.stderr), `no bare RegistryError class name:\n${result.stderr}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
