import fs from "node:fs";
import path from "node:path";
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
  workspaceRoot?: string;
  /**
   * Overrides the resolved periodic-sweep interval (ms). Primarily for tests;
   * operators tune this via `GUILDCTL_SWEEP_INTERVAL_MINS` instead.
   */
  sweepIntervalMs?: number;
  /** Injectable clock for the periodic sweep; defaults to `Date.now`. Primarily for tests. */
  now?: () => number;
  /**
   * Sink for operator-facing periodic-sweep output; defaults to
   * `process.stdout.write`. Mirrors `AutoRunCommandDependencies.write`.
   */
  write?: (text: string) => void;
}

/** Default periodic-sweep interval, in minutes, when `GUILDCTL_SWEEP_INTERVAL_MINS` is unset or invalid. */
const DEFAULT_SWEEP_INTERVAL_MINUTES = 10;

/**
 * Resolves the periodic staleness-sweep interval from the
 * `GUILDCTL_SWEEP_INTERVAL_MINS` environment variable, mirroring the
 * `STALL_MINUTES` parsing pattern in `migration/guildctl/monitoring.ts`.
 * Falls back to the 10-minute default whenever the parsed value is not a
 * finite positive number (unset, empty, `"0"`, negative, or non-numeric).
 */
export function resolveSweepIntervalMs(envValue: string | undefined): number {
  const parsed = parseInt(envValue ?? String(DEFAULT_SWEEP_INTERVAL_MINUTES), 10);
  const minutes = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SWEEP_INTERVAL_MINUTES;
  return minutes * 60_000;
}

const SWEEP_LINE_PREFIX = "[guildctl]";

/** Formats one periodic-sweep console line (contract §4) — omitted entirely on a clean sweep. */
function formatPeriodicSweepLine(reapedRunIds: string[], reconciledArtifactIds: string[]): string {
  const parts: string[] = [];
  if (reapedRunIds.length > 0) parts.push(`reaped run(s) ${reapedRunIds.join(", ")}`);
  if (reconciledArtifactIds.length > 0) parts.push(`recovered artifact(s) ${reconciledArtifactIds.join(", ")}`);
  return `${SWEEP_LINE_PREFIX} periodic sweep: ${parts.join("; ")}\n`;
}

function formatPeriodicSweepErrorLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${SWEEP_LINE_PREFIX} periodic sweep failed (non-fatal, will retry next interval): ${message}\n`;
}

export interface AutoQueueRemaining {
  planned: number;
  migrated: number;
  inProgress: number;
  needsRework: number;
  blocked: number;
  // US1 (spec 013, T010): count of artifacts held at `pending-approval`,
  // reported distinctly from `blocked` per FR-005. Additive; default 0.
  heldForApproval: number;
}

export interface AutoQueueResult {
  status: "complete" | "partial" | "stalled" | "limited" | "failed" | "cancelled";
  completed: number;
  blocked: number;
  processed: Array<{
    artifactId: string;
    resume: boolean;
    status: AutoResult["status"];
    runId: string | null;
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

function deriveModernPath(legacyPath: string): string | null {
  const modernPath = legacyPath.replace(/(^|\/)legacy\//, "$1modern/");
  return modernPath === legacyPath ? null : modernPath;
}

function terminalDepsMissingOutput(
  db: Database.Database,
  artifactId: string,
  workspaceRoot: string,
): boolean {
  const terminal = DEPENDENCY_TERMINAL_STATUSES.map(() => "?").join(", ");
  const rows = db.prepare(`
    SELECT dep.path
    FROM dependencies d
    JOIN artifacts dep ON dep.id = d.depends_on_id
    WHERE d.artifact_id = ?
      AND dep.tier = 'first-class'
      AND dep.status IN (${terminal})
    UNION
    SELECT dep.path
    FROM source_dependencies sd
    JOIN artifacts dep ON dep.id = sd.dependency_id
    WHERE sd.dependent_id = ?
      AND dep.tier = 'first-class'
      AND dep.status IN (${terminal})
  `).all(
    artifactId,
    ...DEPENDENCY_TERMINAL_STATUSES,
    artifactId,
    ...DEPENDENCY_TERMINAL_STATUSES,
  ) as Array<{ path: string }>;

  for (const row of rows) {
    const modernPath = deriveModernPath(row.path);
    if (modernPath == null) continue;
    if (!fs.existsSync(path.join(workspaceRoot, modernPath))) return true;
  }
  return false;
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
      AND NOT EXISTS (
        SELECT 1
        FROM source_dependencies sd
        JOIN artifacts dep ON dep.id = sd.dependency_id
        WHERE sd.dependent_id = a.id
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
      SUM(CASE WHEN a.status = 'blocked' THEN 1 ELSE 0 END) AS blocked,
      SUM(CASE WHEN a.status = 'pending-approval' THEN 1 ELSE 0 END) AS held_for_approval
    FROM artifacts a
    WHERE a.tier = 'first-class'
      ${waveClause}
  `).get(...(wave == null ? [] : [wave])) as {
    planned: number | null;
    migrated: number | null;
    in_progress: number | null;
    needs_rework: number | null;
    blocked: number | null;
    held_for_approval: number | null;
  };
  return {
    planned: row.planned ?? 0,
    migrated: row.migrated ?? 0,
    inProgress: row.in_progress ?? 0,
    needsRework: row.needs_rework ?? 0,
    blocked: row.blocked ?? 0,
    heldForApproval: row.held_for_approval ?? 0,
  };
}

