import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { isGitWorktree, snapshotChangedFiles, spawnAgent } from "../guildctl/runner";
import { registerArtifact, setArtifactStatus } from "../registry/commands/artifacts";
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

test("git change snapshots stay quiet outside git worktrees", () => {
  const workDir = mkdtempSync(path.join(tmpdir(), "guildctl-non-git-"));

  try {
    assert.equal(isGitWorktree(workDir), false);
    assert.deepEqual([...snapshotChangedFiles(workDir)], []);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
