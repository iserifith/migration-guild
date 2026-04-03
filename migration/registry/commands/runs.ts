import type Database from "better-sqlite3";

const STALE_RUN_MINUTES = Math.max(1, parseInt(process.env["LEGMOD_STALE_RUN_MINS"] ?? "30", 10));

export interface Run {
  run_id: string;
  agent: string;
  model: string | null;
  prompt: string | null;
  log_file: string | null;
  pid: number | null;
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  status: "running" | "completed" | "failed";
}

export interface StartRunOptions {
  agent: string;
  model?: string;
  prompt?: string;
  logFile?: string;
  pid?: number | null;
}

export interface FinishRunOptions {
  runId: string;
  exitCode: number;
}

export function startRun(db: Database.Database, opts: StartRunOptions): Run {
  db.prepare(`
    INSERT INTO runs (agent, model, prompt, log_file, pid)
    VALUES (@agent, @model, @prompt, @log_file, @pid)
  `).run({
    agent: opts.agent,
    model: opts.model ?? null,
    prompt: opts.prompt ?? null,
    log_file: opts.logFile ?? null,
    pid: opts.pid ?? null,
  });

  return db.prepare(`SELECT * FROM runs WHERE rowid = last_insert_rowid()`).get() as Run;
}

export function finishRun(db: Database.Database, opts: FinishRunOptions): Run {
  const status = opts.exitCode === 0 ? "completed" : "failed";
  db.prepare(`
    UPDATE runs
    SET finished_at = datetime('now'), exit_code = @exit_code, status = @status
    WHERE run_id = @run_id
  `).run({ run_id: opts.runId, exit_code: opts.exitCode, status });

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
      `).all()) as Run[];

  const reaped: Run[] = [];
  for (const row of rows as Array<Run & { age_minutes: number }>) {
    if (row.pid != null && !isProcessAlive(row.pid)) {
      reaped.push(finishRun(db, { runId: row.run_id, exitCode: 1 }));
      continue;
    }
    if (row.pid == null && row.age_minutes >= STALE_RUN_MINUTES) {
      reaped.push(finishRun(db, { runId: row.run_id, exitCode: 1 }));
    }
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