function dependencyBlockedIds(db: Database.Database, wave?: number): string[] {
  const waveClause = scopeClause("a", wave);
  const terminal = DEPENDENCY_TERMINAL_STATUSES.map(() => "?").join(", ");
  const params = [
    ...(wave == null ? [] : [wave]),
    ...DEPENDENCY_TERMINAL_STATUSES,
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
    UNION
    SELECT a.id
    FROM artifacts a
    WHERE a.tier = 'first-class'
      AND a.status = 'planned'
      ${waveClause}
      AND EXISTS (
        SELECT 1
        FROM source_dependencies sd
        JOIN artifacts dep ON dep.id = sd.dependency_id
        WHERE sd.dependent_id = a.id
          AND dep.tier = 'first-class'
          AND dep.status NOT IN (${terminal})
      )
    ORDER BY id
  `).all(...params) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

function terminalStatus(
  remaining: AutoQueueRemaining,
  hasMissingDependencyOutput: boolean,
): AutoQueueResult["status"] {
  if (remaining.blocked > 0 || remaining.needsRework > 0 || remaining.heldForApproval > 0 || hasMissingDependencyOutput) return "partial";
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

  const now = opts.now ?? Date.now;
  const write = opts.write ?? ((text: string) => { process.stdout.write(text); });
  const sweepIntervalMs = opts.sweepIntervalMs
    ?? resolveSweepIntervalMs(process.env["GUILDCTL_SWEEP_INTERVAL_MINS"]);

  reapDeadRuns(db);
  const recoveredArtifacts = reconcileStaleClaims(db, "guildctl-auto-run").map((artifact) => artifact.id);
  const recoveredArtifactIds = new Set(recoveredArtifacts);
  let lastSweepAt = now();
  const processedIds = new Set<string>();
  const outputBlockedIds = new Set<string>();
  const processed: AutoQueueResult["processed"] = [];
  let completed = 0;

  while (opts.limit == null || processed.length < opts.limit) {
    if (now() - lastSweepAt >= sweepIntervalMs) {
      // Sweep at loop-iteration boundaries only — never concurrently with an
      // in-flight `executeArtifact` call (research.md "Sweep trigger mechanism").
      lastSweepAt = now();
      try {
        const reapedRuns = reapDeadRuns(db);
        const reconciled = reconcileStaleClaims(db, "guildctl-auto-run");
        const reconciledArtifactIds = reconciled.map((artifact) => artifact.id);
        for (const id of reconciledArtifactIds) {
          if (!recoveredArtifactIds.has(id)) {
            recoveredArtifactIds.add(id);
            recoveredArtifacts.push(id);
          }
        }
        const reapedRunIds = reapedRuns.map((run) => run.run_id);
        if (reapedRunIds.length > 0 || reconciledArtifactIds.length > 0) {
          write(formatPeriodicSweepLine(reapedRunIds, reconciledArtifactIds));
        }
      } catch (error) {
        // FR-007 / Constitution VI: never abort the queue over a sweep failure.
        write(formatPeriodicSweepErrorLine(error));
      }
    }

    const candidate = selectCandidate(db, opts, processedIds);
    if (!candidate) break;
    if (opts.workspaceRoot && terminalDepsMissingOutput(db, candidate.id, opts.workspaceRoot)) {
      processedIds.add(candidate.id);
      outputBlockedIds.add(candidate.id);
      continue;
    }
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
          dependencyBlocked: [...new Set([...dependencyBlockedIds(db, opts.wave), ...outputBlockedIds])].sort(),
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
        dependencyBlocked: [...new Set([...dependencyBlockedIds(db, opts.wave), ...outputBlockedIds])].sort(),
        remaining,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const remaining = remainingCounts(db, opts.wave);
  const dependencyBlocked = [...new Set([
    ...dependencyBlockedIds(db, opts.wave),
    ...outputBlockedIds,
  ])].sort();
  const limited = opts.limit != null && processed.length >= opts.limit &&
    (remaining.planned > 0 || (opts.resume !== false && remaining.migrated > 0));
  return {
    status: limited ? "limited" : terminalStatus(remaining, outputBlockedIds.size > 0),
    completed,
    blocked: remaining.blocked + remaining.needsRework,
    processed,
    recoveredArtifacts,
    dependencyBlocked,
    remaining,
  };
}
