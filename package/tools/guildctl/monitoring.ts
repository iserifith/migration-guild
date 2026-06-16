import * as fs from "fs";
import * as path from "path";
import type Database from "better-sqlite3";
import type { PhaseKey } from "../foundry/config";
import type { AgentRunResult } from "./runner";

const R = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";

export const STALL_MINUTES = parseInt(process.env["GUILDCTL_STALL_MINS"] ?? "10", 10);

export type StatusCounts = Record<string, number>;

interface ClaimabilityStats {
  total: number;
  ready: number;
  blocked: number;
  inProgress: number;
}

interface LogSignals {
  rateLimited: number;
  transientRetries: number;
  serverInterrupts: number;
  provider404s: number;
  authFailures: number;
}

interface RunIssue {
  agent: string;
  summary: string;
  logFile: string | null;
  exitCode: number;
}

const TERMINAL_DEP_STATUSES = "'migrated', 'reviewed', 'completed', 'skipped'";

export function printResolvedRuntime(opts: {
  phase: PhaseKey;
  provider: string;
  model: string;
  configPath: string;
  batchEnabled?: boolean;
  providerType?: string;
  endpoint?: string;
}): void {
  const configPath = path.relative(process.cwd(), opts.configPath) || opts.configPath;
  const batch = opts.batchEnabled == null ? "n/a" : opts.batchEnabled ? "on" : "off";
  const endpoint = opts.endpoint ? `  endpoint: ${opts.endpoint}` : "";
  const providerType = opts.providerType ? `  provider-type: ${opts.providerType}` : "";
  console.log(`  Runtime: phase=${opts.phase}  provider=${opts.provider}  model=${opts.model}  batch=${batch}`);
  console.log(`  Config: ${configPath}${providerType}${endpoint}`);
}

