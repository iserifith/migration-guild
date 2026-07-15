import type Database from "better-sqlite3";
import { reconcileStaleClaims } from "../../registry/commands/claim";
import { reapDeadRuns } from "../../registry/commands/runs";
import type { AutoResult } from "./loop";

const DEPENDENCY_TERMINAL_STATUSES = ["reviewed", "completed", "skipped"] as const;

export interface QueueArtifactInput {
  artifactId: string;
  resume: boolean;
}

export type QueueArtifactExecutor = (input: QueueArtifactInput) => Promise<AutoResult>;

export interface AutoQueueOptions {
  executeArtifact: QueueArtifactExecutor;
  wave?: number;
  limit?: number;
  resume?: boolean;
}

export interface AutoQueueRemaining {
  planned: number;
  migrated: number;
  inProgress: number;
  needsRework: number;
  blocked: number;
}

export interface AutoQueueResult {
  status: "complete" | "partial" | "stalled" | "limited" | "failed" | "cancelled";
  completed: number;
  blocked: number;
  processed: Array<{
    artifactId: string;
    resume: boolean;
    status: AutoResult["status"];
    runId: string;
    attempts: number;
  }>;
  recoveredArtifacts: string[];
  dependencyBlocked: string[];
  remaining: AutoQueueRemaining;
  error?: string;
}

interface Candidate {
  id: string;
  status: "planned" | "migrated";
}

function scopeClause(alias: string, wave: number | undefined): string {
  return wave == null ? "" : `AND ${alias}.wave = ?`;
}

function selectCandidate(
  db: Database.Database,
  opts: AutoQueueOptions,
  processed: Set<string>,
): Candidate | undefined {
  const statuses = opts.resume === false ? ["planned"] : ["migrated", "planned"];
  const placeholders = statuses.map(() => "?").join(", ");
  const processedIds = [...processed];
  const processedClause = processedIds.length > 0
    ? `AND a.id NOT IN (${processedIds.map(() => "?").join(", ")})`
    : "";
  const waveClause = scopeClause("a", opts.wave);
  const terminal = DEPENDENCY_TERMINAL_STATUSES.map(() => "?").join(", ");
  const params = [
    ...statuses,
    ...(opts.wave == null ? [] : [opts.wave]),
    ...processedIds,
    ...DEPENDENCY_TERMINAL_STATUSES,
  ];

  return db.prepare(`
    SELECT a.id, a.status
    FROM artifacts a
    WHERE a.tier = 'first-class'
      AND a.status IN (${placeholders})
      ${waveClause}
      ${processedClause}
      AND NOT EXISTS (
        SELECT 1
        FROM dependencies d
        JOIN artifacts dep ON dep.id = d.depends_on_id
        WHERE d.artifact_id = a.id
          AND dep.tier = 'first-class'
          AND dep.status NOT IN (${terminal})
      )
    ORDER BY
      CASE a.status WHEN 'migrated' THEN 0 ELSE 1 END,
      COALESCE(a.wave, 2147483647),
      a.created_at,
      a.id
    LIMIT 1
  `).get(...params) as Candidate | undefined;
}

