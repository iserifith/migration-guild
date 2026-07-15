import type Database from "better-sqlite3";
import { resolveGuildConfig, resolveWorkspaceRoot } from "../config";
import { runVerify } from "../verify";
import { createRunOperatorCredential } from "../../registry/commands/claim";
import { finishRun, startRun } from "../../registry/commands/runs";

export interface VerifyCliOptions {
  artifact: string;
  command?: string[];
  json?: boolean;
}

function configuredCommands(opts: VerifyCliOptions): string[] {
  const values = opts.command ?? [];
  return values.flatMap((item) => item.split(";;")).map((item) => item.trim()).filter(Boolean);
}

export async function runVerifyCommand(db: Database.Database, opts: VerifyCliOptions): Promise<void> {
  const workspaceRoot = resolveWorkspaceRoot();
  const cfg = resolveGuildConfig({ cwd: workspaceRoot });
  const commands = configuredCommands(opts);
  const run = startRun(db, {
    agent: "guildctl-verify",
    ownerId: "guildctl-verify",
    phase: "verify",
    prompt: `verify ${opts.artifact}`,
  });
  const operator = createRunOperatorCredential(db, run.run_id);
  let result;
  try {
    result = await runVerify(db, {
      artifactId: opts.artifact,
      workspaceRoot,
      commands: commands.length > 0 ? commands : ["npm test"],
      outputDir: `${workspaceRoot}/${cfg.evidence.output_dir}/runtime`,
      runId: run.run_id,
      operatorToken: operator.token,
    });
    finishRun(db, { runId: run.run_id, exitCode: result.pass ? 0 : 1 });
  } catch (error) {
    finishRun(db, { runId: run.run_id, exitCode: 1, reason: error instanceof Error ? error.message : String(error) });
    throw error;
  }
  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    if (!result.pass) process.exitCode = 1;
    return;
  }
  for (const evidence of result.evidence) {
    process.stdout.write(`${evidence.evidence_type} ${evidence.pass ? "PASS" : "FAIL"} ${evidence.command} log=${evidence.output_path}\n`);
  }
  if (!result.pass) process.exitCode = 1;
}