export function getStatusCounts(db: Database.Database, wave?: number): StatusCounts {
  const waveClause = wave != null ? "AND wave = @wave" : "";
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM artifacts
    WHERE tier = 'first-class' ${waveClause}
    GROUP BY status
  `).all({ wave: wave ?? null }) as Array<{ status: string; count: number }>;

  const counts: StatusCounts = {};
  for (const row of rows) counts[row.status] = row.count;
  return counts;
}

export function getClaimabilityStats(
  db: Database.Database,
  fromStatus: string,
  wave?: number,
): ClaimabilityStats {
  const params: Record<string, string | number> = { fromStatus };
  const waveClause = wave != null ? "AND a.wave = @wave" : "";
  if (wave != null) params["wave"] = wave;

  const total = db.prepare(`
    SELECT COUNT(*) AS count
    FROM artifacts a
    WHERE a.tier = 'first-class'
      AND a.status = @fromStatus
      ${waveClause}
  `).get(params) as { count: number };

  const ready = db.prepare(`
    SELECT COUNT(*) AS count
    FROM artifacts a
    WHERE a.tier = 'first-class'
      AND a.status = @fromStatus
      ${waveClause}
      AND NOT EXISTS (
        SELECT 1
        FROM dependencies d
        JOIN artifacts dep ON dep.id = d.depends_on_id
        WHERE d.artifact_id = a.id
          AND dep.tier = 'first-class'
          AND dep.status NOT IN (${TERMINAL_DEP_STATUSES})
      )
  `).get(params) as { count: number };

  const blocked = db.prepare(`
    SELECT COUNT(*) AS count
    FROM artifacts a
    WHERE a.tier = 'first-class'
      AND a.status = @fromStatus
      ${waveClause}
      AND EXISTS (
        SELECT 1
        FROM dependencies d
        JOIN artifacts dep ON dep.id = d.depends_on_id
        WHERE d.artifact_id = a.id
          AND dep.tier = 'first-class'
          AND dep.status NOT IN (${TERMINAL_DEP_STATUSES})
      )
  `).get(params) as { count: number };

  const inProgress = db.prepare(`
    SELECT COUNT(*) AS count
    FROM artifacts a
    WHERE a.tier = 'first-class'
      AND a.status = 'in-progress'
      ${waveClause}
  `).get(wave != null ? { wave } : {}) as { count: number };

  return {
    total: total.count,
    ready: ready.count,
    blocked: blocked.count,
    inProgress: inProgress.count,
  };
}

export function printQueueSnapshot(label: string, stats: ClaimabilityStats): void {
  console.log(`  ${label}: ready=${stats.ready}  blocked=${stats.blocked}  queued=${stats.total}  in-progress=${stats.inProgress}`);
}

function analyzeLogFile(logFile: string | null): { signals: LogSignals; summary: string | null; noWork: boolean } {
  const emptySignals: LogSignals = {
    rateLimited: 0,
    transientRetries: 0,
    serverInterrupts: 0,
    provider404s: 0,
    authFailures: 0,
  };
  if (!logFile || !fs.existsSync(logFile)) {
    return { signals: emptySignals, summary: null, noWork: false };
  }

  const text = fs.readFileSync(logFile, "utf-8");
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const summaryPatterns = [
    /429 Too Many Requests/i,
    /Failed to get response from the AI model/i,
    /Request failed due to a transient API error/i,
    /Response was interrupted due to a server error/i,
    /Model '.+' not found on provider/i,
    /HTTP 404/i,
    /\bUnauthorized\b/i,
    /\bForbidden\b/i,
    /No claimable tasks/i,
    /All tasks complete/i,
    /Nothing planned or in-progress remains/i,
    /Check that the model is available on your provider/i,
  ];

  const summary = [...lines].reverse().find((line) => summaryPatterns.some((re) => re.test(line))) ?? null;
  const noWork = /No claimable tasks|All tasks complete|Nothing planned or in-progress remains/i.test(text);

  return {
    signals: {
      rateLimited: (text.match(/429 Too Many Requests/gi) ?? []).length,
      transientRetries: (text.match(/Request failed due to a transient API error|Failed to get response from the AI model/gi) ?? []).length,
      serverInterrupts: (text.match(/Response was interrupted due to a server error/gi) ?? []).length,
      provider404s: (text.match(/HTTP 404|Model '.+' not found on provider/gi) ?? []).length,
      authFailures: (text.match(/\bUnauthorized\b|\bForbidden\b|HTTP 401|HTTP 403/gi) ?? []).length,
    },
    summary,
    noWork,
  };
}

function aggregateSignals(results: AgentRunResult[]): LogSignals {
  return results.reduce<LogSignals>((acc, result) => {
    const { signals } = analyzeLogFile(result.logFile ?? null);
    acc.rateLimited += signals.rateLimited;
    acc.transientRetries += signals.transientRetries;
    acc.serverInterrupts += signals.serverInterrupts;
    acc.provider404s += signals.provider404s;
    acc.authFailures += signals.authFailures;
    return acc;
  }, {
    rateLimited: 0,
    transientRetries: 0,
    serverInterrupts: 0,
    provider404s: 0,
    authFailures: 0,
  });
}

function collectRunIssues(results: AgentRunResult[]): RunIssue[] {
  return results.flatMap((result) => {
    const analysis = analyzeLogFile(result.logFile ?? null);
    if (result.exitCode === 0 && !analysis.summary) return [];
    const relativeLog = result.logFile ? path.relative(process.cwd(), result.logFile) || result.logFile : null;
    return [{
      agent: result.agent,
      summary: analysis.summary ?? `Exited with code ${result.exitCode}`,
      logFile: relativeLog,
      exitCode: result.exitCode,
    }];
  });
}

export function printPoolSummary(opts: {
  label: string;
  results: AgentRunResult[];
  before: StatusCounts;
  after: StatusCounts;
  advancedStatus?: string;
  claimability?: ClaimabilityStats;
}): void {
  const succeeded = opts.results.filter((result) => result.exitCode === 0).length;
  const failed = opts.results.length - succeeded;
  const advanced = opts.advancedStatus
    ? Math.max(0, (opts.after[opts.advancedStatus] ?? 0) - (opts.before[opts.advancedStatus] ?? 0))
    : 0;
  const signals = aggregateSignals(opts.results);
  const issues = collectRunIssues(opts.results);

  console.log(`\n${BOLD}${opts.label} summary${R}`);
  console.log(`  Sessions: started=${opts.results.length}  succeeded=${succeeded}  failed=${failed}`);
  if (opts.advancedStatus) {
    console.log(`  Artifacts advanced to ${opts.advancedStatus}: ${advanced > 0 ? `${GREEN}+${advanced}${R}` : `${YELLOW}0${R}`}`);
  }

  if (signals.rateLimited || signals.transientRetries || signals.serverInterrupts || signals.provider404s || signals.authFailures) {
    const parts: string[] = [];
    if (signals.rateLimited) parts.push(`429=${signals.rateLimited}`);
    if (signals.transientRetries) parts.push(`transient=${signals.transientRetries}`);
    if (signals.serverInterrupts) parts.push(`interrupts=${signals.serverInterrupts}`);
    if (signals.provider404s) parts.push(`404=${signals.provider404s}`);
    if (signals.authFailures) parts.push(`auth=${signals.authFailures}`);
    console.log(`  API pressure: ${YELLOW}${parts.join("  ")}${R}`);
  }

  if (issues.length > 0) {
    console.log("  Run issues:");
    for (const issue of issues.slice(0, 5)) {
      const exitNote = issue.exitCode !== 0 ? `exit=${issue.exitCode}  ` : "";
      const logNote = issue.logFile ? `  log=${issue.logFile}` : "";
      console.log(`    ${RED}•${R} ${issue.agent}  ${exitNote}${issue.summary}${logNote}`);
    }
    if (issues.length > 5) {
      console.log(`    ${DIM}... ${issues.length - 5} more run issue(s) omitted${R}`);
    }
  }

  if (advanced === 0 && opts.claimability) {
    console.log(
      `  No new artifacts advanced. Ready=${opts.claimability.ready}  blocked=${opts.claimability.blocked}  queued=${opts.claimability.total}  in-progress=${opts.claimability.inProgress}`
    );
  }
}

export function printCompletionReason(
  label: string,
  counts: StatusCounts,
  terminalStatuses: string[] = ["reviewed", "completed", "skipped"],
): void {
  const remaining = Object.entries(counts)
    .filter(([status, count]) => count > 0 && !terminalStatuses.includes(status))
    .sort(([a], [b]) => a.localeCompare(b));
  if (remaining.length === 0) {
    const terminal = terminalStatuses.reduce((sum, status) => sum + (counts[status] ?? 0), 0);
    console.log(`  ${label}: all first-class artifacts reached terminal states (${terminal}).`);
    return;
  }
  const details = remaining.map(([status, count]) => `${status}=${count}`).join("  ");
  console.log(`  ${label}: remaining first-class artifacts -> ${details}`);
}

export function printMigrationScopeSummary(
  db: Database.Database,
  wave?: number,
): void {
  const waveClause = wave != null ? "AND wave = @wave" : "";
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status IN ('migrated','reviewed','completed','skipped') THEN 1 ELSE 0 END) AS done,
      SUM(CASE WHEN status = 'planned' THEN 1 ELSE 0 END) AS planned,
      SUM(CASE WHEN status = 'analyzed' THEN 1 ELSE 0 END) AS analyzed,
      SUM(CASE WHEN status = 'tests-written' THEN 1 ELSE 0 END) AS tests_written,
      SUM(CASE WHEN status = 'in-progress' THEN 1 ELSE 0 END) AS in_progress,
      SUM(CASE WHEN status = 'needs-rework' THEN 1 ELSE 0 END) AS needs_rework,
      SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked
    FROM artifacts
    WHERE tier = 'first-class'
      ${waveClause}
  `).get({ wave: wave ?? null }) as {
    total: number;
    done: number;
    planned: number;
    analyzed: number;
    tests_written: number;
    in_progress: number;
    needs_rework: number;
    blocked: number;
  };

  const scope = wave != null ? `Wave ${wave}` : "All waves";
  const total = row.total ?? 0;
  const done = row.done ?? 0;
  const remaining = Math.max(0, total - done);
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  console.log(`\n${BOLD}Migration Summary (${scope})${R}`);
  console.log(`  Progress: ${GREEN}${done}${R}/${total} (${pct}%)`);
  console.log(
    `  Remaining: ${remaining}  planned=${row.planned ?? 0}  analyzed=${row.analyzed ?? 0}  tests-written=${row.tests_written ?? 0}  in-progress=${row.in_progress ?? 0}`,
  );

  if ((row.needs_rework ?? 0) > 0 || (row.blocked ?? 0) > 0) {
    console.log(`  Attention: needs-rework=${row.needs_rework ?? 0}  blocked=${row.blocked ?? 0}`);
  }
}

