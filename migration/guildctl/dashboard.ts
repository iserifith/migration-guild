import * as path from "path";
import type Database from "better-sqlite3";
import type { RegistryEvent } from "./poller";

// ─── ANSI helpers ─────────────────────────────────────────────────────────────
const R = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";
const RED = "\x1b[31m";
const BLUE = "\x1b[34m";

const STATUS_COLOR: Record<string, string> = {
  "pending":       DIM,
  "planned":       BLUE,
  "in-progress":   YELLOW,
  "tests-written": CYAN,
  "migrated":      MAGENTA,
  "reviewed":      GREEN,
  "needs-rework":  RED,
  "analyzed":      CYAN,
  "completed":     GREEN,
  "blocked":       RED,
  "skipped":       DIM,
};

export function printPhaseHeader(phase: string): void {
  console.log(`\n${BOLD}━━━ ${phase} ${"━".repeat(Math.max(0, 50 - phase.length))}${R}`);
}

export function printEvent(event: RegistryEvent): void {
  const time = event.ts.split(" ")[1] ?? event.ts;
  const file = event.path ? path.basename(event.path) : event.artifact_id;
  const mod = event.module ? `${DIM}[${event.module}]${R} ` : "";
  const summary = event.summary;
  const m = summary.match(/^(\S+) (?:→|->) (\S+)$/);
  const coloredSummary = m
    ? `${DIM}${m[1]}${R} → ${STATUS_COLOR[m[2]] ?? ""}${m[2]}${R}`
    : summary;

  process.stdout.write(
    `  ${DIM}${time}${R}  ${CYAN}${event.agent.padEnd(18)}${R}  ${mod}${file}  ${coloredSummary}\n`
  );
}

export function printWavePlan(db: Database.Database): void {
  const rows = db.prepare(`
    SELECT wave,
           COUNT(*) AS total,
           SUM(CASE WHEN status IN ('migrated','reviewed','completed','skipped') THEN 1 ELSE 0 END) AS done,
           SUM(CASE WHEN status IN ('planned','analyzed','tests-written','in-progress') THEN 1 ELSE 0 END) AS active
    FROM artifacts
    WHERE tier = 'first-class' AND wave IS NOT NULL
    GROUP BY wave
    ORDER BY wave
  `).all() as Array<{ wave: number; total: number; done: number; active: number }>;

  if (rows.length === 0) return;

  console.log(`\n${BOLD}Wave Plan${R}`);
  for (const row of rows) {
    const pct = row.total > 0 ? Math.round((row.done / row.total) * 20) : 0;
    const bar = `${GREEN}${"█".repeat(pct)}${DIM}${"░".repeat(20 - pct)}${R}`;
    const label = `Wave ${row.wave}`.padEnd(8);
    const counts = `${GREEN}${row.done}${R}/${row.total}`;
    const active = row.active > 0 ? `  ${YELLOW}${row.active} active${R}` : "";
    console.log(`  ${label}  ${bar}  ${counts}${active}`);
  }
}

export function printStatusSummary(db: Database.Database): void {
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS n
    FROM artifacts
    WHERE tier = 'first-class'
    GROUP BY status
    ORDER BY CASE status
      WHEN 'pending'       THEN 1
      WHEN 'planned'       THEN 2
      WHEN 'in-progress'   THEN 3
      WHEN 'analyzed'      THEN 4
      WHEN 'tests-written' THEN 5
      WHEN 'migrated'      THEN 6
      WHEN 'needs-rework'  THEN 7
      WHEN 'reviewed'      THEN 8
      WHEN 'completed'     THEN 9
      ELSE 10 END
  `).all() as Array<{ status: string; n: number }>;

  if (rows.length === 0) return;

  console.log(`\n${BOLD}Status${R}`);
  for (const row of rows) {
    const color = STATUS_COLOR[row.status] ?? "";
    console.log(`  ${color}${row.status.padEnd(16)}${R}  ${row.n}`);
  }
}

export function printInProgress(db: Database.Database): void {
  const rows = db.prepare(`
    SELECT
      a.id,
      a.path,
      c.owner_id AS claimed_by,
      c.claimed_at,
      CAST(ROUND((julianday('now') - julianday(c.claimed_at)) * 86400) AS INTEGER) AS age_seconds
    FROM artifacts a
    JOIN artifact_claims c
      ON c.artifact_id = a.id
     AND c.state = 'active'
    LEFT JOIN runs r
      ON r.run_id = c.run_id
    WHERE a.status = 'in-progress'
      AND c.lease_expires_at > datetime('now')
      AND (c.run_id IS NULL OR r.status = 'running')
    ORDER BY c.claimed_at ASC
  `).all() as Array<{ id: string; path: string; claimed_by: string; claimed_at: string; age_seconds: number }>;

  if (rows.length === 0) return;

  console.log(`\n${BOLD}Active Sessions${R}`);
  for (const row of rows) {
    const age = Math.max(0, row.age_seconds ?? 0);
    const ageStr = age > 60 ? `${Math.round(age / 60)}m` : `${age}s`;
    const file = path.basename(row.path);
    console.log(`  ${YELLOW}${row.claimed_by.padEnd(18)}${R}  ${file}  ${DIM}${ageStr}${R}`);
  }
}
