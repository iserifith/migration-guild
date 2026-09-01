import path from "node:path";
import type Database from "better-sqlite3";
import { runAutoCommand } from "./auto";
import { runAutoQueue, type AutoQueueResult, type QueueArtifactExecutor } from "../supervisor/queue";
import { resolveGuildConfig, resolveWorkspaceRoot } from "../config";
import { renderPreflightReport, runPreflight, type PreflightResult } from "../preflight";
import { emitRuntimeReport } from "../runtime-report";

export interface AutoRunCliOptions {
  command?: string[];
  maxAttempts?: number;
  wave?: number;
  limit?: number;
  resume?: boolean;
  json?: boolean;
  registryDbPath?: string;
  setExitCode?: boolean;
  workspaceRoot?: string;
}

export interface AutoRunCommandDependencies {
  executeArtifact?: QueueArtifactExecutor;
  write?: (text: string) => void;
  /** The one shared verdict this queue runs on; injectable so tests stay hermetic. */
  preflight?: () => Promise<PreflightResult>;
}

/**
 * Raised before any artifact is claimed when the resolved runtime path is not
 * known good. Autonomous dispatch accepts `pass` only: `fail` means the path is
 * broken, and `unvalidated` means nobody checked — neither is a licence to
 * spend provider budget on work the queue cannot finish.
 */
export class PreflightGateError extends Error {
  constructor(public readonly result: PreflightResult) {
    super(`autonomous dispatch blocked: preflight ${result.verdict}${result.failedStage ? ` at ${result.failedStage}` : ""}${result.reason ? ` — ${result.reason}` : ""}`);
    this.name = "PreflightGateError";
  }
}

function renderSummary(result: AutoQueueResult): string {
  const remaining = result.remaining;
  return [
    `auto-run ${result.status}`,
    `completed=${result.completed}`,
    `blocked=${result.blocked}`,
    `planned=${remaining.planned}`,
    `migrated=${remaining.migrated}`,
    `in-progress=${remaining.inProgress}`,
    `dependency-blocked=${result.dependencyBlocked.length}`,
  ].join(" ") + "\n";
}

export async function runAutoRunCommand(
  db: Database.Database,
  opts: AutoRunCliOptions,
  dependencies: AutoRunCommandDependencies = {},
): Promise<AutoQueueResult> {
  if (!opts.registryDbPath || !path.isAbsolute(opts.registryDbPath)) {
    throw new Error("guildctl auto-run requires the resolved absolute registry DB path for exact worker handoff");
  }
  const workspaceRoot = opts.workspaceRoot ?? resolveWorkspaceRoot();
  const write = dependencies.write ?? ((text: string) => process.stdout.write(text));

  // One verdict for the whole queue, taken before anything is claimed and
  // regardless of where the harness came from — not one live request per
  // artifact, and no exemption for an AGENT_CMD harness.
  const runQueuePreflight = dependencies.preflight ?? (async () => {
    const cfg = resolveGuildConfig({ cwd: workspaceRoot });
    return runPreflight({
      config: cfg,
      root: cfg.guildRoot,
      offline: process.env.GUILD_PREFLIGHT_OFFLINE === "1",
    });
  });
  const preflight = await runQueuePreflight();
  if (preflight.verdict !== "pass") {
    write(renderPreflightReport(preflight));
    throw new PreflightGateError(preflight);
  }

  // FR-024: exactly one run-start line per autonomous queue, rendered from the
  // resolution the gate just validated — not one per artifact. The per-artifact
  // path (`commands/auto.ts`), the supervisor queue, and `spawnAgent` say
  // nothing, so a queue of 200 artifacts still reports its runtime once.
  if (preflight.resolved) emitRuntimeReport(preflight.resolved, { write });

  const executeArtifact = dependencies.executeArtifact ?? (async ({ artifactId, resume }) =>
    runAutoCommand(db, {
      artifact: artifactId,
      command: opts.command,
      maxAttempts: opts.maxAttempts,
      resume,
      registryDbPath: opts.registryDbPath,
      setExitCode: false,
      quiet: true,
    }));
  const result = await runAutoQueue(db, {
    executeArtifact,
    wave: opts.wave,
    limit: opts.limit,
    resume: opts.resume,
    workspaceRoot,
    write,
  });

  if (opts.setExitCode !== false) {
    if (result.status === "cancelled") process.exitCode = 130;
    else if (["partial", "stalled", "failed"].includes(result.status)) process.exitCode = 1;
  }
  write(opts.json ? JSON.stringify(result, null, 2) + "\n" : renderSummary(result));
  return result;
}
