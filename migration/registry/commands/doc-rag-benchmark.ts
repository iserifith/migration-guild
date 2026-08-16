import type Database from "better-sqlite3";
import { RegistryError } from "../types";
import type { BenchmarkVerdict } from "../types";

/**
 * 007-doc-rag-lookup — T038 (SC-003 hallucination-reduction benchmark).
 *
 * A SEPARATE axis from `benchmark.ts`'s `single-agent` vs `guild` mode
 * (registry_schema.sql's `benchmark_runs`). SC-003 compares the SAME migration
 * input run twice — once with the doc-RAG lookup tool surface registered for
 * the Migrate/Critic agents, once with it deliberately unregistered — and
 * records each run's count of Critic-flagged API-hallucination findings
 * (references that matched a `verify_library_docs` `verified-absent` outcome,
 * FR-010).
 *
 * We persist those two run records in a dedicated `doc_rag_benchmark_runs`
 * table rather than overloading `benchmark_runs`, because no existing
 * `BenchmarkMode` (`single-agent` | `guild`) captures a "with-lookup" vs
 * "without-lookup" axis, and `benchmark_runs` has no hallucination-finding
 * metric column. The shape deliberately mirrors `benchmark.ts`'s
 * `recordBenchmarkRun` / `compareBenchmarkRuns` conventions (started_at,
 * finished_at, elapsed_ms, mode, fixture, verdict, notes) so the two comparison
 * formats stay consistent.
 */

export type DocRagBenchmarkMode = "with-lookup" | "without-lookup";

export interface RecordDocRagBenchmarkRunOptions {
  mode: DocRagBenchmarkMode;
  fixture: string;
  startedAt?: string;
  finishedAt?: string;
  elapsedMs: number;
  /** Number of Critic findings whose reference matched a verified-absent outcome (FR-010). */
  hallucinationFindings: number;
  totalReferencesChecked: number;
  verdict: BenchmarkVerdict;
  notes?: string | null;
}

export interface DocRagBenchmarkRun {
  benchmark_id: string;
  mode: DocRagBenchmarkMode;
  fixture: string;
  started_at: string;
  finished_at: string;
  elapsed_ms: number;
  hallucination_findings: number;
  total_references_checked: number;
  verdict: BenchmarkVerdict;
  notes: string | null;
}

export interface DocRagBenchmarkComparison {
  withLookupFindings: number;
  withoutLookupFindings: number;
  reductionRatio: number;
  verdict: BenchmarkVerdict;
}

const DOC_RAG_BENCHMARK_SCHEMA = `
CREATE TABLE IF NOT EXISTS doc_rag_benchmark_runs (
  benchmark_id            TEXT PRIMARY KEY,
  mode                    TEXT NOT NULL CHECK (mode IN ('with-lookup', 'without-lookup')),
  fixture                 TEXT NOT NULL,
  started_at              TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at             TEXT NOT NULL DEFAULT (datetime('now')),
  elapsed_ms              INTEGER NOT NULL,
  hallucination_findings  INTEGER NOT NULL,
  total_references_checked INTEGER NOT NULL DEFAULT 0,
  verdict                 TEXT NOT NULL CHECK (verdict IN ('pass', 'fail')),
  notes                   TEXT
);
`;

/** Idempotent schema application — safe to call on any registry connection. */
export function applyDocRagBenchmarkSchema(db: Database.Database): void {
  db.exec(DOC_RAG_BENCHMARK_SCHEMA);
}

function assertMode(mode: string): asserts mode is DocRagBenchmarkMode {
  if (mode !== "with-lookup" && mode !== "without-lookup") {
    throw new RegistryError(1, "Doc-RAG benchmark mode must be with-lookup or without-lookup");
  }
}
function assertVerdict(verdict: string): asserts verdict is BenchmarkVerdict {
  if (verdict !== "pass" && verdict !== "fail") {
    throw new RegistryError(1, "Benchmark verdict must be pass or fail");
  }
}

