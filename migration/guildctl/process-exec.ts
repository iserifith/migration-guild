import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { EffectiveLimit } from "./limits";
import { signalProcessGroup, terminateProcessGroup, type ProcessGroupTerminationResult } from "./util";

// === Platform command selection (issue #296) =================================
//
// The one place that decides HOW an agent CLI (or any harness invocation) is
// launched on this platform. The manual runner, the autonomous worker, and the
// autonomous reviewer all launch through it, so a platform fix (for example
// launching Windows `.sh` harnesses through Bash) lands for every execution
// path at once instead of diverging the way the autonomous spawn used to.

/**
 * Resolve the Bash binary used to launch `.sh` harness scripts on Windows.
 * `GUILD_BASH` wins when set; otherwise the standard Git-for-Windows install
 * locations are probed, falling back to a PATH lookup.
 */
export function resolveWindowsBash(): string {
  const configured = process.env["GUILD_BASH"]?.trim();
  if (configured) return configured;

  const candidates = [
    path.join(process.env["ProgramFiles"] ?? "C:\\Program Files", "Git", "bin", "bash.exe"),
    path.join(process.env["LocalAppData"] ?? "", "Programs", "Git", "bin", "bash.exe"),
  ];
  const installed = candidates.find((candidate) => fs.existsSync(candidate));
  if (installed) return installed;

  // Keep this as a command lookup fallback for non-standard Git/MSYS installs.
  return "bash";
}

/** How a harness invocation is to be spawned on this platform. */
export interface AgentSpawnPlan {
  command: string;
  args: string[];
  shell: boolean;
}

/**
 * Decide how to spawn the agent CLI cross-platform.
 * - A `.mjs`/`.cjs`/`.js` AGENT_CMD (a Node shim) is run via the current Node
 *   binary with no shell -- this avoids Windows' inability to spawn .cmd shims
 *   and, crucially, avoids passing the (large, untrusted) prompt arg through
 *   cmd.exe where shell metacharacters would break or inject.
 * - A `.sh` script on Windows is launched through Bash: cmd.exe would hand .sh
 *   files to their Windows file association, which may open an editor instead
 *   of executing the script.
 * - Anything else (a bare command or a .cmd/.bat) needs a shell on Windows.
 */
export function resolveAgentSpawn(agentCmd: string, agentArgs: string[]): AgentSpawnPlan {
  if (/\.(mjs|cjs|js)$/i.test(agentCmd)) {
    return { command: process.execPath, args: [agentCmd, ...agentArgs], shell: false };
  }
  if (process.platform === "win32" && /\.sh$/i.test(agentCmd)) {
    return { command: resolveWindowsBash(), args: [agentCmd, ...agentArgs], shell: false };
  }
  return { command: agentCmd, args: agentArgs, shell: process.platform === "win32" };
}

// === Managed child-process lifecycle (issue #296) ============================
//
// The concrete child-process mechanics every execution path shares: one place
// spawns the child as a process-group leader (R8/FR-035), tracks activity,
// arms the inactivity/wall-clock limits, forwards operator SIGINT/SIGTERM into
// the group, terminates the whole tree through the bounded
// graceful->forced->confirm escalation, and settles exactly once.
//
// Deliberately NOT here: prompts, harness/model resolution, registry writes,
// log formatting, warden snapshots, and review-marker interpretation. Those
// stay with the callers -- this is a lifecycle primitive, not an orchestration
// framework.

/** How long the direct child and its whole group may take to exit. */
const DEFAULT_TERMINATION_GRACE_MS = 5_000;

export interface ManagedProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Defaults to piped output (stdin ignored), which also arms activity tracking. */
  stdio?: "inherit" | Array<"ignore" | "inherit" | "pipe">;
  shell?: boolean;
  /** Wall-clock ceiling; undefined/zero disables. */
  ceiling?: EffectiveLimit | null;
  /** Silence window after which the child is considered hung; undefined/zero disables. */
  inactivity?: EffectiveLimit | null;
  /** Bounded graceful->forced escalation window for whole-tree termination. */
  terminationGraceMs?: number;
  /**
   * Forward operator SIGINT/SIGTERM into the child's process group until the
   * run settles. A detached child no longer receives the terminal's SIGINT, so
   * without this an operator Ctrl-C would leave the tree running.
   */
  forwardOperatorSignals?: boolean;
  /**
   * Called when an inactivity or ceiling limit actually fires, just before
   * whole-tree termination begins. The descriptor is the same one enforcement
   * acts on, so a caller's termination message can never name a knob that does
   * not govern.
   */
  onLimitFire?: (info: { kind: "inactivity" | "ceiling"; limit: EffectiveLimit }) => void;
  /** Observe every output chunk from either stream (capture, live forwarding). */
  onOutput?: (chunk: Buffer | string, stream: "stdout" | "stderr") => void;
}

export interface ManagedProcessResult {
  /**
   * The child's own exit code; null when it was killed by a signal, could not
   * be spawned, or was terminated by a limit.
   */
  exitCode: number | null;
  /** The `error`-event message when the child could not be started. */
  spawnError?: string;
  /** The limit that fired, when termination was limit-driven; null otherwise. */
  firingLimit: EffectiveLimit | null;
  /**
   * Confirmed whole-tree cleanup outcome. `not-applicable` when no termination
   * ran; never a default value standing in for a real escalation result.
   */
  cleanupResult: ProcessGroupTerminationResult;
}

