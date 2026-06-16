import type Database from "better-sqlite3";
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
  status: "running" | "completed" | "failed";
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

export interface FinishRunOptions {
  runId: string;
  exitCode: number;
  reason?: string;
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

export function finishRun(db: Database.Database, opts: FinishRunOptions): Run {
  const status = opts.exitCode === 0 ? "completed" : "failed";
  db.prepare(`
    UPDATE runs
    SET finished_at = datetime('now'),
        exit_code = @exit_code,
        termination_reason = @termination_reason,
        status = @status
    WHERE run_id = @run_id
  `).run({
    run_id: opts.runId,
    exit_code: opts.exitCode,
    termination_reason: opts.reason ?? null,
    status,
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
