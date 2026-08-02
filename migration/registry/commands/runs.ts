import type Database from "better-sqlite3";
import type { AttemptOutcome, CleanupOutcome, FilesWrittenSource, OutcomeLabel } from "../types";
import { reconcileStaleClaims } from "./claim";

const STALE_RUN_MINUTES = Math.max(1, parseInt(process.env["GUILDCTL_STALE_RUN_MINS"] ?? "30", 10));

export interface Run {
  run_id: string;
  agent: string;
  owner_id: string | null;
  phase: string | null;
  model: string | null;
  prompt: string | null;
  log_file: string | null;
  pid: number | null;
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  termination_reason: string | null;
  token_input: number;
  token_output: number;
  token_reasoning: number;
  token_cache_read: number;
  token_cache_write: number;
  token_fresh: number;
  token_total: number;
  status: "running" | "completed" | "failed";
  files_written_count: AttemptOutcome["files_written_count"];
  files_written_source: AttemptOutcome["files_written_source"];
  status_from: AttemptOutcome["status_from"];
  status_to: AttemptOutcome["status_to"];
  budget_consumed: AttemptOutcome["budget_consumed"];
  cleanup_outcome: AttemptOutcome["cleanup_outcome"];
  survivor_pids: AttemptOutcome["survivor_pids"];
  outcome_label: AttemptOutcome["outcome_label"];
}

export interface StartRunOptions {
  runId?: string;
  agent: string;
  ownerId?: string;
  phase?: string;
  model?: string;
  prompt?: string;
  logFile?: string;
  pid?: number | null;
}

export interface RunTokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  fresh: number;
  total: number;
}

/**
 * Attempt-outcome fields (FR-030–FR-034). Every one is optional; omitting all
 * of them reproduces the pre-feature `finishRun` behaviour exactly, and each
 * column stays NULL. `0` is a meaningful value for `filesWrittenCount`,
 * distinct from "not determined".
 */
export interface AttemptOutcomeInput {
  filesWrittenCount?: number | null;
  filesWrittenSource?: FilesWrittenSource | null;
  statusFrom?: string | null;
  statusTo?: string | null;
  budgetConsumed?: 0 | 1 | boolean | null;
  cleanupOutcome?: CleanupOutcome | null;
  survivorPids?: number[] | null;
  outcomeLabel?: OutcomeLabel | null;
}

export interface FinishRunOptions extends AttemptOutcomeInput {
  runId: string;
  exitCode: number;
  reason?: string;
  tokenUsage?: RunTokenUsage;
}

export function startRun(db: Database.Database, opts: StartRunOptions): Run {
  if (opts.runId) {
    db.prepare(`
      INSERT INTO runs (run_id, agent, owner_id, phase, model, prompt, log_file, pid)
      VALUES (@run_id, @agent, @owner_id, @phase, @model, @prompt, @log_file, @pid)
    `).run({
      run_id: opts.runId,
      agent: opts.agent,
      owner_id: opts.ownerId ?? null,
      phase: opts.phase ?? null,
      model: opts.model ?? null,
      prompt: opts.prompt ?? null,
      log_file: opts.logFile ?? null,
      pid: opts.pid ?? null,
    });
    return db.prepare(`SELECT * FROM runs WHERE run_id = ?`).get(opts.runId) as Run;
  }
  db.prepare(`
    INSERT INTO runs (agent, owner_id, phase, model, prompt, log_file, pid)
    VALUES (@agent, @owner_id, @phase, @model, @prompt, @log_file, @pid)
  `).run({
    agent: opts.agent,
    owner_id: opts.ownerId ?? null,
    phase: opts.phase ?? null,
    model: opts.model ?? null,
    prompt: opts.prompt ?? null,
    log_file: opts.logFile ?? null,
    pid: opts.pid ?? null,
  });
  return db.prepare(`SELECT * FROM runs WHERE rowid = last_insert_rowid()`).get() as Run;
}

export function setRunPid(
  db: Database.Database,
  runId: string,
  pid: number | null,
): Run {
  db.prepare(`
    UPDATE runs
    SET pid = @pid
    WHERE run_id = @run_id
  `).run({ run_id: runId, pid });

  return db.prepare(`SELECT * FROM runs WHERE run_id = ?`).get(runId) as Run;
}