export interface ManagedProcess {
  child: ChildProcess;
  /**
   * Settles exactly once:
   *  - on the child's own `exit` (no limit fired),
   *  - on its `error` event (spawn failure), or
   *  - once a fired limit's whole-tree termination is CONFIRMED -- a raw `exit`
   *    event racing the confirmation poll never settles, so a real escalation
   *    result cannot read back as the default `not-applicable`.
   * Timers and operator-signal listeners are removed by the time it resolves.
   */
  settled: Promise<ManagedProcessResult>;
}

/**
 * Spawn `command` as a process-group leader and run its lifecycle to a typed,
 * single-settlement outcome. Never throws: spawn failures arrive as
 * `spawnError` on the settled result.
 */
export function runManagedProcess(opts: ManagedProcessOptions): ManagedProcess {
  const graceMs = opts.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
  // R8/FR-035: process-group leader, so terminating this child reaches the
  // whole tree it started, not only its direct child (which for every bundled
  // harness is itself a shim that spawns the real binary).
  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: opts.stdio ?? ["ignore", "pipe", "pipe"],
    shell: opts.shell ?? false,
    detached: true,
  });

  let settled = false;
  let firingLimit: EffectiveLimit | null = null;
  let cleanupResult: ProcessGroupTerminationResult = {
    cleanupOutcome: "not-applicable",
    survivorPids: [],
    escalated: false,
  };
  const timers: NodeJS.Timeout[] = [];
  let resolveSettled: (result: ManagedProcessResult) => void = () => {};
  const settledPromise = new Promise<ManagedProcessResult>((resolve) => {
    resolveSettled = (result) => {
      if (settled) return;
      settled = true;
      for (const handle of timers) {
        clearTimeout(handle);
        clearInterval(handle);
      }
      stopForwardingOperatorSignals();
      resolve(result);
    };
  });

  // Activity tracking: every observed byte is a sign of life.
  let lastActivityMs = Date.now();
  const bumpActivity = (): void => {
    lastActivityMs = Date.now();
  };
  child.stdout?.on("data", bumpActivity);
  child.stderr?.on("data", bumpActivity);
  if (opts.onOutput) {
    child.stdout?.on("data", (chunk) => opts.onOutput!(chunk, "stdout"));
    child.stderr?.on("data", (chunk) => opts.onOutput!(chunk, "stderr"));
  }

  // Operator cancellation: forward into the group until the run settles.
  const forwardOperatorSignal = (): void => {
    signalProcessGroup(child.pid, "graceful");
  };
  if (opts.forwardOperatorSignals) {
    process.on("SIGINT", forwardOperatorSignal);
    process.on("SIGTERM", forwardOperatorSignal);
  }
  const stopForwardingOperatorSignals = (): void => {
    if (!opts.forwardOperatorSignals) return;
    process.off("SIGINT", forwardOperatorSignal);
    process.off("SIGTERM", forwardOperatorSignal);
  };

  const kill = (limit: EffectiveLimit): void => {
    if (settled || firingLimit) return;
    firingLimit = limit;
    opts.onLimitFire?.({ kind: limit.kind, limit });
    // Once a kill is initiated, the child's own "exit" event races the
    // termination promise's confirm-wait poll -- a graceful/forced signal sent
    // by `terminateProcessGroup` itself can make the direct child exit before
    // that promise resolves. Only the termination result may settle the run,
    // or a real escalation would read back as the default "not-applicable".
    void terminateProcessGroup(child.pid, { graceMs }).then((result) => {
      cleanupResult = result;
      resolveSettled({ exitCode: null, firingLimit, cleanupResult });
    });
  };

  // Inactivity watcher: only meaningful when output is observable (piped). A
  // spawn with inherited stdio cannot be judged silent, so the limit is not
  // armed rather than killing a healthy-but-unobservable agent.
  const observable = Boolean(child.stdout) && Boolean(child.stderr);
  const inactivityLimit = observable ? opts.inactivity : null;
  if (inactivityLimit && inactivityLimit.effectiveValueMs > 0) {
    const handle = setInterval(() => {
      if (settled || firingLimit) return;
      if (Date.now() - lastActivityMs > inactivityLimit.effectiveValueMs) kill(inactivityLimit);
    }, Math.max(200, Math.min(1000, Math.round(inactivityLimit.effectiveValueMs / 10))));
    handle.unref?.();
    timers.push(handle);
  }

  // Wall-clock ceiling backstop: a chatty-but-stuck child is still bounded.
  if (opts.ceiling && opts.ceiling.effectiveValueMs > 0) {
    const handle = setTimeout(() => kill(opts.ceiling!), opts.ceiling.effectiveValueMs);
    handle.unref?.();
    timers.push(handle);
  }

  child.on("error", (err) => {
    if (firingLimit) return;
    resolveSettled({ exitCode: null, spawnError: err.message, firingLimit: null, cleanupResult });
  });
  child.on("exit", (code) => {
    if (firingLimit) return;
    resolveSettled({ exitCode: code, firingLimit: null, cleanupResult });
  });

  return { child, settled: settledPromise };
}
