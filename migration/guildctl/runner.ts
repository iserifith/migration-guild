import { spawn, execFileSync, spawnSync } from "child_process";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { Transform } from "stream";
import type Database from "better-sqlite3";
import { releaseClaimedArtifactsForOwner } from "../registry/commands/artifacts";
import { releaseClaimsForRun } from "../registry/commands/claim";
import { startRun, finishRun, setRunPid } from "../registry/commands/runs";
import {
  loadConfig,
  requireProviderConfig,
  requirePhaseProviderConfig,
  resolvePhaseProvider,
} from "../provider/config";
import type { PhaseKey } from "../provider/config";

export interface SpawnAgentOpts {
  agent: string;
  model: string;
  prompt: string;
  db: Database.Database;
  logDir?: string;
  phase?: PhaseKey;
  timeoutMs?: number;
  claimOwner?: string;
  releaseClaimsOnFailure?: boolean;
  preClaim?: PreClaimOpts;
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
}

function getAgentCommand(): string {
  return process.env["AGENT_CMD"] ?? "agent";
}

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
    }).trim();
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
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

function writeLogLine(stream: fs.WriteStream | undefined, line: string): void {
  stream?.write(`[${formatLocalClockTime()}] ${line}\n`);
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
      return `${result.agent} exit=${result.exitCode}${logNote}`;
    })
    .join("; ");

  const extra = failed.length > 3 ? ` (+${failed.length - 3} more)` : "";
  return `${failed.length} agent run(s) failed: ${sample}${extra}`;
}

