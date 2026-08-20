import type Database from "better-sqlite3";
import { resolveGuildConfig, resolveWorkspaceRoot, resolveVerificationBudgetMs } from "../config";
import { runArtifactVerification, runVerify, type ArtifactVerificationOutcome, type VerifyResult } from "../verify";
import { createRunOperatorCredential } from "../../registry/commands/claim";
import { finishRun, startRun } from "../../registry/commands/runs";
import { loadActiveStack, resolvePerArtifactVerify } from "../stack";

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
  let result: VerifyResult & { outcome?: ArtifactVerificationOutcome };
  try {
    if (commands.length > 0) {
      // Explicit --command flag(s): run the operator-supplied shell command(s)
      // exactly as given. No stack resolution — the operator asked for these.
      result = await runVerify(db, {
        artifactId: opts.artifact,
        workspaceRoot,
        commands,
        outputDir: `${workspaceRoot}/${cfg.evidence.output_dir}/runtime`,
        runId: run.run_id,
        operatorToken: operator.token,
        config: cfg,
      });
    } else {
      // US2 (#154) / T008: no --command — resolve the default from the active
      // stack pack's `verify.per_artifact` check (e.g. javac-scope-compile for
      // java-spring), never a hardcoded `npm test`. A pack with no verify:
      // block, or an unavailable toolchain, resolves to an *unverified* outcome
      // (not blocked, not an npm enoent) — runArtifactVerification never throws.
      let check;
      try {
        check = resolvePerArtifactVerify(loadActiveStack(cfg, workspaceRoot));
      } catch {
        // No pack, unknown pack, or a malformed verify block: a missing check
        // is not a failed verification.
        check = undefined;
      }
      const outcome = await runArtifactVerification(db, {
        artifactId: opts.artifact,
        workspaceRoot,
        check,
        budgetMs: resolveVerificationBudgetMs(cfg, process.env, check?.budget_seconds),
        runId: run.run_id,
        operatorToken: operator.token,
        config: cfg,
        recordEvidence: true,
      });
      result = {
        artifactId: opts.artifact,
        pass: outcome.state === "verified",
        evidence: outcome.evidence,
        outcome,
      };
    }
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
  if (result.outcome) {
    const outcome = result.outcome;
    const detail = outcome.detail ? ` — ${outcome.detail}` : "";
    process.stdout.write(`${outcome.state}${outcome.reason ? ` (${outcome.reason})` : ""} method=${outcome.method}${detail}\n`);
  } else {
    for (const evidence of result.evidence) {
      process.stdout.write(`${evidence.evidence_type} ${evidence.pass ? "PASS" : "FAIL"} ${evidence.command} log=${evidence.output_path}\n`);
    }
  }
  if (!result.pass) process.exitCode = 1;
}
