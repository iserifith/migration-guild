import type Database from "better-sqlite3";
import type { Command } from "commander";
import type { FoundryClient } from "../foundry-client";
import type { EvalConfig } from "../config";
import type { Evaluation } from "../../registry/types";
import { getEvalConfig } from "../config";
import { loadConfig } from "../config";
import { evaluateArtifact, type EvalArtifactResult } from "./run-eval";

// ─── Formatting helpers ───────────────────────────────────────────────────────

function passLabel(pass: boolean | number): string {
  return pass ? "PASS" : "FAIL";
}

function scoreStr(score: number | null): string {
  return score !== null ? score.toFixed(3) : "n/a";
}

function printResultTable(result: EvalArtifactResult): void {
  const col1 = 28;
  const col2 = 6;
  const col3 = 7;
  const header =
    `${"EVALUATOR".padEnd(col1)}${"PASS".padEnd(col2)}${"SCORE".padEnd(col3)}FEEDBACK`;
  const divider = "-".repeat(80);

  process.stdout.write(`\n${header}\n${divider}\n`);
  for (const r of result.results) {
    const line =
      r.evaluator.padEnd(col1) +
      passLabel(r.pass).padEnd(col2) +
      scoreStr(r.score).padEnd(col3) +
      r.feedback.replace(/\n/g, " ");
    process.stdout.write(`${line}\n`);
  }
  process.stdout.write(`${divider}\n`);
  process.stdout.write(
    `Overall: ${passLabel(result.pass)}  aggregate score: ${scoreStr(result.score)}\n\n`,
  );
}

function printEvalRows(rows: Evaluation[]): void {
  if (rows.length === 0) {
    process.stdout.write("No evaluation records found.\n");
    return;
  }

  // Group by artifact
  const byArtifact = new Map<string, Evaluation[]>();
  for (const row of rows) {
    const list = byArtifact.get(row.artifact_id) ?? [];
    list.push(row);
    byArtifact.set(row.artifact_id, list);
  }

  for (const [artifactId, evals] of byArtifact) {
    process.stdout.write(`\nArtifact: ${artifactId}\n`);
    const col1 = 28;
    const col2 = 6;
    const col3 = 7;
    const col4 = 26;
    const header =
      `${"EVALUATOR".padEnd(col1)}${"PASS".padEnd(col2)}${"SCORE".padEnd(col3)}${"EVALUATED AT".padEnd(col4)}FEEDBACK`;
    const divider = "-".repeat(100);
    process.stdout.write(`${header}\n${divider}\n`);
    for (const e of evals) {
      const line =
        e.evaluator.padEnd(col1) +
        passLabel(e.pass).padEnd(col2) +
        scoreStr(e.score).padEnd(col3) +
        e.eval_at.padEnd(col4) +
        (e.feedback ?? "").replace(/\n/g, " ");
      process.stdout.write(`${line}\n`);
    }
    const passCount = evals.filter((e) => e.pass).length;
    process.stdout.write(
      `Pass rate: ${passCount}/${evals.length} (${Math.round((passCount / evals.length) * 100)}%)\n`,
    );
  }
  process.stdout.write("\n");
}

// ─── Command registration ─────────────────────────────────────────────────────

export function registerEvalCommands(
  program: Command,
  getDb: () => Database.Database,
  getClient: () => FoundryClient,
): void {
  // ── evaluate-artifact ──────────────────────────────────────────────────────

  program
    .command("evaluate-artifact")
    .description("Run evaluators against a single migrated artifact")
    .requiredOption("--id <id>", "Artifact ID")
    .option("--auto-advance", "Auto-advance artifact status based on evaluation outcome")
    .action(async (opts: { id: string; autoAdvance?: boolean }) => {
      const db = getDb(); const client = getClient();
      const cfg: EvalConfig = getEvalConfig(loadConfig());
      try {
        const result = await evaluateArtifact(db, client, opts.id, cfg, {
          autoAdvance: opts.autoAdvance,
        });
        printResultTable(result);
        process.exit(result.pass ? 0 : 1);
      } catch (err) {
        process.stderr.write(`Error: ${(err as Error).message}\n`);
        process.exit(1);
      }
    });

  // ── evaluate-wave ─────────────────────────────────────────────────────────

  program
    .command("evaluate-wave")
    .description("Run evaluators against all migrated artifacts in a wave")
    .requiredOption("--wave <n>", "Wave number", parseInt)
    .option("--auto-advance", "Auto-advance artifact status based on evaluation outcome")
    .action(async (opts: { wave: number; autoAdvance?: boolean }) => {
      const db = getDb(); const client = getClient();
      const cfg: EvalConfig = getEvalConfig(loadConfig());

      const artifacts = db
        .prepare(
          `SELECT id FROM artifacts WHERE status = 'migrated' AND wave = ?`,
        )
        .all(opts.wave) as { id: string }[];

      if (artifacts.length === 0) {
        process.stdout.write(`No migrated artifacts found in wave ${opts.wave}.\n`);
        return;
      }

      process.stdout.write(
        `Evaluating ${artifacts.length} artifact(s) in wave ${opts.wave}...\n`,
      );

      let passed = 0;
      let failed = 0;

      for (const { id } of artifacts) {
        process.stdout.write(`\n→ ${id}\n`);
        try {
          const result = await evaluateArtifact(db, client, id, cfg, {
            autoAdvance: opts.autoAdvance,
          });
          printResultTable(result);
          if (result.pass) passed++;
          else failed++;
        } catch (err) {
          process.stderr.write(`  Error: ${(err as Error).message}\n`);
          failed++;
        }
      }

      process.stdout.write(
        `\nWave ${opts.wave} summary: ${passed} passed, ${failed} failed out of ${artifacts.length} artifacts.\n`,
      );
    });

  // ── eval-report ───────────────────────────────────────────────────────────

  program
    .command("eval-report")
    .description("Query and display evaluation results")
    .option("--artifact <id>", "Filter by artifact ID")
    .option("--wave <n>", "Filter by wave number", parseInt)
    .option("--json", "Output raw JSON")
    .action((opts: { artifact?: string; wave?: number; json?: boolean }) => {
      const db = getDb();
      let rows: Evaluation[];

      if (opts.artifact) {
        rows = db
          .prepare(
            `SELECT e.* FROM evaluations e WHERE e.artifact_id = ? ORDER BY e.eval_at DESC`,
          )
          .all(opts.artifact) as Evaluation[];
      } else if (opts.wave !== undefined) {
        rows = db
          .prepare(
            `SELECT e.*
             FROM evaluations e
             JOIN artifacts a ON a.id = e.artifact_id
             WHERE a.wave = ?
             ORDER BY a.id, e.eval_at DESC`,
          )
          .all(opts.wave) as Evaluation[];
      } else {
        rows = db
          .prepare(
            `SELECT e.*
             FROM evaluations e
             JOIN artifacts a ON a.id = e.artifact_id
             ORDER BY a.id, e.eval_at DESC`,
          )
          .all() as Evaluation[];
      }

      if (opts.json) {
        process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
        return;
      }

      printEvalRows(rows);
    });
}
