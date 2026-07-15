import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { isGitWorktree, snapshotChangedFiles, spawnAgent } from "../guildctl/runner";
import { registerArtifact, setArtifactStatus, setArtifactWave } from "../registry/commands/artifacts";
import { startRun, reapDeadRuns } from "../registry/commands/runs";
import { applySchema } from "../registry/db/schema";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

test("reapDeadRuns marks a missing pid as failed", () => {
  const db = createDb();

  try {
    const run = startRun(db, { agent: "review-agent", model: "test-model", pid: 999999 });
    const reaped = reapDeadRuns(db, "review-agent");
    const stored = db.prepare(
      "SELECT status, exit_code, finished_at FROM runs WHERE run_id = ?",
    ).get(run.run_id) as { status: string; exit_code: number; finished_at: string | null };

    assert.equal(reaped.length, 1);
    assert.equal(stored.status, "failed");
    assert.equal(stored.exit_code, 1);
    assert.notEqual(stored.finished_at, null);
  } finally {
    db.close();
  }
});

test("spawnAgent records failed stub runs, token usage, and writes a log file", async () => {
  const db = createDb();
  const workDir = mkdtempSync(path.join(tmpdir(), "guildctl-runner-"));
  const stubPath = path.join(workDir, "fake-agent.sh");
  const original = process.env["AGENT_CMD"];

  try {
    writeFileSync(stubPath, `#!/bin/sh
echo simulated runner failure >&2
cat > "$GUILD_OPENCODE_USAGE_FILE" <<'JSON'
{"input":10,"output":5,"reasoning":2,"cacheRead":7,"cacheWrite":3,"total":27,"fresh":17,"events":1,"sessions":["main"]}
JSON
exit 1
`, {
      mode: 0o755,
    });
    process.env["AGENT_CMD"] = stubPath;

    const result = await spawnAgent({
      agent: "review-agent",
      model: "test-model",
      prompt: "small task",
      db,
      logDir: workDir,
    });
    const stored = db.prepare(
      `SELECT status, exit_code, log_file,
              token_input, token_output, token_reasoning,
              token_cache_read, token_cache_write, token_total, token_fresh
       FROM runs WHERE run_id = ?`,
    ).get(result.runId) as {
      status: string;
      exit_code: number;
      log_file: string | null;
      token_input: number;
      token_output: number;
      token_reasoning: number;
      token_cache_read: number;
      token_cache_write: number;
      token_total: number;
      token_fresh: number;
    };

    assert.equal(result.exitCode, 1);
    assert.equal(stored.status, "failed");
    assert.equal(stored.exit_code, 1);
    assert.equal(stored.token_input, 10);
    assert.equal(stored.token_output, 5);
    assert.equal(stored.token_reasoning, 2);
    assert.equal(stored.token_cache_read, 7);
    assert.equal(stored.token_cache_write, 3);
    assert.equal(stored.token_total, 27);
    assert.equal(stored.token_fresh, 17);
    assert.ok(stored.log_file);
    const logText = readFileSync(stored.log_file, "utf8");
    assert.match(logText, /simulated runner failure/);
    assert.match(logText, /Tokens:/);
    assert.match(logText, /fresh=17/);
  } finally {
    if (original == null) {
      delete process.env["AGENT_CMD"];
    } else {
      process.env["AGENT_CMD"] = original;
    }
    rmSync(workDir, { recursive: true, force: true });
    db.close();
  }
});

