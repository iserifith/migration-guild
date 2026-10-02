import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveAgentSpawn, resolveWindowsBash, runManagedProcess } from "../guildctl/process-exec";
import { LIMIT_PRECEDENCE_ORDER, type EffectiveLimit } from "../guildctl/limits";
import { isProcessGroupAlive } from "../guildctl/util";
import { makeTempDir, waitFor, writeGrandchildSpawner } from "./truthful-run-state-fixtures";

/**
 * Shared child-process lifecycle mechanics (issue #296): platform command
 * selection, activity/ceiling limits, operator-signal forwarding, and
 * confirmed whole-tree termination with single settlement.
 */

const isWindows = process.platform === "win32";

/** An unfloored synthetic descriptor, the way tests pass raw ms values. */
function syntheticLimit(kind: "ceiling" | "inactivity", effectiveValueMs: number): EffectiveLimit {
  return {
    phase: "test-only-unfloored-phase",
    kind,
    knob: kind === "ceiling" ? "GUILDCTL_AGENT_CEILING_SECONDS" : "GUILDCTL_INACTIVITY_TIMEOUT_SECONDS",
    effectiveValueMs,
    requestedValueMs: effectiveValueMs,
    source: "env-override",
    floorApplied: false,
    precedenceOrder: LIMIT_PRECEDENCE_ORDER,
  };
}

function writeScript(dir: string, name: string, body: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body, { mode: 0o755 });
  return file;
}

// ── Platform command selection ───────────────────────────────────────────────

test("resolveAgentSpawn runs Node-shim harnesses via the current Node binary without a shell", () => {
  for (const cmd of ["/opt/harness/agent.mjs", "C:\kit\agent.cjs", "agent.js", "AGENT.JS"]) {
    const plan = resolveAgentSpawn(cmd, ["--agent", "a"]);
    assert.equal(plan.command, process.execPath, `${cmd} must run under Node`);
    assert.equal(plan.shell, false, `${cmd} must not pass through a shell`);
    assert.deepEqual(plan.args, [cmd, "--agent", "a"]);
  }
});

test("resolveAgentSpawn launches Windows .sh harnesses through Bash, never cmd.exe", () => {
  if (!isWindows) {
    // The .sh file-association hazard is Windows-only; elsewhere a .sh command
    // is an ordinary executable and needs no shell.
    const posix = resolveAgentSpawn("harness.sh", []);
    assert.equal(posix.command, "harness.sh");
    assert.equal(posix.shell, false);
    return;
  }
  const previous = process.env.GUILD_BASH;
  process.env.GUILD_BASH = "C:\opt\guild-bash.exe";
  try {
    const plan = resolveAgentSpawn("C:\tmp\harness.sh", ["--agent", "a"]);
    assert.equal(plan.command, "C:\opt\guild-bash.exe");
    assert.equal(plan.args[0], "C:\tmp\harness.sh");
    assert.equal(plan.shell, false, ".sh files must not go through a Windows shell");
  } finally {
    if (previous == null) delete process.env.GUILD_BASH;
    else process.env.GUILD_BASH = previous;
  }
  // Without GUILD_BASH the resolver still names a Bash binary (install probe
  // or PATH lookup), so a .sh harness never falls through to cmd.exe.
  assert.ok(resolveWindowsBash().trim().length > 0);
});

test("resolveAgentSpawn shells bare commands on Windows only", () => {
  const plan = resolveAgentSpawn("opencode", []);
  if (isWindows) assert.equal(plan.shell, true);
  else assert.equal(plan.shell, false);
  assert.equal(plan.args.length, 0);
});

// ── Managed lifecycle ────────────────────────────────────────────────────────

