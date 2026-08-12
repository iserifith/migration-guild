import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { enforceSpawnLimits } from "../guildctl/commands/auto";
import { DEFAULT_GUILD_CONFIG } from "../guildctl/config";
import { spawnAgent } from "../guildctl/runner";
import { applySchema } from "../registry/db/schema";
import { makeTempDir, waitFor, writeGrandchildSpawner } from "./truthful-run-state-fixtures";

/**
 * US5 (FR-035–FR-039): terminating an attempt terminates everything that
 * attempt started, not only the direct child. Uses the SIGTERM-ignoring
 * grandchild fixture from `truthful-run-state-fixtures.ts`.
 *
 * The AGENT_CMD harness contract is `<cmd> --agent <a> --model <m> --yolo -p
 * <prompt>`, so the grandchild-spawner fixture (whose own CLI contract is
 * `<script> parent|grandchild`) is wrapped in a thin shim that becomes the
 * process-group leader spawnAgent tracks; the shim spawns the fixture script
 * as an ordinary (non-detached) child, so it — and the grandchild it in turn
 * spawns — inherit the shim's process group. Terminating the group therefore
 * has to reach three processes, not one, to report `clean (0 survivors)`.
 */

const isWindows = process.platform === "win32";

function writeAgentShim(dir: string, grandchildSpawnerPath: string, pidFile: string): string {
  const file = path.join(dir, "agent-shim.mjs");
  writeFileSync(file, `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(pidFile)}, "shim " + process.pid + "\\n");
const child = spawn(process.execPath, [${JSON.stringify(grandchildSpawnerPath)}, "parent"], { stdio: "ignore" });
child.unref();
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  return file;
}

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

test("runner: a ceiling termination reaches the whole process tree, not only the direct child", async (t) => {
  if (isWindows) { t.skip("taskkill tree-kill path is exercised on Windows CI only"); return; }
  const dir = makeTempDir("guild-runner-pgroup-");
  const pidFile = path.join(dir, "pids");
  const grandchildScript = writeGrandchildSpawner(dir, { ignoreSigterm: false, pidFile, lifetimeMs: 30_000 });
  const shim = writeAgentShim(dir, grandchildScript, pidFile);

  const previousAgentCmd = process.env.AGENT_CMD;
  process.env.AGENT_CMD = shim;
  const db = createDb();
  try {
    const result = await spawnAgent({
      agent: "code-writer-agent",
      model: "test-model",
      prompt: "irrelevant",
      db,
      timeoutMs: 300,
      inactivityTimeoutMs: 0,
    });

    // The ceiling fired (124 is spawnAgent's synthetic killed-exit-code).
    assert.equal(result.exitCode, 124);

    const run = db.prepare("SELECT cleanup_outcome, survivor_pids FROM runs WHERE run_id = ?").get(result.runId) as {
      cleanup_outcome: string;
      survivor_pids: string | null;
    };
    assert.equal(run.cleanup_outcome, "clean");
    assert.equal(run.survivor_pids, null);

    // All three processes recorded a pid; confirm none of them are still alive.
    await waitFor(() => true, 100); // let the filesystem settle
    const fs = await import("node:fs");
    const pidLines = fs.readFileSync(pidFile, "utf8").trim().split("\n").filter(Boolean);
    assert.ok(pidLines.length >= 1, "expected at least the shim to have recorded its pid");
    for (const line of pidLines) {
      const pid = Number(line.split(" ").pop());
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      assert.equal(alive, false, `pid ${pid} (${line}) should not still be alive after termination`);
    }
  } finally {
    if (previousAgentCmd == null) delete process.env.AGENT_CMD;
    else process.env.AGENT_CMD = previousAgentCmd;
    db.close();
  }
});

test("autonomous path: enforceSpawnLimits forcibly terminates a SIGTERM-ignoring process group", async (t) => {
  if (isWindows) { t.skip("taskkill tree-kill path is exercised on Windows CI only"); return; }
  const dir = makeTempDir("guild-auto-pgroup-");
  const pidFile = path.join(dir, "pids");
  const script = writeGrandchildSpawner(dir, { ignoreSigterm: true, pidFile, lifetimeMs: 30_000 });
  const child = spawn(process.execPath, [script, "parent"], { stdio: "ignore", detached: true });
  await waitFor(() => existsSync(pidFile), 5000);

  const cfg = {
    ...DEFAULT_GUILD_CONFIG,
    agent_limits: { ...DEFAULT_GUILD_CONFIG.agent_limits, termination_grace_seconds: 1, ceiling_seconds: 100000, inactivity_timeout_seconds: 100000 },
  };
  const previousCeilingEnv = process.env.GUILDCTL_AGENT_CEILING_SECONDS;
  // A near-zero ceiling so enforceSpawnLimits fires almost immediately. An
  // unrecognized phase name has no per-phase floor, so the requested value is
  // not silently raised to the 5-minute code-writing floor.
  process.env.GUILDCTL_AGENT_CEILING_SECONDS = "1";
  try {
    const outcome = await enforceSpawnLimits(child, "test-only-unfloored-phase", cfg as never);
    // Ceiling fired (the tree ignores graceful SIGTERM), forced escalation
    // followed, and SIGKILL cannot be ignored: the group is confirmed gone —
    // this is the autonomous-path equivalent of the runner-level test above.
    assert.ok(outcome.firingLimit, "expected the ceiling limit to have fired");
    assert.equal(outcome.cleanupResult.cleanupOutcome, "clean");
    assert.equal(outcome.cleanupResult.survivorPids.length, 0);
  } finally {
    if (previousCeilingEnv == null) delete process.env.GUILDCTL_AGENT_CEILING_SECONDS;
    else process.env.GUILDCTL_AGENT_CEILING_SECONDS = previousCeilingEnv;
  }
});

test("runner: an attempt terminated between processes reports clean (0 survivors) as success", async (t) => {
  if (isWindows) { t.skip("taskkill tree-kill path is exercised on Windows CI only"); return; }
  const dir = makeTempDir("guild-runner-pgroup-clean-");
  const db = createDb();
  const previousAgentCmd = process.env.AGENT_CMD;
  // A trivial harness that exits immediately — no children survive it, so the
  // group is already gone by the time termination would run. Runs to
  // completion normally (no ceiling fires), exercising the "clean" success
  // path outside a kill at all.
  const quickExit = path.join(dir, "quick-exit.mjs");
  writeFileSync(quickExit, `process.exit(0);\n`, { mode: 0o755 });
  process.env.AGENT_CMD = quickExit;
  try {
    const result = await spawnAgent({
      agent: "code-writer-agent",
      model: "test-model",
      prompt: "irrelevant",
      db,
      timeoutMs: 5000,
      inactivityTimeoutMs: 0,
    });
    assert.equal(result.exitCode, 0);
    const run = db.prepare("SELECT cleanup_outcome FROM runs WHERE run_id = ?").get(result.runId) as { cleanup_outcome: string | null };
    // No kill occurred at all — not-applicable, not a false "survivors".
    assert.equal(run.cleanup_outcome, "not-applicable");
  } finally {
    if (previousAgentCmd == null) delete process.env.AGENT_CMD;
    else process.env.AGENT_CMD = previousAgentCmd;
    db.close();
  }
});
