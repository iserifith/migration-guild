import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { resolveRegistryDbPath } from "./config";

// Git sets GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE in the environment while
// running a hook so the hook's own git invocations target the right repo.
// A caller running inside such a hook (e.g. this project's own pre-commit
// running its test suite) would otherwise leak those vars into any nested
// git subprocess — including ones explicitly pointed at an unrelated
// directory via `cwd` — and silently redirect them at the *outer* repo.
// Scrub them from every git invocation this module spawns.
const GIT_SCOPE_ENV: NodeJS.ProcessEnv = { ...process.env };
for (const key of [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_OBJECT_DIRECTORY",
  "GIT_COMMON_DIR",
]) {
  delete GIT_SCOPE_ENV[key];
}

/** Environment to pass to every git subprocess: current env minus hook-scope vars. */
export function gitEnv(): NodeJS.ProcessEnv {
  return GIT_SCOPE_ENV;
}

export function assertDbExists(dbPath?: string): void {
  const resolved = resolveRegistryDbPath({ explicitPath: dbPath });
  if (!fs.existsSync(resolved)) {
    process.stderr.write(
      `\n  ✗ Registry not found: ${resolved}\n\n` +
      `  Run inventory first to initialise the registry:\n` +
      `    node migration/guildctl/dist/cli.js inventory\n\n`
    );
    process.exit(1);
  }
}

export function getLogDir(): string {
  const dir = path.resolve(process.cwd(), "migration", "logs");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * The single definition of "this variable carries a secret", by name.
 *
 * One predicate governs evidence-log scrubbing, preflight reporting, and the
 * environment divergence report alike (FR-023), so a variable cannot be a
 * secret on one output path and printable on another. It lives here rather
 * than in `verify.ts` — which re-exports it — because the environment loader
 * runs before the registry modules are imported, and importing `verify.ts`
 * that early would pull module-scope environment readers in ahead of the
 * values this load is about to apply.
 */
export function isSensitiveEnvName(name: string): boolean {
  return /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|BEARER)/i.test(name);
}

// ─── Process-group termination primitives (FR-035–FR-038) ────────────────────
//
// Terminating an attempt must terminate everything that attempt started, not
// only the direct child. These are the platform-conditional primitives; the
// escalation policy that uses them lives in the callers (the verification
// budget and attempt termination).
//
//   POSIX   — signal the negated pgid; confirm with kill(-pgid, 0) → ESRCH.
//   Windows — taskkill /PID <pid> /T [/F]; confirm with tasklist filtered by PID.

const isWindows = process.platform === "win32";

export type TerminationPhase = "graceful" | "forced";

function errnoCode(error: unknown): string {
  return typeof error === "object" && error && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
}

/**
 * Signal an entire process group. Returns true when the group was there to be
 * signalled, false when it was already gone. Never throws: a group that has
 * already exited is a normal outcome, not an error.
 */
export function signalProcessGroup(pid: number | undefined | null, phase: TerminationPhase): boolean {
  if (pid == null || !Number.isInteger(pid) || pid <= 0) return false;

  if (isWindows) {
    const args = ["/PID", String(pid), "/T"];
    if (phase === "forced") args.push("/F");
    const result = spawnSync("taskkill", args, { stdio: "ignore", windowsHide: true });
    return result.status === 0;
  }

  try {
    process.kill(-pid, phase === "forced" ? "SIGKILL" : "SIGTERM");
    return true;
  } catch (error) {
    // ESRCH: the group is gone. EPERM: it exists but we may not signal it —
    // report it as still present so the caller can name it as a survivor.
    return errnoCode(error) === "EPERM";
  }
}

/** True while any process in the group is still alive. */
export function isProcessGroupAlive(pid: number | undefined | null): boolean {
  if (pid == null || !Number.isInteger(pid) || pid <= 0) return false;

  if (isWindows) {
    const result = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status !== 0 || typeof result.stdout !== "string") return false;
    return result.stdout.includes(String(pid));
  }

  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ESRCH") return false;
    // EPERM means the group exists but is not ours to signal.
    return code === "EPERM";
  }
}

export interface TerminateProcessGroupOptions {
  /** Bounded grace period between the graceful signal and forced escalation. */
  graceMs: number;
  /** How long to wait for the forced signal to take effect before reporting survivors. */
  confirmMs?: number;
}

export interface ProcessGroupTerminationResult {
  cleanupOutcome: "clean" | "survivors" | "not-applicable";
  /** Non-empty iff `cleanupOutcome === "survivors"`. */
  survivorPids: number[];
  /** True when the graceful signal did not suffice and force was applied. */
  escalated: boolean;
}

async function waitUntilGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    if (!isProcessGroupAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isProcessGroupAlive(pid);
}

/**
 * Graceful → forced → confirm, over the whole group.
 *
 * A group that was already gone (or an attempt that was between processes)
 * reports `clean` with zero survivors — that is success, not an error. A
 * survivor that cannot be terminated at all is reported as a cleanup failure
 * naming its PID; it is never omitted and never treated as acceptable.
 */
export async function terminateProcessGroup(
  pid: number | undefined | null,
  opts: TerminateProcessGroupOptions,
): Promise<ProcessGroupTerminationResult> {
  if (pid == null || !Number.isInteger(pid) || pid <= 0) {
    return { cleanupOutcome: "not-applicable", survivorPids: [], escalated: false };
  }
  if (!isProcessGroupAlive(pid)) {
    return { cleanupOutcome: "clean", survivorPids: [], escalated: false };
  }

  signalProcessGroup(pid, "graceful");
  if (await waitUntilGone(pid, opts.graceMs)) {
    return { cleanupOutcome: "clean", survivorPids: [], escalated: false };
  }

  signalProcessGroup(pid, "forced");
  if (await waitUntilGone(pid, opts.confirmMs ?? 2000)) {
    return { cleanupOutcome: "clean", survivorPids: [], escalated: true };
  }

  return { cleanupOutcome: "survivors", survivorPids: [pid], escalated: true };
}