test("runManagedProcess settles once with the child's own exit code and no cleanup claim", async () => {
  const dir = makeTempDir("guild-procexec-exit-");
  const script = writeScript(dir, "exit-code.cjs", "process.exit(3);\n");
  const managed = runManagedProcess({
    command: process.execPath,
    args: [script],
    cwd: dir,
    ceiling: syntheticLimit("ceiling", 10_000),
    inactivity: syntheticLimit("inactivity", 10_000),
    terminationGraceMs: 1_000,
  });
  const outcome = await managed.settled;
  assert.equal(outcome.exitCode, 3);
  assert.equal(outcome.spawnError, undefined);
  assert.equal(outcome.firingLimit, null);
  assert.equal(outcome.cleanupResult.cleanupOutcome, "not-applicable");
  assert.equal(outcome.cleanupResult.survivorPids.length, 0);
  assert.equal(isProcessGroupAlive(managed.child.pid), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("observed activity keeps the inactivity limit from killing a slow-but-alive child", async () => {
  const dir = makeTempDir("guild-procexec-activity-");
  const script = writeScript(dir, "chatty.cjs", `
let ticks = 0;
const iv = setInterval(() => { process.stdout.write("tick " + (++ticks) + "\\n"); }, 100);
setTimeout(() => { clearInterval(iv); process.exit(0); }, 900);
`);
  const managed = runManagedProcess({
    command: process.execPath,
    args: [script],
    cwd: dir,
    inactivity: syntheticLimit("inactivity", 400),
    terminationGraceMs: 1_000,
  });
  const outcome = await managed.settled;
  assert.equal(outcome.exitCode, 0, "a child that keeps producing output must not be killed");
  assert.equal(outcome.firingLimit, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an inactivity limit terminates a silent child and settles only after confirmed cleanup", async () => {
  const dir = makeTempDir("guild-procexec-silent-");
  const script = writeScript(dir, "silent.cjs", "setInterval(() => {}, 1000);\n");
  const fired: string[] = [];
  const managed = runManagedProcess({
    command: process.execPath,
    args: [script],
    cwd: dir,
    inactivity: syntheticLimit("inactivity", 300),
    terminationGraceMs: 1_000,
    onLimitFire: (info) => { fired.push(info.kind); },
  });
  const outcome = await managed.settled;
  assert.deepEqual(fired, ["inactivity"]);
  assert.equal(outcome.exitCode, null);
  assert.equal(outcome.firingLimit?.kind, "inactivity");
  assert.equal(outcome.cleanupResult.cleanupOutcome, "clean");
  assert.equal(outcome.cleanupResult.escalated, false);
  assert.equal(isProcessGroupAlive(managed.child.pid), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a ceiling fires for a chatty-but-stuck child even while output keeps flowing", async () => {
  const dir = makeTempDir("guild-procexec-ceiling-");
  const script = writeScript(dir, "chatty-forever.cjs", "setInterval(() => process.stdout.write(\"tick\\n\"), 100);\n");
  const managed = runManagedProcess({
    command: process.execPath,
    args: [script],
    cwd: dir,
    inactivity: syntheticLimit("inactivity", 60_000),
    ceiling: syntheticLimit("ceiling", 400),
    terminationGraceMs: 1_000,
  });
  const outcome = await managed.settled;
  assert.equal(outcome.exitCode, null);
  assert.equal(outcome.firingLimit?.kind, "ceiling");
  assert.equal(outcome.cleanupResult.cleanupOutcome, "clean");
  assert.equal(isProcessGroupAlive(managed.child.pid), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a SIGTERM-ignoring process group forces escalation and still reports clean", async (t) => {
  if (isWindows) { t.skip("taskkill escalation timing is exercised on Windows CI only"); return; }
  const dir = makeTempDir("guild-procexec-escalate-");
  const pidFile = path.join(dir, "pids");
  const script = writeGrandchildSpawner(dir, { ignoreSigterm: true, pidFile, lifetimeMs: 30_000 });
  const managed = runManagedProcess({
    command: process.execPath,
    args: [script, "parent"],
    cwd: dir,
    ceiling: syntheticLimit("ceiling", 1_500),
    terminationGraceMs: 1_000,
  });
  // The fixture records its pid only after registering its SIGTERM-ignoring
  // handlers, so reaching past this wait guarantees the graceful signal is
  // genuinely ignored and forced escalation is exercised.
  assert.ok(await waitFor(() => fs.existsSync(pidFile), 5_000), "fixture never became ready");
  const outcome = await managed.settled;
  assert.ok(outcome.firingLimit, "expected the ceiling limit to have fired");
  assert.equal(outcome.exitCode, null);
  assert.equal(outcome.cleanupResult.cleanupOutcome, "clean");
  assert.equal(outcome.cleanupResult.escalated, true, "a SIGTERM-ignoring tree must force escalation");
  assert.equal(outcome.cleanupResult.survivorPids.length, 0);
  assert.equal(isProcessGroupAlive(managed.child.pid), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("operator SIGINT is forwarded into the child group; forwarding listeners are removed on settle", async () => {
  const dir = makeTempDir("guild-procexec-forward-");
  const pidFile = path.join(dir, "pids");
  const script = writeGrandchildSpawner(dir, { ignoreSigterm: false, pidFile, lifetimeMs: 30_000 });
  const sigintBefore = process.listenerCount("SIGINT");
  const sigtermBefore = process.listenerCount("SIGTERM");
  const managed = runManagedProcess({
    command: process.execPath,
    args: [script, "parent"],
    cwd: dir,
    ceiling: syntheticLimit("ceiling", 20_000),
    inactivity: syntheticLimit("inactivity", 20_000),
    terminationGraceMs: 1_000,
    forwardOperatorSignals: true,
  });
  assert.ok(await waitFor(() => fs.existsSync(pidFile), 5_000), "fixture never became ready");
  assert.equal(process.listenerCount("SIGINT"), sigintBefore + 1, "SIGINT forwarding must be armed while the child runs");
  assert.equal(process.listenerCount("SIGTERM"), sigtermBefore + 1, "SIGTERM forwarding must be armed while the child runs");

  // Operator Ctrl-C: the signal arrives at THIS process, which must forward it
  // into the detached child's group instead of leaving the tree running.
  process.kill(process.pid, "SIGINT");
  const outcome = await managed.settled;
  assert.equal(outcome.firingLimit, null, "an operator cancellation is not a limit termination");
  assert.equal(outcome.cleanupResult.cleanupOutcome, "not-applicable");
  assert.ok(
    await waitFor(() => !isProcessGroupAlive(managed.child.pid), 5_000),
    "the forwarded signal must have reached the whole group",
  );
  assert.equal(process.listenerCount("SIGINT"), sigintBefore, "forwarding listeners must be removed once settled");
  assert.equal(process.listenerCount("SIGTERM"), sigtermBefore, "forwarding listeners must be removed once settled");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a spawn failure settles with a typed spawnError instead of throwing", async () => {
  const managed = runManagedProcess({
    command: "guildctl-definitely-not-a-real-binary",
    args: [],
    cwd: ".",
    ceiling: syntheticLimit("ceiling", 5_000),
    terminationGraceMs: 1_000,
  });
  const outcome = await managed.settled;
  assert.equal(outcome.exitCode, null);
  assert.ok(outcome.spawnError, "expected a spawn error message");
  assert.match(outcome.spawnError, /ENOENT|not find|not recognized/i);
  assert.equal(outcome.firingLimit, null);
  assert.equal(outcome.cleanupResult.cleanupOutcome, "not-applicable");
});

test("inactivity enforcement is disarmed when the child's output is not observable", async () => {
  const dir = makeTempDir("guild-procexec-unobservable-");
  // Runs longer than the inactivity window without producing observable
  // output: the lifecycle cannot judge it silent, so it must NOT be killed.
  const script = writeScript(dir, "quiet.cjs", "setTimeout(() => process.exit(0), 700);\n");
  const managed = runManagedProcess({
    command: process.execPath,
    args: [script],
    cwd: dir,
    stdio: "inherit",
    inactivity: syntheticLimit("inactivity", 250),
    ceiling: syntheticLimit("ceiling", 5_000),
    terminationGraceMs: 1_000,
  });
  const outcome = await managed.settled;
  assert.equal(outcome.exitCode, 0, "an unobservable child must not be judged inactive");
  assert.equal(outcome.firingLimit, null);
  fs.rmSync(dir, { recursive: true, force: true });
});
