import { spawn } from "child_process";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import type Database from "better-sqlite3";
import { releaseClaimedArtifactsForOwner } from "../registry/commands/artifacts";
import { startRun, finishRun } from "../registry/commands/runs";
import { loadConfig, requireFoundryConfig, requirePhaseFoundryConfig, resolvePhaseProvider } from "../foundry/config";
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

export function spawnCopilot(opts: SpawnCopilotOpts): Promise<AgentRunResult> {
  const { agent, model, prompt, db } = opts;
  const claimOwner = opts.claimOwner ?? `${agent}:${randomUUID()}`;

  const logFile = opts.logDir
    ? path.join(opts.logDir, `${agent}-${Date.now()}-${randomUUID()}.log`)
    : undefined;

  if (logFile) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
  }

  const args = ["--agent", agent, "--model", model, "--yolo", "-p", prompt];
  // Always run from the project root (my-migration/) so agent shell commands
  // like `node migration/registry/dist/cli.js ...` resolve correctly.
  const projectRoot = path.resolve(__dirname, "..", "..", "..");
  const proc = spawn(getCopilotCommand(), args, {
    cwd: projectRoot,
    env: { ...process.env, LEGMOD_AGENT_NAME: claimOwner },
    stdio: logFile ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  const run = startRun(db, { agent, model, prompt, logFile, pid: proc.pid ?? null });

  if (logFile && proc.stdout && proc.stderr) {
    const stream = fs.createWriteStream(logFile, { flags: "a" });
    proc.stdout.pipe(stream);
    proc.stderr.pipe(stream);
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
          const released = releaseClaimedArtifactsForOwner(
            db,
            claimOwner,
            "legmod",
            `auto-released after ${agent} exited without advancing claimed work`,
          );
          if (released.length > 0) {
            finalExitCode = 1;
            process.stderr.write(
              `[legmod] ${agent} exited with code 0 but left ${released.length} claimed artifact(s); marking run failed and releasing claims\n`,
            );
          }
        } else if (opts.releaseClaimsOnFailure) {
          releaseClaimedArtifactsForOwner(
            db,
            claimOwner,
            "legmod",
            `auto-released after ${agent} exited with code ${exitCode}`,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[legmod] Failed to auto-release claims for ${claimOwner}: ${message}\n`);
      }
      finishRun(db, { runId: run.run_id, exitCode: finalExitCode });
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
        process.stderr.write(
          `[legmod] ${agent} timed out after ${Math.round((opts.timeoutMs ?? 0) / 60000)}m; terminating pid ${proc.pid ?? "unknown"}\n`
        );
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
      process.stderr.write(`[legmod] Failed to start copilot: ${err.message}\n`);
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
export async function spawnAgent(opts: SpawnCopilotOpts & { phase?: PhaseKey }): Promise<AgentRunResult> {
  const cfg = loadConfig();
  const phase = opts.phase;

  // Determine provider for this phase
  const provider = phase
    ? resolvePhaseProvider(phase, cfg.foundry)
    : cfg.llmProvider;  // fallback to global when no phase given

  if (provider === "foundry") {
    const f = phase ? requirePhaseFoundryConfig(phase, cfg) : requireFoundryConfig(cfg);
    process.env["COPILOT_PROVIDER_BASE_URL"] = f.openaiEndpoint;
    process.env["COPILOT_PROVIDER_TYPE"]     = f.providerType;
    process.env["COPILOT_PROVIDER_API_KEY"]  = f.apiKey;
    process.stderr.write(
      `[legmod] Phase "${phase ?? "unknown"}" → foundry (${f.providerType} @ ${f.openaiEndpoint}, model: ${opts.model})\n`
    );
  } else {
    // Ensure Foundry env vars are cleared so Copilot uses its own routing
    delete process.env["COPILOT_PROVIDER_BASE_URL"];
    delete process.env["COPILOT_PROVIDER_TYPE"];
    delete process.env["COPILOT_PROVIDER_API_KEY"];
    process.stderr.write(
      `[legmod] Phase "${phase ?? "unknown"}" → copilot (model: ${opts.model})\n`
    );
  }

  return spawnCopilot(opts);
}