test("spawnAgent auto-releases claimed artifacts after a failed run", async () => {
  const db = createDb();
  const workDir = mkdtempSync(path.join(tmpdir(), "guildctl-runner-"));
  const stubPath = path.join(workDir, "fake-agent.sh");
  const original = process.env["AGENT_CMD"];
  const claimOwner = "test-writer-agent:claim-1";
  const artifactId = "legacy-source:com.acme:WidgetService";

  try {
    registerArtifact(db, {
      id: artifactId,
      kind: "legacy-source",
      tier: "first-class",
      path: "legacy/src/main/java/com/acme/WidgetService.java",
    });
    setArtifactStatus(db, artifactId, "planned");
    setArtifactStatus(db, artifactId, "in-progress", { agent: claimOwner });

    writeFileSync(stubPath, "#!/bin/sh\necho simulated runner failure >&2\nexit 1\n", {
      mode: 0o755,
    });
    process.env["AGENT_CMD"] = stubPath;

    const result = await spawnAgent({
      agent: "test-writer-agent",
      model: "test-model",
      prompt: "small task",
      db,
      logDir: workDir,
      claimOwner,
      releaseClaimsOnFailure: true,
    });
    const artifact = db.prepare(
      "SELECT status, claimed_by, claimed_from FROM artifacts WHERE id = ?",
    ).get(artifactId) as { status: string; claimed_by: string | null; claimed_from: string | null };

    assert.equal(result.exitCode, 1);
    assert.equal(artifact.status, "planned");
    assert.equal(artifact.claimed_by, null);
    assert.equal(artifact.claimed_from, null);
  } finally {
    if (original == null) {
      delete process.env["AGENT_CMD"];
    } else {
      process.env["AGENT_CMD"] = original;
    }
    rmSync(workDir, { recursive: true, force: true });
    db.close();
  }
});

test("spawnAgent treats lingering claimed artifacts after exit 0 as failure", async () => {
  const db = createDb();
  const workDir = mkdtempSync(path.join(tmpdir(), "guildctl-runner-"));
  const stubPath = path.join(workDir, "fake-agent.sh");
  const original = process.env["AGENT_CMD"];
  const claimOwner = "code-writer-agent:claim-1";
  const artifactId = "legacy-source:com.acme:WidgetDto";

  try {
    registerArtifact(db, {
      id: artifactId,
      kind: "legacy-source",
      tier: "first-class",
      path: "legacy/src/main/java/com/acme/WidgetDto.java",
    });
    setArtifactStatus(db, artifactId, "tests-written");
    setArtifactStatus(db, artifactId, "in-progress", { agent: claimOwner });

    writeFileSync(stubPath, "#!/bin/sh\necho simulated false success >&2\nexit 0\n", {
      mode: 0o755,
    });
    process.env["AGENT_CMD"] = stubPath;

    const result = await spawnAgent({
      agent: "code-writer-agent",
      model: "test-model",
      prompt: "small task",
      db,
      logDir: workDir,
      claimOwner,
    });
    const artifact = db.prepare(
      "SELECT status, claimed_by, claimed_from FROM artifacts WHERE id = ?",
    ).get(artifactId) as { status: string; claimed_by: string | null; claimed_from: string | null };
    const stored = db.prepare(
      "SELECT status, exit_code FROM runs WHERE run_id = ?",
    ).get(result.runId) as { status: string; exit_code: number };

    assert.equal(result.exitCode, 1);
    assert.equal(stored.status, "failed");
    assert.equal(stored.exit_code, 1);
    assert.equal(artifact.status, "tests-written");
    assert.equal(artifact.claimed_by, null);
    assert.equal(artifact.claimed_from, null);
  } finally {
    if (original == null) {
      delete process.env["AGENT_CMD"];
    } else {
      process.env["AGENT_CMD"] = original;
    }
    rmSync(workDir, { recursive: true, force: true });
    db.close();
  }
});

