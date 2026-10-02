import { execFileSync } from "child_process";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Transform } from "stream";
import type Database from "better-sqlite3";
import type { PhaseKey } from "./config";
import { resolveGuildConfig, resolveTerminationGraceMs, resolveWorkspaceRoot } from "./config";
import { resolveAgentLaunch, type ResolvedRuntimeConfig } from "./harness";
import { formatLimitTerminationNote, resolveEffectiveLimit, LIMIT_PRECEDENCE_ORDER, type EffectiveLimit } from "./limits";
import { activeSqliteWardenExclusions, enforceWardenSnapshot, snapshotWorkspaceForWardenWithExclusions, transientWardenExclusions, wardenSnapshotDiff, type WardenSnapshot } from "./warden";
import { formatVerificationCloseOut, verifyAtClaimClose } from "./verify";
import { gitEnv, type ProcessGroupTerminationResult } from "./util";
import { resolveAgentSpawn, runManagedProcess } from "./process-exec";
import { releaseClaimedArtifactsForOwner } from "../registry/commands/artifacts";
import { claimNextTask, createRunOperatorCredential, releaseClaimsForRun } from "../registry/commands/claim";
import { startRun, finishRun, setRunPid, type RunTokenUsage } from "../registry/commands/runs";
import { RegistryError, type FilesWrittenSource, type OutcomeLabel, type Status, type VerificationRecord } from "../registry/types";

export interface SpawnAgentOpts {
  agent: string;
  model: string;
  prompt: string;
  db: Database.Database;
  logDir?: string;
  phase?: PhaseKey;
  timeoutMs?: number;
  // TASK-07: per-call inactivity override (ms). Falls back to config/env default.
  inactivityTimeoutMs?: number;
  claimOwner?: string;
  releaseClaimsOnFailure?: boolean;
  preClaim?: PreClaimOpts;
  runId?: string;
  /**
   * Which phase's effective limit governs this attempt (T045). Defaults to
   * `phase`. Distinct from `phase` because a command may label its run one
   * way (e.g. remediation runs are logged under phase "review") while its
   * limit knob belongs to a different phase (e.g. "remediation").
   */
  limitPhase?: string;
  /**
   * The launch the phase entry resolved and reported (FR-024). When supplied,
   * this helper uses it as given and merges only run-scoped variables onto its
   * `agentEnv` — it MUST NOT resolve a second time, or the run-start line and
   * the process actually spawned could describe different runtimes.
   */
  resolution?: ResolvedRuntimeConfig;
  /**
   * FR-010 (US3): when preClaim is used, the artifact being worked on is only
   * known after the claim resolves — too late for the fixed `prompt` string.
   * If supplied, this is called with the preclaimed artifact id right after
   * the claim succeeds, and its return value replaces the prompt passed to
   * the spawned process (the base `prompt` is unaffected on the no-preClaim
   * or claim-miss paths).
   */
  promptForArtifact?: (artifactId: string) => string;
}

export function expandWardenExclusions(paths: string[]): string[] {
  const expanded = new Set<string>();
  for (const candidate of paths) {
    expanded.add(path.resolve(candidate));
    try {
      expanded.add(fs.realpathSync.native(candidate));
    } catch {
      // The path may be a SQLite sidecar that does not exist yet. Its resolved
      // spelling still needs to remain excluded when it is created later.
    }
  }
  return [...expanded];
}

export interface PreClaimOpts {
  fromStatus: string;
  tier?: string;
  wave?: number;
}
export interface AgentRunResult {
  runId: string;
  agent: string;
  model: string;
  prompt: string;
  logFile?: string;
  exitCode: number;
  /**
   * The harness CLI's captured stdout+stderr when the run failed (FR-013 /
   * US5 #121). Passed through VERBATIM and uncapped here; callers that surface
   * it in a message cap it (slice(0,512)) — no provider/harness branching
   * (constitution VII: the stderr passes through untouched). Empty when the
   * run had no observable output or exited 0.
   */
  capturedOutput?: string;
  /** The harness that was launched (e.g. "opencode", "codex", "custom"). */
  harness?: string;
}

/** Max characters of harness output surfaced in a failure message (US5 #121). */
export const HARNESS_OUTPUT_CAP = 512;

const LOG_SEP = "=".repeat(72);

