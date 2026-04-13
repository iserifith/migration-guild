import { spawn, execFileSync } from "child_process";
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
  requireFoundryConfig,
  requirePhaseFoundryConfig,
  resolvePhaseProvider,
} from "../foundry/config";
import type { PhaseKey } from "../foundry/config";

export interface SpawnCopilotOpts {
  agent: string;
  model: string;
  prompt: string;
  db: Database.Database;
  logDir?: string;
  phase?: PhaseKey;
  timeoutMs?: number;
  claimOwner?: string;
  releaseClaimsOnFailure?: boolean;
}

export interface AgentRunResult {
  runId: string;
  agent: string;
  model: string;
  prompt: string;
  logFile?: string;
  exitCode: number;
}

function getCopilotCommand(): string {
  return process.env["COPILOT_CMD"] ?? "copilot";
}

const LOG_SEP = "=".repeat(72);

/** Prepends an `[HH:MM:SS.mmm]` timestamp to every line written to the log. */
function createTimestampTransform(): Transform {
  let buf = "";
  return new Transform({
    transform(chunk: Buffer, _enc: string, cb: () => void) {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        this.push(`[${new Date().toISOString().slice(11, 23)}] ${line}\n`);
      }
      cb();
    },
    flush(cb: () => void) {
      if (buf.length > 0) {
        this.push(`[${new Date().toISOString().slice(11, 23)}] ${buf}\n`);
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
  stream?.write(`[${new Date().toISOString().slice(11, 23)}] ${line}\n`);
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

export function spawnCopilot(opts: SpawnCopilotOpts): Promise<AgentRunResult> {
  const { agent, model, prompt, db } = opts;
  const claimOwner = opts.claimOwner ?? `${agent}:${randomUUID()}`;
  const runId = randomUUID().replace(/-/g, "").slice(0, 16);
  const startMs = Date.now();

  const logFile = opts.logDir
    ? path.join(opts.logDir, `${agent}-${Date.now()}-${randomUUID()}.log`)
    : undefined;

  if (logFile) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
  }

  // Open the log stream early so we can write a header before the process starts.
  const logStream = logFile
    ? fs.createWriteStream(logFile, { flags: "a" })
    : undefined;

  if (logStream) {
    const promptPreview =
      prompt.length > 300 ? prompt.slice(0, 300) + "…" : prompt;
    logStream.write(
      [
        LOG_SEP,
        `Agent:   ${agent}`,
        `Model:   ${model}`,
        `Started: ${new Date(startMs).toISOString()}`,
        `Prompt:  ${promptPreview}`,
        LOG_SEP,
        "",
      ].join("\n"),
    );
  }

  const args = ["--agent", agent, "--model", model, "--yolo", "-p", prompt];
  // Always run from the project root (my-migration/) so agent shell commands
  // like `node migration/registry/dist/cli.js ...` resolve correctly.
  const projectRoot = path.resolve(__dirname, "..", "..", "..");
  const beforeFiles = snapshotChangedFiles(projectRoot);
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
  const proc = spawn(getCopilotCommand(), args, {
    cwd: projectRoot,
    env: {
      ...process.env,
      LEGMOD_AGENT_NAME: claimOwner,
      LEGMOD_AGENT_KIND: agent,
      LEGMOD_RUN_ID: run.run_id,
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

    const finalize = (exitCode: number) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (killHandle) clearTimeout(killHandle);
      let finalExitCode = exitCode;
      try {
        if (exitCode === 0) {
          let released = releaseClaimsForRun(
            db,
            run.run_id,
            "legmod",
            `auto-released after ${agent} exited without advancing claimed work`,
          );
          if (released.length === 0) {
            released = releaseClaimedArtifactsForOwner(
              db,
              claimOwner,
              "legmod",
              `auto-released after ${agent} exited without advancing claimed work`,
            );
          }
          if (released.length > 0) {
            finalExitCode = 1;
            const msg = `[legmod] ${agent} exited with code 0 but left ${released.length} claimed artifact(s); marking run failed and releasing claims`;
            process.stderr.write(msg + "\n");
            writeLogLine(logStream, msg);
          }
        } else if (opts.releaseClaimsOnFailure) {
          const released = releaseClaimsForRun(
            db,
            run.run_id,
            "legmod",
            `auto-released after ${agent} exited with code ${exitCode}`,
          );
          if (released.length === 0) {
            releaseClaimedArtifactsForOwner(
              db,
              claimOwner,
              "legmod",
              `auto-released after ${agent} exited with code ${exitCode}`,
            );
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const msg = `[legmod] Failed to auto-release claims for ${claimOwner}: ${message}`;
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
        logStream.end(
          [
            "",
            LOG_SEP,
            `Status:   ${status}`,
            `Exit:     ${finalExitCode}`,
            `Elapsed:  ${elapsedS}s`,
            `Finished: ${new Date().toISOString()}`,
            ...filesBlock,
            LOG_SEP,
            "",
          ].join("\n"),
        );
      }

      resolve({
        runId: run.run_id,
        agent,
        model,
        prompt,
        logFile,
        exitCode: finalExitCode,
      });
    };

    if ((opts.timeoutMs ?? 0) > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        const timeoutMins = Math.round((opts.timeoutMs ?? 0) / 60000);
        const msg = `[legmod] ${agent} timed out after ${timeoutMins}m; terminating pid ${proc.pid ?? "unknown"}`;
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
      const msg = `[legmod] Failed to start copilot: ${err.message}`;
      process.stderr.write(msg + "\n");
      writeLogLine(logStream, msg);
      finalize(1);
    });
  });
}

/**
 * Spawn a Copilot CLI agent, routing LLM calls through Azure Foundry when
 * the resolved provider for this phase is "foundry". All agent execution,
 * tool use, file I/O and registry access remain local — only the model
 * endpoint changes.
 */
export async function spawnAgent(
  opts: SpawnCopilotOpts & { phase?: PhaseKey },
): Promise<AgentRunResult> {
  const cfg = loadConfig();
  const phase = opts.phase;

  // Determine provider for this phase
  const provider = phase
    ? resolvePhaseProvider(phase, cfg.foundry)
    : cfg.llmProvider; // fallback to global when no phase given

  if (provider === "foundry") {
    const f = phase
      ? requirePhaseFoundryConfig(phase, cfg)
      : requireFoundryConfig(cfg);
    process.env["COPILOT_PROVIDER_BASE_URL"] = f.openaiEndpoint;
    process.env["COPILOT_PROVIDER_TYPE"] = f.providerType;
    process.env["COPILOT_PROVIDER_API_KEY"] = f.apiKey;
    process.stderr.write(
      `[legmod] Phase "${phase ?? "unknown"}" → foundry (${f.providerType} @ ${f.openaiEndpoint}, model: ${opts.model})\n`,
    );
  } else {
    // Ensure Foundry env vars are cleared so Copilot uses its own routing
    delete process.env["COPILOT_PROVIDER_BASE_URL"];
    delete process.env["COPILOT_PROVIDER_TYPE"];
    delete process.env["COPILOT_PROVIDER_API_KEY"];
    process.stderr.write(
      `[legmod] Phase "${phase ?? "unknown"}" → copilot (model: ${opts.model})\n`,
    );
  }

  return spawnCopilot(opts);
}