export function printInventoryClassificationSummary(db: Database.Database): void {
  const counts = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN role IS NOT NULL OR framework IS NOT NULL THEN 1 ELSE 0 END) AS classified,
      SUM(CASE WHEN role IS NULL AND framework IS NULL THEN 1 ELSE 0 END) AS unclassified
    FROM artifacts
    WHERE tier = 'first-class'
  `).get() as { total: number; classified: number; unclassified: number };

  const byRole = db.prepare(`
    SELECT COALESCE(role, '(none)') AS role, COUNT(*) AS count
    FROM artifacts
    WHERE tier = 'first-class'
    GROUP BY role
    ORDER BY count DESC, role ASC
  `).all() as Array<{ role: string; count: number }>;

  const byFramework = db.prepare(`
    SELECT COALESCE(framework, '(none)') AS framework, COUNT(*) AS count
    FROM artifacts
    WHERE tier = 'first-class'
    GROUP BY framework
    ORDER BY count DESC, framework ASC
  `).all() as Array<{ framework: string; count: number }>;

  console.log(`\n${BOLD}Classification Summary${R}`);
  console.log(`  Registered: ${counts.total}  Classified: ${counts.classified}  Unclassified: ${counts.unclassified}`);
  if (byRole.length > 0) {
    const roles = byRole.slice(0, 6).map((row) => `${row.role}=${row.count}`).join("  ");
    console.log(`  Roles: ${roles}`);
  }
  if (byFramework.length > 0) {
    const frameworks = byFramework.slice(0, 6).map((row) => `${row.framework}=${row.count}`).join("  ");
    console.log(`  Frameworks: ${frameworks}`);
  }
}

export function printStaleSessionWarnings(db: Database.Database): void {
  const rows = db.prepare(`
    SELECT id, path, claimed_by,
      CAST((julianday('now') - julianday(claimed_at)) * 1440 AS INTEGER) AS age_minutes
    FROM artifacts
    WHERE status = 'in-progress'
      AND claimed_by IS NOT NULL
      AND claimed_at IS NOT NULL
      AND ((julianday('now') - julianday(claimed_at)) * 1440) >= ?
    ORDER BY claimed_at ASC
  `).all(STALL_MINUTES) as Array<{
    id: string;
    path: string;
    claimed_by: string;
    age_minutes: number;
  }>;

  if (rows.length === 0) return;

  console.log(`\n${BOLD}${RED}Stale Sessions${R}`);
  for (const row of rows.slice(0, 5)) {
    console.log(
      `  ${RED}⚠${R} ${row.claimed_by.padEnd(18)} ${path.basename(row.path)}  ${row.age_minutes}m  release: node migration/guildctl/dist/cli.js release --id "${row.id}"`
    );
  }
  if (rows.length > 5) {
    console.log(`  ${DIM}... ${rows.length - 5} more stale session(s) omitted${R}`);
  }
}