function normalizeBudgetConsumed(value: AttemptOutcomeInput["budgetConsumed"]): 0 | 1 | null {
  if (value == null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return value ? 1 : 0;
}

export function finishRun(db: Database.Database, opts: FinishRunOptions): Run {
  const status = opts.exitCode === 0 ? "completed" : "failed";
  const usage = opts.tokenUsage;
  // The attempt outcome is written in the same statement that closes the run, so
  // a run is never observed finished-but-unlabelled (FR-033).
  db.prepare(`
    UPDATE runs
    SET finished_at = datetime('now'),
        exit_code = @exit_code,
        termination_reason = @termination_reason,
        token_input = @token_input,
        token_output = @token_output,
        token_reasoning = @token_reasoning,
        token_cache_read = @token_cache_read,
        token_cache_write = @token_cache_write,
        token_fresh = @token_fresh,
        token_total = @token_total,
        status = @status,
        files_written_count  = COALESCE(@files_written_count,  files_written_count),
        files_written_source = COALESCE(@files_written_source, files_written_source),
        status_from          = COALESCE(@status_from,          status_from),
        status_to            = COALESCE(@status_to,            status_to),
        budget_consumed      = COALESCE(@budget_consumed,      budget_consumed),
        cleanup_outcome      = COALESCE(@cleanup_outcome,      cleanup_outcome),
        survivor_pids        = COALESCE(@survivor_pids,        survivor_pids),
        outcome_label        = COALESCE(@outcome_label,        outcome_label)
    WHERE run_id = @run_id
  `).run({
    run_id: opts.runId,
    exit_code: opts.exitCode,
    termination_reason: opts.reason ?? null,
    token_input: usage?.input ?? 0,
    token_output: usage?.output ?? 0,
    token_reasoning: usage?.reasoning ?? 0,
    token_cache_read: usage?.cacheRead ?? 0,
    token_cache_write: usage?.cacheWrite ?? 0,
    token_fresh: usage?.fresh ?? 0,
    token_total: usage?.total ?? 0,
    status,
    files_written_count: opts.filesWrittenCount ?? null,
    files_written_source: opts.filesWrittenSource ?? null,
    status_from: opts.statusFrom ?? null,
    status_to: opts.statusTo ?? null,
    budget_consumed: normalizeBudgetConsumed(opts.budgetConsumed),
    cleanup_outcome: opts.cleanupOutcome ?? null,
    survivor_pids: opts.survivorPids == null ? null : JSON.stringify(opts.survivorPids),
    outcome_label: opts.outcomeLabel ?? null,
  });

  return db.prepare(`SELECT * FROM runs WHERE run_id = ?`).get(opts.runId) as Run;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
    return code !== "ESRCH";
  }
}

export function reapDeadRuns(db: Database.Database, agent?: string): Run[] {
  const rows = (agent
    ? db.prepare(`
        SELECT *,
          CAST((julianday('now') - julianday(started_at)) * 1440 AS INTEGER) AS age_minutes
        FROM runs
        WHERE status = 'running' AND agent = ?
      `).all(agent)
    : db.prepare(`
        SELECT *,
          CAST((julianday('now') - julianday(started_at)) * 1440 AS INTEGER) AS age_minutes
        FROM runs
        WHERE status = 'running'
      `).all()) as Array<Run & { age_minutes: number }>;

  const reaped: Run[] = [];
  for (const row of rows) {
    if (row.pid != null && !isProcessAlive(row.pid)) {
      reaped.push(finishRun(db, {
        runId: row.run_id,
        exitCode: 1,
        reason: `reaped after pid ${row.pid} disappeared`,
      }));
      continue;
    }
    if (row.pid == null && row.age_minutes >= STALE_RUN_MINUTES) {
      reaped.push(finishRun(db, {
        runId: row.run_id,
        exitCode: 1,
        reason: `reaped after ${row.age_minutes} minutes without a live pid`,
      }));
    }
  }

  if (reaped.length > 0) {
    for (const run of reaped) {
      db.prepare(`
        INSERT INTO events (event_id, artifact_id, type, agent, summary, event_data)
        SELECT
          lower(hex(randomblob(8))),
          c.artifact_id,
          'run-reaped',
          @agent,
          @summary,
          @event_data
        FROM artifact_claims c
        WHERE c.run_id = @run_id
      `).run({
        agent: "guildctl",
        run_id: run.run_id,
        summary: `Reaped ${run.agent} run ${run.run_id}`,
        event_data: JSON.stringify({
          run_id: run.run_id,
          owner_id: run.owner_id,
          termination_reason: run.termination_reason,
        }),
      });
    }
    reconcileStaleClaims(db, "guildctl");
  }

  return reaped;
}

export function listRuns(
  db: Database.Database,
  agent?: string,
  limit = 20,
): Run[] {
  reapDeadRuns(db, agent);
  if (agent) {
    return db.prepare(
      `SELECT * FROM runs WHERE agent = ? ORDER BY started_at DESC LIMIT ?`
    ).all(agent, limit) as Run[];
  }
  return db.prepare(
    `SELECT * FROM runs ORDER BY started_at DESC LIMIT ?`
  ).all(limit) as Run[];
}