function spawnAgentProcess(opts: SpawnAgentOpts): Promise<AgentRunResult> {
  const { agent, model, prompt, db } = opts;
  const claimOwner = opts.claimOwner ?? `${agent}:${randomUUID()}`;
  const runId = randomUUID().replace(/-/g, "").slice(0, 16);
  const startMs = Date.now();
  const startedIso = new Date(startMs).toISOString();
  const projectRoot = path.resolve(__dirname, "..", "..", "..");
  const beforeFiles = snapshotChangedFiles(projectRoot);

  const logFile = opts.logDir
    ? path.join(opts.logDir, formatLogFileName(agent, startMs, runId, opts.phase))
    : undefined;

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
        `Command:    ${getAgentCommand()} --agent ${agent} --model ${model} --yolo -p <prompt:${prompt.length} chars>`,
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

  if (opts.preClaim) {
    const claimArgs = [
      "migration/registry/dist/cli.js",
      "claim",
      "--agent", agent,
      "--owner", claimOwner,
      "--run-id", run.run_id,
      "--model", model,
      "--from-status", opts.preClaim.fromStatus,
      "--tier", opts.preClaim.tier ?? "first-class",
    ];
    if (opts.preClaim.wave != null) {
      claimArgs.push("--wave", String(opts.preClaim.wave));
    }
    const claimResult = spawnSync("node", claimArgs, {
      cwd: projectRoot,
      encoding: "utf8",
    });
    if (claimResult.status === 2) {
      // Nothing left to claim — finish run cleanly and return no-op.
      finishRun(db, { runId: run.run_id, exitCode: 0 });
      logStream?.end();
      return Promise.resolve({ runId: run.run_id, agent, model, prompt, logFile, exitCode: 0 });
    }
    if (claimResult.status !== 0) {
      const errMsg = (claimResult.stderr ?? "").trim() || (claimResult.stdout ?? "").trim();
      process.stderr.write(`[guildctl] pre-claim failed (exit ${claimResult.status}): ${errMsg}\n`);
      writeLogLine(logStream, `[guildctl] pre-claim failed (exit ${claimResult.status}): ${errMsg}`);
      finishRun(db, { runId: run.run_id, exitCode: 1, reason: `pre-claim failed: ${errMsg}` });
      logStream?.end();
      return Promise.resolve({ runId: run.run_id, agent, model, prompt, logFile, exitCode: 1 });
    }
    try {
      const claimed = JSON.parse(claimResult.stdout) as { id: string; claim_id: string; claim_token: string };
      preClaimedArtifactId = claimed.id;
      preClaimId = claimed.claim_id;
      preClaimToken = claimed.claim_token;
    } catch {
      process.stderr.write(`[guildctl] pre-claim: failed to parse claim JSON\n`);
      finishRun(db, { runId: run.run_id, exitCode: 1, reason: "pre-claim: failed to parse claim JSON" });
      logStream?.end();
      return Promise.resolve({ runId: run.run_id, agent, model, prompt, logFile, exitCode: 1 });
    }
  }

  // Always run from the project root (my-migration/) so agent shell commands
  // like `node migration/registry/dist/cli.js ...` resolve correctly.
  const proc = spawn(getAgentCommand(), args, {
    cwd: projectRoot,
    env: {
      ...process.env,
      GUILDCTL_AGENT_NAME: claimOwner,
      GUILDCTL_AGENT_KIND: agent,
      GUILDCTL_RUN_ID: run.run_id,
      ...(preClaimedArtifactId != null ? {
        GUILDCTL_ARTIFACT_ID: preClaimedArtifactId,
        GUILDCTL_CLAIM_ID: preClaimId!,
        GUILDCTL_CLAIM_TOKEN: preClaimToken!,
      } : {}),
    },
    stdio: logStream ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  setRunPid(db, run.run_id, proc.pid ?? null);

  if (logStream && proc.stdout && proc.stderr) {
    proc.stdout.pipe(createTimestampTransform()).pipe(logStream, { end: false });
    proc.stderr.pipe(createTimestampTransform()).pipe(logStream, { end: false });
  }

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    let killHandle: NodeJS.Timeout | undefined;
    let claimWatchHandle: NodeJS.Timeout | undefined;
    let claimIntroWritten = false;

    if (logStream) {
      claimWatchHandle = setInterval(() => {
        if (settled || claimIntroWritten) {
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

    const finalize = (exitCode: number) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (killHandle) clearTimeout(killHandle);
      if (claimWatchHandle) clearInterval(claimWatchHandle);
      let finalExitCode = exitCode;
      try {
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
      const terminationReason = timedOut
        ? `${agent} timed out`
        : finalExitCode === 0
          ? undefined
          : `${agent} exited with code ${finalExitCode}`;
      finishRun(db, {
        runId: run.run_id,
        exitCode: finalExitCode,
        reason: terminationReason,
      });

      const result = {
        runId: run.run_id,
        agent,
        model,
        prompt,
        logFile,
        exitCode: finalExitCode,
      };

      if (logStream) {
        const elapsedS = ((Date.now() - startMs) / 1000).toFixed(1);
        const status = timedOut
          ? "TIMEOUT"
          : finalExitCode === 0
            ? "SUCCESS"
            : "FAILED";
        const written = getNewlyWrittenFiles(projectRoot, beforeFiles);
        const filesBlock =
          written.length > 0
            ? [`Files written (${written.length}):`, ...written.map((f) => `  ${f}`)]
            : ["Files written: (none)"];
        const claimBlock = getRunClaimLines(db, run.run_id);
        logStream.end(
          [
            "",
            LOG_SEP,
            `Status:   ${status}`,
            `Exit:     ${finalExitCode}`,
            `Elapsed:  ${elapsedS}s`,
            `Finished: ${new Date().toISOString()}`,
            ...claimBlock,
            ...filesBlock,
            LOG_SEP,
            "",
          ].join("\n"),
          () => resolve(result),
        );
      } else {
        resolve(result);
      }
    };

    if ((opts.timeoutMs ?? 0) > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        const timeoutMins = Math.round((opts.timeoutMs ?? 0) / 60000);
        const msg = `[guildctl] ${agent} timed out after ${timeoutMins}m; terminating pid ${proc.pid ?? "unknown"}`;
        process.stderr.write(msg + "\n");
        writeLogLine(logStream, msg);
        try {
          proc.kill("SIGTERM");
        } catch {
          finalize(124);
          return;
        }
        killHandle = setTimeout(() => {
          if (settled) return;
          try {
            proc.kill("SIGKILL");
          } catch {
            finalize(124);
          }
        }, 5000);
        killHandle.unref?.();
      }, opts.timeoutMs);
      timeoutHandle.unref?.();
    }

    proc.on("exit", (code) => {
      finalize(timedOut ? 124 : (code ?? 1));
    });
    proc.on("error", (err) => {
      const msg = `[guildctl] Failed to start agent: ${err.message}`;
      process.stderr.write(msg + "\n");
      writeLogLine(logStream, msg);
      finalize(1);
    });
  });
}

/**
 * Spawn a agent CLI agent, routing LLM calls through OpenAI-compatible provider when
 * the resolved provider for this phase is "provider". All agent execution,
 * tool use, file I/O and registry access remain local — only the model
 * endpoint changes.
 */
export async function spawnAgent(
  opts: SpawnAgentOpts & { phase?: PhaseKey },
): Promise<AgentRunResult> {
  const cfg = loadConfig();
  const phase = opts.phase;

  // Determine provider for this phase
  const provider = phase
    ? resolvePhaseProvider(phase, cfg.provider)
    : cfg.llmProvider; // fallback to global when no phase given

  if (provider === "provider") {
    const f = phase
      ? requirePhaseProviderConfig(phase, cfg)
      : requireProviderConfig(cfg);
    process.env["AGENT_PROVIDER_BASE_URL"] = f.openaiEndpoint;
    process.env["AGENT_PROVIDER_TYPE"] = f.providerType;
    process.env["AGENT_PROVIDER_API_KEY"] = f.apiKey;
    process.stderr.write(
      `[guildctl] Phase "${phase ?? "unknown"}" → provider (${f.providerType} @ ${f.openaiEndpoint}, model: ${opts.model})\n`,
    );
  } else {
    // Ensure Provider env vars are cleared so Agent uses its own routing
    delete process.env["AGENT_PROVIDER_BASE_URL"];
    delete process.env["AGENT_PROVIDER_TYPE"];
    delete process.env["AGENT_PROVIDER_API_KEY"];
    process.stderr.write(
      `[guildctl] Phase "${phase ?? "unknown"}" → agent (model: ${opts.model})\n`,
    );
  }

  return spawnAgentProcess(opts);
}
