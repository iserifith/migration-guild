import type Database from "better-sqlite3";
import { compareBenchmarkRuns, listBenchmarkRuns, recordBenchmarkRun } from "../../registry/commands/benchmark";
import type { BenchmarkMode, BenchmarkVerdict } from "../../registry/types";

export interface BenchmarkRecordOptions {
  mode: BenchmarkMode;
  fixture: string;
  elapsedMs: number;
  totalRuns: number;
  failedRuns: number;
  artifactsPlanned: number;
  artifactsCompleted: number;
  evidencePassRate: number;
  reworkCount: number;
  verdict: BenchmarkVerdict;
  totalCostUsd?: number;
  notes?: string;
  json?: boolean;
}
export interface BenchmarkReportOptions { json?: boolean; mode?: BenchmarkMode; fixture?: string; }
export interface BenchmarkCompareOptions { baseline: string; guild: string; json?: boolean; }

export function runBenchmarkRecord(db: Database.Database, opts: BenchmarkRecordOptions): void {
  const row = recordBenchmarkRun(db, opts);
  if (opts.json) { process.stdout.write(JSON.stringify(row, null, 2) + "\n"); return; }
  process.stdout.write(`✓ Benchmark recorded: ${row.benchmark_id} ${row.mode} ${row.fixture} ${row.verdict}\n`);
}
export function runBenchmarkReport(db: Database.Database, opts: BenchmarkReportOptions = {}): void {
  const rows = listBenchmarkRuns(db, { mode: opts.mode, fixture: opts.fixture });
  if (opts.json) { process.stdout.write(JSON.stringify(rows, null, 2) + "\n"); return; }
  if (rows.length === 0) { process.stdout.write("No benchmark runs recorded.\n"); return; }
  for (const r of rows) {
    const complete = r.artifacts_planned === 0 ? 0 : r.artifacts_completed / r.artifacts_planned;
    process.stdout.write(`${r.benchmark_id} ${r.mode} fixture=${r.fixture} verdict=${r.verdict} elapsed_ms=${r.elapsed_ms} failed_runs=${r.failed_runs} completion=${(complete*100).toFixed(1)}% evidence_pass=${(r.evidence_pass_rate*100).toFixed(1)}% rework=${r.rework_count}\n`);
  }
}
export function runBenchmarkCompare(db: Database.Database, opts: BenchmarkCompareOptions): void {
  const comparison = compareBenchmarkRuns(db, opts.baseline, opts.guild);
  if (opts.json) { process.stdout.write(JSON.stringify(comparison, null, 2) + "\n"); return; }
  process.stdout.write(`Benchmark compare: baseline=${comparison.baseline.benchmark_id} guild=${comparison.guild.benchmark_id}\n`);
  process.stdout.write(`- elapsed_ms delta: ${comparison.deltas.elapsed_ms}\n`);
  process.stdout.write(`- failed_runs delta: ${comparison.deltas.failed_runs}\n`);
  process.stdout.write(`- completion_rate delta: ${(comparison.deltas.completion_rate*100).toFixed(1)}%\n`);
  process.stdout.write(`- evidence_pass_rate delta: ${(comparison.deltas.evidence_pass_rate*100).toFixed(1)}%\n`);
  process.stdout.write(`- rework_count delta: ${comparison.deltas.rework_count}\n`);
  process.stdout.write(`- total_cost_usd delta: ${comparison.deltas.total_cost_usd ?? "n/a"}\n`);
}