function remainingCounts(db: Database.Database, wave?: number): AutoQueueRemaining {
  const waveClause = scopeClause("a", wave);
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN a.status = 'planned' THEN 1 ELSE 0 END) AS planned,
      SUM(CASE WHEN a.status = 'migrated' THEN 1 ELSE 0 END) AS migrated,
      SUM(CASE WHEN a.status = 'in-progress' THEN 1 ELSE 0 END) AS in_progress,
      SUM(CASE WHEN a.status = 'needs-rework' THEN 1 ELSE 0 END) AS needs_rework,
      SUM(CASE WHEN a.status = 'blocked' THEN 1 ELSE 0 END) AS blocked
    FROM artifacts a
    WHERE a.tier = 'first-class'
      ${waveClause}
  `).get(...(wave == null ? [] : [wave])) as {
    planned: number | null;
    migrated: number | null;
    in_progress: number | null;
    needs_rework: number | null;
    blocked: number | null;
  };
  return {
    planned: row.planned ?? 0,
    migrated: row.migrated ?? 0,
    inProgress: row.in_progress ?? 0,
    needsRework: row.needs_rework ?? 0,
    blocked: row.blocked ?? 0,
  };
}

function dependencyBlockedIds(db: Database.Database, wave?: number): string[] {
  const waveClause = scopeClause("a", wave);
  const terminal = DEPENDENCY_TERMINAL_STATUSES.map(() => "?").join(", ");
  const params = [
    ...(wave == null ? [] : [wave]),
    ...DEPENDENCY_TERMINAL_STATUSES,
  ];
  const rows = db.prepare(`
    SELECT a.id
    FROM artifacts a
    WHERE a.tier = 'first-class'
      AND a.status = 'planned'
      ${waveClause}
      AND EXISTS (
        SELECT 1
        FROM dependencies d
        JOIN artifacts dep ON dep.id = d.depends_on_id
        WHERE d.artifact_id = a.id
          AND dep.tier = 'first-class'
          AND dep.status NOT IN (${terminal})
      )
    ORDER BY COALESCE(a.wave, 2147483647), a.created_at, a.id
  `).all(...params) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

function terminalStatus(remaining: AutoQueueRemaining): AutoQueueResult["status"] {
  if (remaining.blocked > 0 || remaining.needsRework > 0) return "partial";
  if (remaining.planned > 0 || remaining.migrated > 0 || remaining.inProgress > 0) return "stalled";
  return "complete";
}

export async function runAutoQueue(
  db: Database.Database,
  opts: AutoQueueOptions,
): Promise<AutoQueueResult> {
  if (opts.limit != null && (!Number.isInteger(opts.limit) || opts.limit < 1)) {
    throw new Error("auto queue limit must be a positive integer");
  }

  reapDeadRuns(db);
  const recoveredArtifacts = reconcileStaleClaims(db, "guildctl-auto-run").map((artifact) => artifact.id);
  const processedIds = new Set<string>();
  const processed: AutoQueueResult["processed"] = [];
  let completed = 0;

  while (opts.limit == null || processed.length < opts.limit) {
    const candidate = selectCandidate(db, opts, processedIds);
    if (!candidate) break;
    processedIds.add(candidate.id);
    const resume = candidate.status === "migrated";
    try {
      const result = await opts.executeArtifact({ artifactId: candidate.id, resume });
      processed.push({
        artifactId: candidate.id,
        resume,
        status: result.status,
        runId: result.runId,
        attempts: result.attempts,
      });
      if (result.status === "complete") completed += 1;
      if (result.status === "cancelled") {
        const remaining = remainingCounts(db, opts.wave);
        return {
          status: "cancelled",
          completed,
          blocked: remaining.blocked + remaining.needsRework,
          processed,
          recoveredArtifacts,
          dependencyBlocked: dependencyBlockedIds(db, opts.wave),
          remaining,
        };
      }
    } catch (error) {
      const remaining = remainingCounts(db, opts.wave);
      return {
        status: "failed",
        completed,
        blocked: remaining.blocked + remaining.needsRework,
        processed,
        recoveredArtifacts,
        dependencyBlocked: dependencyBlockedIds(db, opts.wave),
        remaining,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const remaining = remainingCounts(db, opts.wave);
  const dependencyBlocked = dependencyBlockedIds(db, opts.wave);
  const limited = opts.limit != null && processed.length >= opts.limit &&
    (remaining.planned > 0 || (opts.resume !== false && remaining.migrated > 0));
  return {
    status: limited ? "limited" : terminalStatus(remaining),
    completed,
    blocked: remaining.blocked + remaining.needsRework,
    processed,
    recoveredArtifacts,
    dependencyBlocked,
    remaining,
  };
}
