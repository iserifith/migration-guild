import type Database from "better-sqlite3";

export interface Run {
  run_id: string;
  agent: string;
  model: string | null;
  prompt: string | null;
  log_file: string | null;
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
}

export interface FinishRunOptions {
  runId: string;
  exitCode: number;
}

export function startRun(db: Database.Database, opts: StartRunOptions): Run {
  db.prepare(`
    INSERT INTO runs (agent, model, prompt, log_file)
    VALUES (@agent, @model, @prompt, @log_file)
  `).run({
    agent: opts.agent,
    model: opts.model ?? null,
    prompt: opts.prompt ?? null,
    log_file: opts.logFile ?? null,
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

export function listRuns(
  db: Database.Database,
  agent?: string,
  limit = 20,
): Run[] {
  if (agent) {
    return db.prepare(
      `SELECT * FROM runs WHERE agent = ? ORDER BY started_at DESC LIMIT ?`
    ).all(agent, limit) as Run[];
  }
  return db.prepare(
    `SELECT * FROM runs ORDER BY started_at DESC LIMIT ?`
  ).all(limit) as Run[];
}
