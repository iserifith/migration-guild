import { exec } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import type Database from "better-sqlite3";
import { addCharacterizationFixtureEvidence } from "../../registry/commands/evidence";
import { writeFixtureFile } from "../../registry/commands/fixture-file";
import type { AcceptanceEvidence } from "../../registry/types";
import { resolveGuildConfig, resolveWorkspaceRoot } from "../config";
import { createRunOperatorCredential } from "../../registry/commands/claim";
import { finishRun, startRun } from "../../registry/commands/runs";

const execAsync = promisify(exec);

export interface CaptureFixtureOptions {
  artifactId: string;
  seam: string;
  command: string;
  workspaceRoot: string;
  outputDir: string;
  runId: string;
  operatorToken: string;
}

export type CaptureFixtureResult =
  | { captured: true; evidence: AcceptanceEvidence }
  | { captured: false; artifactId: string; seam: string; reason: string };

/**
 * Run an already-passing unit/invocation-level legacy test seam and, on
 * success, record its concrete input/output as characterization-fixture
 * evidence. On failure this skips recording rather than fabricating a
 * fixture (spec FR-005) — a seam that needs a live runtime is expected to
 * fail here and is not treated as an error for the overall capture run.
 */
export async function runCaptureFixture(
  db: Database.Database,
  opts: CaptureFixtureOptions,
): Promise<CaptureFixtureResult> {
  fs.mkdirSync(opts.outputDir, { recursive: true });

  let stdout = "";
  let exitCode = 0;
  try {
    const result = await execAsync(opts.command, {
      cwd: opts.workspaceRoot,
      maxBuffer: 10 * 1024 * 1024,
    });
    stdout = result.stdout;
  } catch (error) {
    const err = error as Error & { code?: number };
    exitCode = typeof err.code === "number" ? err.code : 1;
    return {
      captured: false,
      artifactId: opts.artifactId,
      seam: opts.seam,
      reason: `seam command exited ${exitCode}: ${err.message}`,
    };
  }

  let output: unknown;
  try {
    output = JSON.parse(stdout.trim());
  } catch {
    // Not every seam prints JSON; fall back to the raw trimmed stdout as the
    // captured output rather than treating an unparsable stdout as a failure.
    output = stdout.trim();
  }

  const written = writeFixtureFile({
    dir: opts.outputDir,
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
    seam: opts.seam,
    input: null,
    output,
  });

  const evidence = addCharacterizationFixtureEvidence(db, {
    artifactId: opts.artifactId,
    runId: opts.runId,
    command: opts.command,
    exitCode,
    pass: 1,
    summary: `Captured characterization fixture for seam: ${opts.seam}`,
    outputPath: written.path,
    outputExcerpt: stdout.trim().slice(0, 4000),
    contentSha256: written.contentSha256,
  });

  return { captured: true, evidence };
}

// ─── CLI wrapper ──────────────────────────────────────────────────────────

export interface CaptureFixtureCliOptions {
  artifact: string;
  seam: string;
  command: string;
  json?: boolean;
}

export async function runCaptureFixtureCommand(db: Database.Database, opts: CaptureFixtureCliOptions): Promise<void> {
  const workspaceRoot = resolveWorkspaceRoot();
  const cfg = resolveGuildConfig({ cwd: workspaceRoot });
  const run = startRun(db, {
    agent: "guildctl-capture-fixture",
    ownerId: "guildctl-capture-fixture",
    phase: "capture-fixture",
    prompt: `capture-fixture ${opts.artifact} (${opts.seam})`,
  });
  const operator = createRunOperatorCredential(db, run.run_id);
  let result: CaptureFixtureResult;
  try {
    result = await runCaptureFixture(db, {
      artifactId: opts.artifact,
      seam: opts.seam,
      command: opts.command,
      workspaceRoot,
      outputDir: `${workspaceRoot}/${cfg.evidence.output_dir}/characterization`,
      runId: run.run_id,
      operatorToken: operator.token,
    });
    finishRun(db, { runId: run.run_id, exitCode: result.captured ? 0 : 1 });
  } catch (error) {
    finishRun(db, { runId: run.run_id, exitCode: 1, reason: error instanceof Error ? error.message : String(error) });
    throw error;
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    if (!result.captured) process.exitCode = 1;
    return;
  }
  if (result.captured) {
    process.stdout.write(
      `Captured characterization-fixture for artifact ${opts.artifact} (seam: ${opts.seam})\n  evidence: ${result.evidence.evidence_id}\n  content sha256: ${result.evidence.content_sha256}\n`,
    );
  } else {
    process.stdout.write(`Skipped fixture capture for artifact ${opts.artifact} (seam: ${opts.seam}): ${result.reason}\n`);
    process.exitCode = 1;
  }
}