function makeId(): string {
  return `drb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function recordDocRagBenchmarkRun(db: Database.Database, opts: RecordDocRagBenchmarkRunOptions): DocRagBenchmarkRun {
  applyDocRagBenchmarkSchema(db);
  assertMode(opts.mode);
  assertVerdict(opts.verdict);
  if (!opts.fixture.trim()) throw new RegistryError(1, "Doc-RAG benchmark fixture is required");
  if (!Number.isFinite(opts.elapsedMs) || opts.elapsedMs < 0) throw new RegistryError(1, "elapsed_ms must be a non-negative number");
  if (!Number.isInteger(opts.hallucinationFindings) || opts.hallucinationFindings < 0) {
    throw new RegistryError(1, "hallucination_findings must be a non-negative integer");
  }
  if (!Number.isInteger(opts.totalReferencesChecked) || opts.totalReferencesChecked < 0) {
    throw new RegistryError(1, "total_references_checked must be a non-negative integer");
  }
  const result = db.prepare(`INSERT INTO doc_rag_benchmark_runs (
    benchmark_id, mode, fixture, started_at, finished_at, elapsed_ms,
    hallucination_findings, total_references_checked, verdict, notes
  ) VALUES (
    @benchmark_id, @mode, @fixture, COALESCE(@started_at, datetime('now')), COALESCE(@finished_at, datetime('now')),
    @elapsed_ms, @hallucination_findings, @total_references_checked, @verdict, @notes
  )`).run({
    benchmark_id: makeId(),
    mode: opts.mode,
    fixture: opts.fixture,
    started_at: opts.startedAt ?? null,
    finished_at: opts.finishedAt ?? null,
    elapsed_ms: opts.elapsedMs,
    hallucination_findings: opts.hallucinationFindings,
    total_references_checked: opts.totalReferencesChecked,
    verdict: opts.verdict,
    notes: opts.notes ?? null,
  });
  return db.prepare("SELECT * FROM doc_rag_benchmark_runs WHERE rowid = ?").get(result.lastInsertRowid) as DocRagBenchmarkRun;
}

export function getLatestDocRagBenchmarkRun(db: Database.Database, mode: DocRagBenchmarkMode, fixture: string): DocRagBenchmarkRun | undefined {
  applyDocRagBenchmarkSchema(db);
  return db.prepare(
    "SELECT * FROM doc_rag_benchmark_runs WHERE mode = ? AND fixture = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
  ).get(mode, fixture) as DocRagBenchmarkRun | undefined;
}

/**
 * Compare the two runs of the same fixture (with-lookup vs without-lookup).
 *
 * SC-003 target: with-lookup's hallucination finding count must be at least
 * 50% lower than without-lookup's. `reductionRatio` = 1 - (with / without);
 * the run passes when `withLookupFindings <= 0.5 * withoutLookupFindings`
 * (i.e. reductionRatio >= 0.5), OR trivially when the without-lookup run had
 * zero findings (nothing to reduce, bar considered met).
 */
export function compareDocRagBenchmarkRuns(db: Database.Database, fixture: string): DocRagBenchmarkComparison {
  const withRun = getLatestDocRagBenchmarkRun(db, "with-lookup", fixture);
  const withoutRun = getLatestDocRagBenchmarkRun(db, "without-lookup", fixture);
  if (!withRun || !withoutRun) {
    throw new RegistryError(1, `Both runs must exist for fixture "${fixture}" to compare (got with=${Boolean(withRun)}, without=${Boolean(withoutRun)})`);
  }
  const withLookupFindings = withRun.hallucination_findings;
  const withoutLookupFindings = withoutRun.hallucination_findings;
  const reductionRatio = withoutLookupFindings === 0 ? 1 : 1 - withLookupFindings / withoutLookupFindings;
  const verdict: BenchmarkVerdict =
    withoutLookupFindings === 0 || withLookupFindings <= 0.5 * withoutLookupFindings ? "pass" : "fail";
  return { withLookupFindings, withoutLookupFindings, reductionRatio, verdict };
}