function formatLocalClockTime(now = new Date()): string {
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const mmm = String(now.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${mmm}`;
}

/** Prepends an `[HH:MM:SS.mmm]` timestamp to every line written to the log. */
function createTimestampTransform(): Transform {
  let buf = "";
  return new Transform({
    transform(chunk: Buffer, _enc: string, cb: () => void) {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        this.push(`[${formatLocalClockTime()}] ${line}\n`);
      }
      cb();
    },
    flush(cb: () => void) {
      if (buf.length > 0) {
        this.push(`[${formatLocalClockTime()}] ${buf}\n`);
        buf = "";
      }
      cb();
    },
  });
}

/** Snapshot the set of modified + new-untracked files relative to git HEAD. */
export function isGitWorktree(root: string): boolean {
  try {
    const result = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: gitEnv(),
    }).trim();
    return result === "true";
  } catch {
    return false;
  }
}

/** Snapshot the set of modified + new-untracked files relative to git HEAD. */
export function snapshotChangedFiles(root: string): Set<string> {
  if (!isGitWorktree(root)) {
    return new Set();
  }

  try {
    const modified = execFileSync("git", ["diff", "--name-only"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: gitEnv(),
    }).trim();
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: gitEnv(),
    }).trim();
    return new Set([...(modified ? modified.split("\n") : []), ...(untracked ? untracked.split("\n") : [])].filter(Boolean));
  } catch {
    return new Set();
  }
}

/** Return files that appear in the after-snapshot but not in the before-snapshot. */
function getNewlyWrittenFiles(root: string, before: Set<string>): string[] {
  const after = snapshotChangedFiles(root);
  return [...after].filter((f) => !before.has(f)).sort();
}

/**
 * `outcome_label` derivation (data-model.md §2, FR-031): computed, never
 * chosen by an agent. `no-progress` requires both zero files written and no
 * status advance; a terminated attempt that wrote files, or whose file count
 * is unavailable, is `released-retryable` instead — never a success-equivalent
 * label for a no-progress termination.
 */
export function deriveOutcomeLabel(input: {
  exitCode: number;
  limitKilled: boolean;
  statusFrom: string | null;
  statusTo: string | null;
  filesWrittenCount: number | null;
  filesWrittenSource: FilesWrittenSource;
  wardenClean: boolean;
}): OutcomeLabel {
  const advanced = input.statusFrom != null && input.statusTo != null && input.statusFrom !== input.statusTo;
  if (input.limitKilled) {
    if (input.filesWrittenSource === "unavailable") return "released-retryable";
    if ((input.filesWrittenCount ?? 0) === 0 && !advanced) return "no-progress";
    return "released-retryable";
  }
  if (input.exitCode === 0 && advanced && input.wardenClean) return "succeeded";
  if (input.exitCode !== 0 && !input.wardenClean) return "failed";
  if (input.exitCode !== 0) return "failed";
  return "released-retryable";
}

function writeLogLine(stream: fs.WriteStream | undefined, line: string): void {
  stream?.write(`[${formatLocalClockTime()}] ${line}\n`);
}

function safeTokenInt(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

function readTokenUsageFile(file: string): RunTokenUsage | undefined {
  try {
    if (!fs.existsSync(file)) return undefined;
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Record<string, unknown>>;
    const input = safeTokenInt(raw.input);
    const output = safeTokenInt(raw.output);
    const reasoning = safeTokenInt(raw.reasoning);
    const cacheRead = safeTokenInt(raw.cacheRead);
    const cacheWrite = safeTokenInt(raw.cacheWrite);
    const fresh = safeTokenInt(raw.fresh) || input + output + reasoning;
    const total = safeTokenInt(raw.total) || fresh + cacheRead + cacheWrite;
    if (fresh + cacheRead + cacheWrite + total === 0) return undefined;
    return { input, output, reasoning, cacheRead, cacheWrite, fresh, total };
  } catch {
    return undefined;
  }
}

function formatTokenUsageLines(usage: RunTokenUsage | undefined): string[] {
  if (!usage) return ["Tokens:   (not reported)"];
  return [
    `Tokens:   fresh=${usage.fresh} provider_total=${usage.total}`,
    `          input=${usage.input} output=${usage.output} reasoning=${usage.reasoning}`,
    `          cache_read=${usage.cacheRead} cache_write=${usage.cacheWrite}`,
  ];
}

function formatLogTimestamp(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z")
    .replace("T", "-");
}

function formatLogFileName(agent: string, startedMs: number, runId: string, phase?: PhaseKey): string {
  const phasePart = phase ? `-${phase}` : "";
  return `${formatLogTimestamp(startedMs)}-${runId}-${agent}${phasePart}.log`;
}

function getRunClaimLines(db: Database.Database, runId: string): string[] {
  try {
    const rows = db
      .prepare(
        `
        SELECT c.claim_id, c.state, c.from_status, a.id AS artifact_id, a.path AS artifact_path, a.status AS artifact_status
        FROM artifact_claims c
        LEFT JOIN artifacts a ON a.id = c.artifact_id
        WHERE c.run_id = ?
        ORDER BY c.claimed_at ASC
        `,
      )
      .all(runId) as Array<{
      claim_id: string;
      state: string;
      from_status: string;
      artifact_id: string | null;
      artifact_path: string | null;
      artifact_status: string | null;
    }>;

    if (rows.length === 0) {
      return ["Claims: (none)"];
    }

    const lines = [`Claims (${rows.length}):`];
    for (const row of rows.slice(0, 5)) {
      const claimShort = row.claim_id.slice(0, 8);
      const artifact = row.artifact_id ?? "unknown-artifact";
      const status = row.artifact_status ?? "unknown";
      const artifactPath = row.artifact_path ?? "unknown-path";
      lines.push(
        `  claim=${claimShort} state=${row.state} from=${row.from_status} artifact=${artifact} artifactStatus=${status} path=${artifactPath}`,
      );
    }
    if (rows.length > 5) {
      lines.push(`  ... +${rows.length - 5} more`);
    }
    return lines;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return [`Claims: (unavailable: ${msg})`];
  }
}

function getRunClaimIntroLine(db: Database.Database, runId: string): string | null {
  try {
    const row = db
      .prepare(
        `
        SELECT c.from_status, a.id AS artifact_id, a.path AS artifact_path, a.kind AS artifact_kind, a.wave AS artifact_wave
        FROM artifact_claims c
        LEFT JOIN artifacts a ON a.id = c.artifact_id
        WHERE c.run_id = ?
        ORDER BY c.claimed_at ASC
        LIMIT 1
        `,
      )
      .get(runId) as
      | {
          from_status: string;
          artifact_id: string | null;
          artifact_path: string | null;
          artifact_kind: string | null;
          artifact_wave: number | null;
        }
      | undefined;

    if (!row) {
      return null;
    }

    const artifact = row.artifact_id ?? "unknown-artifact";
    const artifactPath = row.artifact_path ?? "unknown-path";
    const artifactKind = row.artifact_kind ?? "unknown-kind";
    const wave = row.artifact_wave == null ? "n/a" : String(row.artifact_wave);
    return `[guildctl] Working on ${artifactPath} (${artifactKind}, wave=${wave}, claimed from ${row.from_status}, artifact=${artifact})`;
  } catch {
    return null;
  }
}

export function summarizeRunFailures(results: AgentRunResult[]): string | null {
  const failed = results.filter((result) => result.exitCode !== 0);
  if (failed.length === 0) return null;

  const sample = failed
    .slice(0, 3)
    .map((result) => {
      const logNote = result.logFile
        ? ` log=${path.relative(process.cwd(), result.logFile) || result.logFile}`
        : "";
      const harnessName = result.harness ?? "harness";
      const captured = (result.capturedOutput ?? "").slice(0, HARNESS_OUTPUT_CAP);
      const capturedNote = captured ? `\n    ${harnessName} (exit ${result.exitCode}) output:\n${captured}` : "";
      return `${result.agent} exit=${result.exitCode}${logNote}${capturedNote}`;
    })
    .join("; ");

  const extra = failed.length > 3 ? ` (+${failed.length - 3} more)` : "";
  return `${failed.length} agent run(s) failed: ${sample}${extra}`;
}

export function spawnAgent(opts: SpawnAgentOpts): Promise<AgentRunResult> {
  const { agent, model, prompt, db } = opts;
  const claimOwner = opts.claimOwner ?? `${agent}:${randomUUID()}`;
  const runId = opts.runId ?? randomUUID().replace(/-/g, "").slice(0, 16);
  const startMs = Date.now();
  const startedIso = new Date(startMs).toISOString();
  const projectRoot = resolveWorkspaceRoot();
  const config = resolveGuildConfig({ cwd: projectRoot });
  // FR-011: the runner and preflight resolve the runtime through one function,
  // so what is reported is what a run actually uses. A phase that already
  // resolved and reported its launch passes it in rather than paying for a
  // second, potentially different, resolution here.
  const launch = opts.resolution ?? resolveAgentLaunch({ config, root: projectRoot, model });
  const agentCommand = launch.harness.command;
  const beforeFiles = snapshotChangedFiles(projectRoot);
  const usageFile = path.join(os.tmpdir(), `guild-opencode-usage-${runId}.json`);
  const logFile = opts.logDir
    ? path.join(opts.logDir, formatLogFileName(agent, startMs, runId, opts.phase))
    : undefined;

  // Run logs must survive warden enforcement, but if logDir is the workspace
  // root (or an ancestor of it) excluding the whole directory would blind the
  // warden entirely — fall back to excluding just this run's log file.
  const resolvedLogDir = opts.logDir ? path.resolve(opts.logDir) : undefined;
  const rootFromLogDir = resolvedLogDir ? path.relative(resolvedLogDir, projectRoot) : undefined;
  const logDirCoversWorkspace = rootFromLogDir !== undefined
    && (rootFromLogDir === "" || (!rootFromLogDir.startsWith("..") && !path.isAbsolute(rootFromLogDir)));
  const logExclusions = resolvedLogDir
    ? (logDirCoversWorkspace ? (logFile ? [logFile] : []) : [resolvedLogDir])
    : [];
  const wardenExcludedPaths = expandWardenExclusions(transientWardenExclusions(projectRoot, [
    path.resolve(projectRoot, config.evidence.output_dir),
    ...activeSqliteWardenExclusions(db),
    ...logExclusions,
  ]));

  if (logFile) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
  }

  // Open the log stream early so we can write a header before the process starts.
  const logStream = logFile
    ? fs.createWriteStream(logFile, { flags: "a" })
    : undefined;

  const args = ["--agent", agent, "--model", model, "--yolo", "-p", prompt];
  const run = startRun(db, {
    runId,
    agent,
    ownerId: claimOwner,
    phase: opts.phase,
    model,
    prompt,
    logFile,
    pid: null,
  });

  if (logStream) {
    const promptPreview =
      prompt.length > 300 ? prompt.slice(0, 300) + "..." : prompt;
    logStream.write(
      [
        LOG_SEP,
        "LogVersion: 2",
        `RunId:      ${run.run_id}`,
        `Agent:      ${agent}`,
        `Owner:      ${claimOwner}`,
        `Phase:      ${opts.phase ?? "none"}`,
        `Model:      ${model}`,
        `Started:    ${startedIso}`,
        `Cwd:        ${projectRoot}`,
        `Command:    ${agentCommand} --agent ${agent} --model ${model} --yolo -p <prompt:${prompt.length} chars>`,
        `Prompt:     ${promptPreview}`,
        LOG_SEP,
        "",
      ].join("\n"),
    );
  }

  // ── Pre-claim: runner atomically claims on behalf of the agent ──────────
  // Done AFTER startRun so the run_id foreign key exists in the DB.
  let preClaimedArtifactId: string | undefined;
  let preClaimId: string | undefined;
  let preClaimToken: string | undefined;
  let wardenSnapshot: WardenSnapshot | undefined;
  let wardenAllowedPaths: string[] = [];

  if (opts.preClaim) {
    // Issue #295: claim directly through the exported registry command on the
    // runner's own supplied connection. The CLI subprocess trampoline is gone —
    // no built dist path, no Node-on-PATH requirement, no second DB resolution:
    // the same connection the run records use performs the atomic claim, and
    // the typed result carries the claim token handoff without JSON parsing.
    try {
      const claimed = claimNextTask(
        db,
        agent,
        opts.preClaim.wave ?? undefined,
        opts.preClaim.fromStatus as Status,
        model,
        opts.preClaim.tier ?? "first-class",
        run.run_id,
        claimOwner,
      );
      preClaimedArtifactId = claimed.id;
      preClaimId = claimed.claim_id;
      preClaimToken = claimed.claim_token;
      try {
        wardenAllowedPaths = JSON.parse(claimed.expected_output_paths ?? "[]") as string[];
      } catch {
        wardenAllowedPaths = [];
      }
      wardenSnapshot = snapshotWorkspaceForWardenWithExclusions(projectRoot, wardenExcludedPaths);
      if (opts.promptForArtifact) {
        const artifactPrompt = opts.promptForArtifact(preClaimedArtifactId);
        const promptArgIndex = args.indexOf("-p");
        if (promptArgIndex !== -1) args[promptArgIndex + 1] = artifactPrompt;
      }
    } catch (error) {
      if (error instanceof RegistryError && error.code === 2) {
        // Nothing left to claim — finish run cleanly and return no-op.
        finishRun(db, { runId: run.run_id, exitCode: 0 });
        logStream?.end();
        return Promise.resolve({ runId: run.run_id, agent, model, prompt, logFile, exitCode: 0 });
      }
      // Every other refusal (registry error or unexpected failure) fails the
      // run exactly as the CLI's non-zero exits used to.
      const errMsg = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[guildctl] pre-claim failed: ${errMsg}\n`);
      writeLogLine(logStream, `[guildctl] pre-claim failed: ${errMsg}`);
      finishRun(db, { runId: run.run_id, exitCode: 1, reason: `pre-claim failed: ${errMsg}` });
      logStream?.end();
      return Promise.resolve({ runId: run.run_id, agent, model, prompt, logFile, exitCode: 1 });
    }
  }

  // Always run from the project root (my-migration/) so agent shell commands
  // like `node migration/registry/dist/cli.js ...` resolve correctly.
  const agentSpawn = resolveAgentSpawn(agentCommand, args);
  const runScopedEnv: Record<string, string> = {
    GUILDCTL_AGENT_NAME: claimOwner,
    GUILDCTL_AGENT_KIND: agent,
    GUILDCTL_RUN_ID: run.run_id,
    GUILD_OPENCODE_USAGE_FILE: usageFile,
    ...(preClaimedArtifactId != null ? {
      GUILDCTL_ARTIFACT_ID: preClaimedArtifactId,
      GUILDCTL_CLAIM_ID: preClaimId!,
      GUILDCTL_CLAIM_TOKEN: preClaimToken!,
    } : {}),
  };
  const agentEnv = opts.resolution
    ? { ...opts.resolution.agentEnv, ...runScopedEnv }
    : resolveAgentLaunch({ config, root: projectRoot, model, extraEnv: runScopedEnv }).agentEnv;
  // TASK-07/T045-T047: liveliness limits, resolved through the single
  // EffectiveLimit descriptor. An explicit per-call opts.timeoutMs/
  // inactivityTimeoutMs (used by callers such as tests and benchmarks that
  // pass a raw ms value) is honoured as a synthetic "per-phase-setting"
  // descriptor, so the termination message is always sourced from a real
  // descriptor even on that legacy path — never a knob that does not govern.
  const limitPhaseName = String(opts.limitPhase ?? opts.phase ?? "unknown");
  const ceilingLimit: EffectiveLimit = opts.timeoutMs != null
    ? { phase: limitPhaseName, kind: "ceiling", knob: "timeoutMs (explicit)", effectiveValueMs: opts.timeoutMs, requestedValueMs: opts.timeoutMs, source: "per-phase-setting", floorApplied: false, precedenceOrder: LIMIT_PRECEDENCE_ORDER }
    : resolveEffectiveLimit(limitPhaseName, "ceiling", config, process.env);
  const inactivityLimit: EffectiveLimit = opts.inactivityTimeoutMs != null
    ? { phase: limitPhaseName, kind: "inactivity", knob: "inactivityTimeoutMs (explicit)", effectiveValueMs: opts.inactivityTimeoutMs, requestedValueMs: opts.inactivityTimeoutMs, source: "per-phase-setting", floorApplied: false, precedenceOrder: LIMIT_PRECEDENCE_ORDER }
    : resolveEffectiveLimit(limitPhaseName, "inactivity", config, process.env);
  const inactivityMs = inactivityLimit.effectiveValueMs;
  const terminationGraceMs = resolveTerminationGraceMs(config, process.env);
  const heartbeatMs = process.env.GUILDCTL_HEARTBEAT_SECONDS
    ? Number(process.env.GUILDCTL_HEARTBEAT_SECONDS) * 1000
    : 30000;

  // Limit-fire bookkeeping: the shared lifecycle owns the timers and the
  // whole-tree termination; the runner owns only the operator-facing message
  // and the close-out flags derived from the same firing descriptor.
  let lastActivityMs = Date.now();
  let activityTicks = 0;
  let inactivityKilled = false;
  let ceilingKilled = false;
  let firingLimit: EffectiveLimit | undefined;
  let capturedOutput = "";

  // Issue #296: spawn and run the attempt through the shared lifecycle —
  // process-group leader (R8/FR-035), activity tracking, inactivity/ceiling
  // limits, operator SIGINT/SIGTERM forwarding, and confirmed whole-tree
  // termination. Prompts, logs, warden, and registry updates stay here.
  const managed = runManagedProcess({
    command: agentSpawn.command,
    args: agentSpawn.args,
    shell: agentSpawn.shell,
    cwd: projectRoot,
    env: agentEnv,
    stdio: logStream ? ["ignore", "pipe", "pipe"] : "inherit",
    ceiling: ceilingLimit,
    inactivity: inactivityLimit,
    terminationGraceMs,
    forwardOperatorSignals: true,
    onLimitFire: ({ kind, limit }) => {
      if (kind === "inactivity") inactivityKilled = true;
      else ceilingKilled = true;
      firingLimit = limit;
      const label = kind === "inactivity" ? "INACTIVITY" : "CEILING";
      const secs = Math.round(limit.effectiveValueMs / 1000);
      const detail = kind === "inactivity"
        ? " (no observed output; last activity " + Math.round((Date.now() - lastActivityMs) / 1000) + "s ago)"
        : " (still active)";
      const msg = `[guildctl] ${agent} killed: ${label} after ${secs}s${detail}; ${formatLimitTerminationNote(limit)}`;
      process.stderr.write(msg + "\n");
      writeLogLine(logStream, msg);
    },
    // US5 (#121): capture the harness CLI's raw stdout+stderr so a failure can
    // surface its words verbatim (constitution VII — neither stderr nor stdout
    // is sanitised or branched on by provider/harness). Kept uncapped here; the
    // message path caps it at HARNESS_OUTPUT_CAP.
    onOutput: (chunk) => {
      capturedOutput += chunk.toString();
    },
  });
  const proc = managed.child;
  setRunPid(db, run.run_id, proc.pid ?? null);

  if (logStream && proc.stdout && proc.stderr) {
    proc.stdout.pipe(createTimestampTransform()).pipe(logStream, { end: false });
    proc.stderr.pipe(createTimestampTransform()).pipe(logStream, { end: false });
  }

  // TASK-07: liveliness reporting. lastActivityMs/activityTicks feed the
  // heartbeat line; the lifecycle keeps its own copy of lastActivityMs for the
  // inactivity limit. Both count the same thing — every observed byte.
  const bumpActivity = (): void => {
    lastActivityMs = Date.now();
    activityTicks += 1;
  };
  proc.stdout?.on("data", bumpActivity);
  proc.stderr?.on("data", bumpActivity);
  const harnessName = launch.harness.name;

  return (async (): Promise<AgentRunResult> => {
    let claimWatchHandle: NodeJS.Timeout | undefined;
    let claimIntroWritten = false;

    if (logStream) {
      claimWatchHandle = setInterval(() => {
        if (claimIntroWritten) {
          if (claimWatchHandle) clearInterval(claimWatchHandle);
          return;
        }
        const intro = getRunClaimIntroLine(db, run.run_id);
        if (!intro) {
          return;
        }
        claimIntroWritten = true;
        writeLogLine(logStream, intro);
        if (claimWatchHandle) clearInterval(claimWatchHandle);
      }, 250);
      claimWatchHandle.unref?.();
    }

    const completeRun = async (exitCode: number, cleanupResult: ProcessGroupTerminationResult): Promise<AgentRunResult> => {
      clearLivelinessTimers();
      let finalExitCode = exitCode;
      let wardenClean = true;
      try {
        if (preClaimedArtifactId && wardenSnapshot) {
          const warden = enforceWardenSnapshot(db, {
            artifactId: preClaimedArtifactId,
            workspaceRoot: projectRoot,
            snapshot: wardenSnapshot,
            allowedPaths: wardenAllowedPaths,
            excludedPaths: wardenExcludedPaths,
            agent: "guildctl-warden",
            claimId: preClaimId ?? null,
            runId: run.run_id,
          });
          wardenClean = warden.clean;
          if (!warden.clean) {
            finalExitCode = 1;
            // "created"-kind violations are hard-deleted, not restored — there is no
            // prior version to restore. Distinguish so operators reading run output
            // can tell that data was lost vs. simply reverted.
            const deletedCount = warden.violations.filter((violation) => violation.kind === "created").length;
            const restoredCount = warden.violations.length - deletedCount;
            const msgParts = [
              deletedCount > 0 ? `${deletedCount} unauthorized file(s) deleted` : null,
              restoredCount > 0 ? `${restoredCount} unauthorized change(s) restored` : null,
            ].filter((part): part is string => part !== null);
            const msg = `[guildctl] filesystem warden: ${msgParts.join("; ")}; marking run failed`;
            process.stderr.write(
              (process.stderr.isTTY ? "\x1b[1;31m" : "") + msg + (process.stderr.isTTY ? "\x1b[0m" : "") + "\n",
            );
            writeLogLine(logStream, msg);
          }
        }
        if (exitCode === 0) {
          let released = releaseClaimsForRun(
            db,
            run.run_id,
            "guildctl",
            `auto-released after ${agent} exited without advancing claimed work`,
          );
          if (released.length === 0) {
            released = releaseClaimedArtifactsForOwner(
              db,
              claimOwner,
              "guildctl",
              `auto-released after ${agent} exited without advancing claimed work`,
            );
          }
          if (released.length > 0) {
            finalExitCode = 1;
            const msg = `[guildctl] ${agent} exited with code 0 but left ${released.length} claimed artifact(s); marking run failed and releasing claims`;
            process.stderr.write(msg + "\n");
            writeLogLine(logStream, msg);
          }
        } else if (opts.releaseClaimsOnFailure) {
          const released = releaseClaimsForRun(
            db,
            run.run_id,
            "guildctl",
            `auto-released after ${agent} exited with code ${exitCode}`,
          );
          if (released.length === 0) {
            releaseClaimedArtifactsForOwner(
              db,
              claimOwner,
              "guildctl",
              `auto-released after ${agent} exited with code ${exitCode}`,
            );
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const msg = `[guildctl] Failed to auto-release claims for ${claimOwner}: ${message}`;
        process.stderr.write(msg + "\n");
        writeLogLine(logStream, msg);
      }
      const limitKilled = inactivityKilled || ceilingKilled;
      const terminationReason = inactivityKilled && firingLimit
        ? `${agent} killed: no activity for ${Math.round(firingLimit.effectiveValueMs / 1000)}s (last activity after ${Math.round((Date.now() - lastActivityMs) / 1000)}s of silence); ${formatLimitTerminationNote(firingLimit)}`
        : ceilingKilled && firingLimit
          ? `${agent} killed: exceeded wall-clock ceiling ${Math.round(firingLimit.effectiveValueMs / 1000)}s (still active); ${formatLimitTerminationNote(firingLimit)}`
          : finalExitCode === 0
            ? undefined
            : `${agent} exited with code ${finalExitCode}`;
      const tokenUsage = readTokenUsageFile(usageFile);
      try { fs.rmSync(usageFile, { force: true }); } catch {}

      // Verification at claim close (FR-001, FR-006, FR-007). Its outcome is a
      // recorded fact, never a gate: no result here changes finalExitCode or
      // prevents the artifact from advancing.
      let verification: VerificationRecord | null = null;
      if (preClaimedArtifactId) {
        try {
          const operator = createRunOperatorCredential(db, run.run_id);
          verification = await verifyAtClaimClose(db, {
            artifactId: preClaimedArtifactId,
            workspaceRoot: projectRoot,
            config,
            runId: run.run_id,
            operatorToken: operator.token,
          });
        } catch {
          // Recording verification must never fail a run.
        }
      }

      // Process-tree cleanup (FR-035–FR-039): a released claim is never
      // reported alone — the cleanup outcome always accompanies it, confirmed
      // by the shared lifecycle before settlement. Claim recoverability
      // outranks cleanup completeness, so cleanup failure never blocks the
      // claim release above.

      // Files-written count (FR-030, research R10): prefer the warden snapshot
      // diff, already paid for by every pre-claimed run; fall back to git diff
      // only when no warden snapshot exists; never silently report a false zero.
      let filesWrittenCount: number | null = null;
      let filesWrittenSource: FilesWrittenSource = "unavailable";
      let writtenFileNames: string[] = [];
      if (preClaimedArtifactId && wardenSnapshot) {
        const afterSnapshot = snapshotWorkspaceForWardenWithExclusions(projectRoot, wardenExcludedPaths);
        writtenFileNames = wardenSnapshotDiff(wardenSnapshot, afterSnapshot);
        filesWrittenCount = writtenFileNames.length;
        filesWrittenSource = "warden-snapshot";
      } else if (isGitWorktree(projectRoot)) {
        writtenFileNames = getNewlyWrittenFiles(projectRoot, beforeFiles);
        filesWrittenCount = writtenFileNames.length;
        filesWrittenSource = "git-diff";
      }

      const statusFrom = preClaimedArtifactId ? (opts.preClaim?.fromStatus ?? null) : null;
      const statusTo = preClaimedArtifactId
        ? ((db.prepare("SELECT status FROM artifacts WHERE id = ?").get(preClaimedArtifactId) as { status: string } | undefined)?.status ?? null)
        : null;
      const budgetConsumed: 0 | 1 = tokenUsage && tokenUsage.total > 0 ? 1 : 0;
      const outcomeLabel: OutcomeLabel | undefined = preClaimedArtifactId
        ? deriveOutcomeLabel({
          exitCode: finalExitCode,
          limitKilled,
          statusFrom,
          statusTo,
          filesWrittenCount,
          filesWrittenSource,
          wardenClean,
        })
        : undefined;

      finishRun(db, {
        runId: run.run_id,
        exitCode: finalExitCode,
        reason: terminationReason,
        tokenUsage,
        filesWrittenCount: preClaimedArtifactId ? filesWrittenCount : null,
        filesWrittenSource: preClaimedArtifactId ? filesWrittenSource : null,
        statusFrom,
        statusTo,
        budgetConsumed: preClaimedArtifactId ? budgetConsumed : null,
        cleanupOutcome: cleanupResult.cleanupOutcome,
        survivorPids: cleanupResult.survivorPids.length > 0 ? cleanupResult.survivorPids : null,
        outcomeLabel,
      });

      const result: AgentRunResult = {
        runId: run.run_id,
        agent,
        model,
        prompt,
        logFile,
        exitCode: finalExitCode,
        capturedOutput,
        harness: harnessName,
      };

      if (logStream) {
        const elapsedS = ((Date.now() - startMs) / 1000).toFixed(1);
        const status = inactivityKilled
          ? "INACTIVITY-KILL"
          : ceilingKilled
            ? "CEILING-KILL"
            : finalExitCode === 0
              ? "SUCCESS"
              : "FAILED";
        const filesBlock = filesWrittenSource === "unavailable"
          ? ["Files written: unavailable (no warden snapshot or git worktree)"]
          : writtenFileNames.length > 0
            ? [`Files written (${writtenFileNames.length}, source: ${filesWrittenSource}):`, ...writtenFileNames.map((f) => `  ${f}`)]
            : [`Files written: 0 (source: ${filesWrittenSource})`];
        const claimBlock = getRunClaimLines(db, run.run_id);
        // Verification is stated in the same close-out block as migration
        // status, and separately from it: an artifact can be migrated and
        // unverified at once, and the summary must be able to say so (FR-007).
        const verificationBlock = verification
          ? [`Verification: ${formatVerificationCloseOut(verification)}`]
          : [];
        const cleanupLine = cleanupResult.cleanupOutcome === "survivors"
          ? `Process cleanup: FAILED — ${cleanupResult.survivorPids.length} survivor(s) (pid ${cleanupResult.survivorPids.join(", ")})`
          : `Process cleanup: ${cleanupResult.cleanupOutcome} (0 survivors)`;
        const outcomeBlock = outcomeLabel
          ? [
            `Outcome: ${outcomeLabel === "no-progress" ? "NO PROGRESS" : outcomeLabel}`,
            `Artifact status: ${statusFrom ?? "?"} -> ${statusTo ?? "?"}${statusFrom === statusTo ? " (unchanged)" : ""}`,
            cleanupLine,
            `Provider budget: ${budgetConsumed ? "consumed — this spend is not recovered" : "not consumed"}`,
          ]
          : [cleanupLine];
        await new Promise<void>((resolveEnd) => {
          logStream.end(
            [
              "",
              LOG_SEP,
              `Status:   ${status}`,
              `Exit:     ${finalExitCode}`,
              `Elapsed:  ${elapsedS}s`,
              `Finished: ${new Date().toISOString()}`,
              ...formatTokenUsageLines(tokenUsage),
              ...claimBlock,
              ...verificationBlock,
              ...outcomeBlock,
              ...filesBlock,
              LOG_SEP,
              "",
            ].join("\n"),
            () => resolveEnd(),
          );
        });
      }
      return result;
    };

    // Heartbeat: periodic liveness line so operators can tell a working agent
    // from a hung one. Goes quiet once the run settles.
    let heartbeatHandle: NodeJS.Timeout | undefined;
    let lastHeartbeatEmitMs = 0;
    if (heartbeatMs > 0) {
      heartbeatHandle = setInterval(() => {
        const now = Date.now();
        const sinceActivityMs = now - lastActivityMs;
        const stallMs = inactivityMs > 0 ? inactivityMs / 2 : 60000;
        if (
          now - lastHeartbeatEmitMs < 30000 &&
          (sinceActivityMs < stallMs || now - lastHeartbeatEmitMs < 5000)
        ) {
          return;
        }
        lastHeartbeatEmitMs = now;
        const elapsed = Math.round((now - startMs) / 1000);
        const sinceActivity = Math.round(sinceActivityMs / 1000);
        const shortRunId = String(run.run_id).slice(0, 8);
        process.stderr.write(
          `  [heartbeat] ${agent}#${shortRunId} elapsed=${elapsed}s since-activity=${sinceActivity}s activity-ticks=${activityTicks}\n`,
        );
      }, heartbeatMs);
      heartbeatHandle.unref?.();
    }

    const clearLivelinessTimers = (): void => {
      if (heartbeatHandle) clearInterval(heartbeatHandle);
      if (claimWatchHandle) clearInterval(claimWatchHandle);
    };

    // Single settlement (issue #296): the shared lifecycle resolves exactly
    // once — on normal exit, on spawn failure, or after a fired limit's
    // whole-tree termination is confirmed (graceful → forced → confirm).
    const outcome = await managed.settled;
    clearLivelinessTimers();
    if (outcome.spawnError) {
      const msg = `[guildctl] Failed to start agent: ${outcome.spawnError}`;
      process.stderr.write(msg + "\n");
      writeLogLine(logStream, msg);
    }
    const exitCode = outcome.firingLimit
      ? 124
      : outcome.spawnError != null
        ? 1
        : (outcome.exitCode ?? 1);
    return completeRun(exitCode, outcome.cleanupResult);
  })();
}
