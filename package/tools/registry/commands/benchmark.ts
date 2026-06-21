import type Database from "better-sqlite3";
import { RegistryError } from "../types";
import type { BenchmarkComparison, BenchmarkMode, BenchmarkRun, BenchmarkVerdict } from "../types";
import { appendEvent } from "./events";

export interface RecordBenchmarkRunOptions {
  mode: BenchmarkMode;
  fixture: string;
  startedAt?: string;
  finishedAt?: string;
  elapsedMs: number;
  totalRuns: number;
  failedRuns: number;
  artifactsPlanned: number;
  artifactsCompleted: number;
  evidencePassRate: number;
  reworkCount: number;
  totalCostUsd?: number | null;
  verdict: BenchmarkVerdict;
  notes?: string | null;
}

export interface ListBenchmarkRunsFilters {
  mode?: BenchmarkMode;
  fixture?: string;
}

function assertMode(mode: string): asserts mode is BenchmarkMode {
  if (mode !== "single-agent" && mode !== "guild") throw new RegistryError(1, "Benchmark mode must be single-agent or guild");
}
function assertVerdict(verdict: string): asserts verdict is BenchmarkVerdict {
  if (verdict !== "pass" && verdict !== "fail") throw new RegistryError(1, "Benchmark verdict must be pass or fail");
}
function assertNonNegative(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new RegistryError(1, `${name} must be a non-negative number`);
}
function assertRate(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new RegistryError(1, "evidence_pass_rate must be between 0 and 1");
}
function completionRate(row: BenchmarkRun): number {
  return row.artifacts_planned === 0 ? 0 : row.artifacts_completed / row.artifacts_planned;
}

export function recordBenchmarkRun(db: Database.Database, opts: RecordBenchmarkRunOptions): BenchmarkRun {
  assertMode(opts.mode);
  assertVerdict(opts.verdict);
  if (!opts.fixture.trim()) throw new RegistryError(1, "Benchmark fixture is required");
  assertNonNegative("elapsed_ms", opts.elapsedMs);
  assertNonNegative("total_runs", opts.totalRuns);
  assertNonNegative("failed_runs", opts.failedRuns);
  assertNonNegative("artifacts_planned", opts.artifactsPlanned);
  assertNonNegative("artifacts_completed", opts.artifactsCompleted);
  assertNonNegative("rework_count", opts.reworkCount);
  assertRate(opts.evidencePassRate);
  if (opts.totalCostUsd !== undefined && opts.totalCostUsd !== null) assertNonNegative("total_cost_usd", opts.totalCostUsd);

  const result = db.prepare(`INSERT INTO benchmark_runs (
    mode, fixture, started_at, finished_at, elapsed_ms, total_runs, failed_runs,
    artifacts_planned, artifacts_completed, evidence_pass_rate, rework_count,
    total_cost_usd, verdict, notes
  ) VALUES (
    @mode, @fixture, COALESCE(@started_at, datetime('now')), COALESCE(@finished_at, datetime('now')),
    @elapsed_ms, @total_runs, @failed_runs, @artifacts_planned, @artifacts_completed,
    @evidence_pass_rate, @rework_count, @total_cost_usd, @verdict, @notes
  )`).run({
    mode: opts.mode,
    fixture: opts.fixture,
    started_at: opts.startedAt ?? null,
    finished_at: opts.finishedAt ?? null,
    elapsed_ms: opts.elapsedMs,
    total_runs: opts.totalRuns,
    failed_runs: opts.failedRuns,
    artifacts_planned: opts.artifactsPlanned,
    artifacts_completed: opts.artifactsCompleted,
    evidence_pass_rate: opts.evidencePassRate,
    rework_count: opts.reworkCount,
    total_cost_usd: opts.totalCostUsd ?? null,
    verdict: opts.verdict,
    notes: opts.notes ?? null,
  });
  const row = db.prepare("SELECT * FROM benchmark_runs WHERE rowid = ?").get(result.lastInsertRowid) as BenchmarkRun;
  const artifact = db.prepare("SELECT id FROM artifacts ORDER BY created_at LIMIT 1").get() as { id: string } | undefined;
  if (artifact) {
    appendEvent(db, { id: artifact.id, type: "benchmark-recorded", agent: "benchmark-runner", summary: `Benchmark recorded: ${row.mode} ${row.fixture} ${row.verdict}`, data: JSON.stringify({ benchmark_id: row.benchmark_id, mode: row.mode, fixture: row.fixture }) });
  }
  return row;
}

export function listBenchmarkRuns(db: Database.Database, filters: ListBenchmarkRunsFilters = {}): BenchmarkRun[] {
  const conditions: string[] = [];
  const params: Record<string,string> = {};
  if (filters.mode) { assertMode(filters.mode); conditions.push("mode = @mode"); params.mode = filters.mode; }
  if (filters.fixture) { conditions.push("fixture = @fixture"); params.fixture = filters.fixture; }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  return db.prepare(`SELECT * FROM benchmark_runs ${where} ORDER BY started_at DESC, rowid DESC`).all(params) as BenchmarkRun[];
}

export function getBenchmarkRun(db: Database.Database, id: string): BenchmarkRun {
  const row = db.prepare("SELECT * FROM benchmark_runs WHERE benchmark_id = ?").get(id) as BenchmarkRun | undefined;
  if (!row) throw new RegistryError(2, `Benchmark run not found: ${id}`);
  return row;
}

export function compareBenchmarkRuns(db: Database.Database, baselineId: string, guildId: string): BenchmarkComparison {
  const baseline = getBenchmarkRun(db, baselineId);
  const guild = getBenchmarkRun(db, guildId);
  if (baseline.mode !== "single-agent") throw new RegistryError(1, "Baseline benchmark must have mode single-agent");
  if (guild.mode !== "guild") throw new RegistryError(1, "Guild benchmark must have mode guild");
  const costDelta = baseline.total_cost_usd === null || guild.total_cost_usd === null ? null : guild.total_cost_usd - baseline.total_cost_usd;
  return {
    baseline,
    guild,
    deltas: {
      elapsed_ms: guild.elapsed_ms - baseline.elapsed_ms,
      failed_runs: guild.failed_runs - baseline.failed_runs,
      completion_rate: completionRate(guild) - completionRate(baseline),
      evidence_pass_rate: guild.evidence_pass_rate - baseline.evidence_pass_rate,
      rework_count: guild.rework_count - baseline.rework_count,
      total_cost_usd: costDelta,
    },
  };
}
