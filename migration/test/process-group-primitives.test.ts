import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  isProcessGroupAlive,
  signalProcessGroup,
  terminateProcessGroup,
} from "../guildctl/util";
import { makeTempDir, waitFor, writeGrandchildSpawner } from "./truthful-run-state-fixtures";

/**
 * Foundational coverage for T013: graceful / forced / confirmed process-group
 * primitives.
 *
 * The Windows `taskkill`/`tasklist` path is exercised only on Windows; on POSIX
 * CI the group-signal path is exercised instead. Both are asserted for shape.
 */

const isWindows = process.platform === "win32";

interface Spawned {
  pid: number;
  dir: string;
  cleanup: () => void;
}

async function spawnDetachedTree(opts: { ignoreSigterm?: boolean } = {}): Promise<Spawned> {
  const dir = makeTempDir("guild-pgroup-");
  const readyFile = path.join(dir, "ready");
  const pidFile = path.join(dir, "pids");
  const script = writeGrandchildSpawner(dir, {
    ignoreSigterm: opts.ignoreSigterm,
    readyFile,
    pidFile,
    lifetimeMs: 30_000,
  });

  const child = spawn(process.execPath, [script, "parent"], {
    stdio: "ignore",
    detached: true,
  });
  const pid = child.pid!;
  await waitFor(() => fs.existsSync(readyFile), 5000);

  return {
    pid,
    dir,
    cleanup: () => {
      try {
        if (isWindows) signalProcessGroup(pid, "forced");
        else process.kill(-pid, "SIGKILL");
      } catch {
        // already gone
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("isProcessGroupAlive reports a live group and reports ESRCH once it is gone", async () => {
  const tree = await spawnDetachedTree();
  try {
    assert.equal(isProcessGroupAlive(tree.pid), true);
    signalProcessGroup(tree.pid, "forced");
    assert.equal(await waitFor(() => !isProcessGroupAlive(tree.pid), 5000), true);
    assert.equal(isProcessGroupAlive(tree.pid), false);
  } finally {
    tree.cleanup();
  }
});

test("isProcessGroupAlive is false for a pid that never existed", () => {
  assert.equal(isProcessGroupAlive(0x7ffffff), false);
});

test("signalProcessGroup terminates the whole group gracefully first", async () => {
  const tree = await spawnDetachedTree();
  try {
    assert.equal(signalProcessGroup(tree.pid, "graceful"), true);
    assert.equal(await waitFor(() => !isProcessGroupAlive(tree.pid), 5000), true);
  } finally {
    tree.cleanup();
  }
});

test("terminateProcessGroup escalates to forced only after the bounded grace period", async () => {
  const tree = await spawnDetachedTree({ ignoreSigterm: true });
  try {
    const started = Date.now();
    const result = await terminateProcessGroup(tree.pid, { graceMs: 400 });
    const elapsed = Date.now() - started;

    assert.equal(result.cleanupOutcome, "clean");
    assert.deepEqual(result.survivorPids, []);
    assert.equal(result.escalated, true, "a SIGTERM-ignoring tree must force escalation");
    assert.ok(elapsed >= 400, `escalation must wait out the grace period (waited ${elapsed}ms)`);
    assert.equal(isProcessGroupAlive(tree.pid), false);
  } finally {
    tree.cleanup();
  }
});

test("terminateProcessGroup confirms zero survivors when the tree exits on the graceful signal", async () => {
  const tree = await spawnDetachedTree();
  try {
    const result = await terminateProcessGroup(tree.pid, { graceMs: 3000 });
    assert.equal(result.cleanupOutcome, "clean");
    assert.deepEqual(result.survivorPids, []);
    assert.equal(result.escalated, false);
  } finally {
    tree.cleanup();
  }
});

test("terminating a group that already exited reports clean with zero survivors, not an error", async () => {
  const tree = await spawnDetachedTree();
  signalProcessGroup(tree.pid, "forced");
  await waitFor(() => !isProcessGroupAlive(tree.pid), 5000);
  try {
    const result = await terminateProcessGroup(tree.pid, { graceMs: 200 });
    assert.equal(result.cleanupOutcome, "clean");
    assert.deepEqual(result.survivorPids, []);
  } finally {
    tree.cleanup();
  }
});

test("terminateProcessGroup on a nonexistent pid is not-applicable rather than a failure", async () => {
  const result = await terminateProcessGroup(undefined, { graceMs: 100 });
  assert.equal(result.cleanupOutcome, "not-applicable");
  assert.deepEqual(result.survivorPids, []);
});

test("the platform primitive matches the host: POSIX group signals, Windows taskkill", async () => {
  const tree = await spawnDetachedTree();
  try {
    assert.equal(signalProcessGroup(tree.pid, "graceful"), true);
    await waitFor(() => !isProcessGroupAlive(tree.pid), 5000);

    // Signalling a group that is gone must report "not signalled" rather than
    // throwing, on either platform.
    assert.equal(signalProcessGroup(tree.pid, "forced"), false);
  } finally {
    tree.cleanup();
  }
});
