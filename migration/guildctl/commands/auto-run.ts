import path from "node:path";
import type Database from "better-sqlite3";
import { runAutoCommand } from "./auto";
import { runAutoQueue, type AutoQueueResult, type QueueArtifactExecutor } from "../supervisor/queue";

export interface AutoRunCliOptions {
  command?: string[];
  maxAttempts?: number;
  wave?: number;
  limit?: number;
  resume?: boolean;
  json?: boolean;
  registryDbPath?: string;
  setExitCode?: boolean;
}

export interface AutoRunCommandDependencies {
  executeArtifact?: QueueArtifactExecutor;
  write?: (text: string) => void;
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
  });

  if (opts.setExitCode !== false) {
    if (result.status === "cancelled") process.exitCode = 130;
    else if (["partial", "stalled", "failed"].includes(result.status)) process.exitCode = 1;
  }
  const write = dependencies.write ?? ((text: string) => process.stdout.write(text));
  write(opts.json ? JSON.stringify(result, null, 2) + "\n" : renderSummary(result));
  return result;
}