test("spawnAgent pre-claim permits default workspace-local registry DB sidecars", async () => {
  const workDir = mkdtempSync(path.join(tmpdir(), "guildctl-runner-local-db-"));
  const dbPath = path.join(workDir, ".guild", "registry.db");
  const stubPath = path.join(workDir, "fake-agent.cjs");
  const repoMigrationRoot = path.resolve(__dirname, "..");
  const tsxLoader = path.join(repoMigrationRoot, "node_modules", "tsx", "dist", "loader.mjs");
  const registryCli = path.join(repoMigrationRoot, "registry", "cli.ts");
  const originalAgent = process.env["AGENT_CMD"];
  const originalWorkspace = process.env["GUILD_WORKSPACE"];
  const originalRegistry = process.env["REGISTRY_DB"];
  mkdirSync(path.join(workDir, ".guild"), { recursive: true });
  mkdirSync(path.join(workDir, "legacy"), { recursive: true });
  mkdirSync(path.join(workDir, "migration", "registry", "dist"), { recursive: true });
  writeFileSync(path.join(workDir, "migration", "registry", "dist", "cli.js"), `
const { spawnSync } = require("node:child_process");
const result = spawnSync(process.execPath, [
  "--import", ${JSON.stringify(tsxLoader)},
  ${JSON.stringify(registryCli)},
  ...process.argv.slice(2)
], { stdio: "inherit", env: process.env, cwd: process.cwd() });
process.exit(result.status ?? 1);
`, "utf8");
  writeFileSync(path.join(workDir, "legacy", "WidgetDto.js"), "module.exports = 0;\n");
  const db = new Database(dbPath);

  try {
    applySchema(db);
    const artifactId = "legacy-source:com.acme:WidgetDto";
    registerArtifact(db, {
      id: artifactId,
      kind: "legacy-source",
      tier: "first-class",
      path: "legacy/WidgetDto.js",
    });
    setArtifactWave(db, artifactId, 1);
    setArtifactStatus(db, artifactId, "planned");
    writeFileSync(stubPath, `
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
fs.mkdirSync(path.join(process.cwd(), "modern"), { recursive: true });
fs.writeFileSync(path.join(process.cwd(), "modern", "WidgetDto.js"), "module.exports = 1;\\n");
execFileSync(process.execPath, [
  "migration/registry/dist/cli.js",
  "set-artifact-status",
  "--id", process.env.GUILDCTL_ARTIFACT_ID,
  "--status", "migrated",
  "--agent", "code-writer-agent",
  "--claim-id", process.env.GUILDCTL_CLAIM_ID,
  "--claim-token", process.env.GUILDCTL_CLAIM_TOKEN
], { cwd: process.cwd(), stdio: "inherit", env: process.env });
`, "utf8");

    process.env["AGENT_CMD"] = stubPath;
    process.env["GUILD_WORKSPACE"] = workDir;
    process.env["REGISTRY_DB"] = dbPath;

    const result = await spawnAgent({
      agent: "code-writer-agent",
      model: "test-model",
      prompt: "manual preclaim local db sidecar regression",
      db,
      preClaim: { fromStatus: "planned" },
    });

    assert.equal(result.exitCode, 0);
    assert.equal((db.prepare("SELECT status FROM artifacts WHERE id = ?").get(artifactId) as { status: string }).status, "migrated");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM artifact_claims WHERE state = 'active'").get() as { n: number }).n, 0);
    assert.equal(readFileSync(path.join(workDir, "modern", "WidgetDto.js"), "utf8"), "module.exports = 1;\n");
    assert.equal(existsSync(`${dbPath}-wal`) || existsSync(`${dbPath}-shm`) || existsSync(`${dbPath}-journal`), true);
  } finally {
    if (originalAgent == null) delete process.env["AGENT_CMD"];
    else process.env["AGENT_CMD"] = originalAgent;
    if (originalWorkspace == null) delete process.env["GUILD_WORKSPACE"];
    else process.env["GUILD_WORKSPACE"] = originalWorkspace;
    if (originalRegistry == null) delete process.env["REGISTRY_DB"];
    else process.env["REGISTRY_DB"] = originalRegistry;
    db.close();
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("git change snapshots stay quiet outside git worktrees", () => {
  const workDir = mkdtempSync(path.join(tmpdir(), "guildctl-non-git-"));

  try {
    assert.equal(isGitWorktree(workDir), false);
    assert.deepEqual([...snapshotChangedFiles(workDir)], []);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
