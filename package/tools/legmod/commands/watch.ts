import * as path from "path";
import type Database from "better-sqlite3";
import {
  printWavePlan,
  printStatusSummary,
} from "../dashboard";
import { getStuckArtifacts } from "./release";

const CLEAR = "\x1b[2J\x1b[H";
const R = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";
const BLUE = "\x1b[34m";

const STALL_MINUTES = parseInt(process.env["LEGMOD_STALL_MINS"] ?? "10", 10);

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

interface RecentEvent {
  ts: string;
  agent: string;
  summary: string;
  path: string;
  module: string | null;
}

function getRecentEvents(db: Database.Database, limit = 12): RecentEvent[] {
  return db.prepare(`
    SELECT e.ts, e.agent, e.summary, a.path, a.module
    FROM events e
    JOIN artifacts a ON e.artifact_id = a.id
    WHERE e.type = 'status-changed'
    ORDER BY e.ts DESC
    LIMIT ?
  `).all(limit) as RecentEvent[];
}

function renderEvents(events: RecentEvent[]): void {
  console.log(`\n${BOLD}Recent Events${R}`);
  if (events.length === 0) {
    console.log(`  ${DIM}none yet${R}`);
    return;
  }
  for (const e of [...events].reverse()) {
    const time = e.ts.split(" ")[1] ?? e.ts;
    const file = path.basename(e.path);
    const mod = e.module ? `${DIM}[${e.module}]${R} ` : "";
    const [from, , to] = e.summary.split(" ");
    const coloredSummary = to
      ? `${DIM}${from}${R} → ${STATUS_COLOR[to] ?? ""}${to}${R}`
      : e.summary;
    process.stdout.write(
      `  ${DIM}${time}${R}  ${CYAN}${e.agent.padEnd(18)}${R}  ${mod}${file}  ${coloredSummary}\n`
    );
  }
}

function renderActiveSessions(db: Database.Database): void {
  const rows = db.prepare(`
    SELECT id, path, claimed_by, claimed_at,
      CAST((julianday('now') - julianday(claimed_at)) * 1440 AS INTEGER) AS ageMinutes
    FROM artifacts
    WHERE status = 'in-progress' AND claimed_by IS NOT NULL
    ORDER BY claimed_at ASC
  `).all() as Array<{ id: string; path: string; claimed_by: string; claimed_at: string; ageMinutes: number }>;

  if (rows.length === 0) return;

  console.log(`\n${BOLD}Active Sessions${R}`);
  for (const row of rows) {
    const age = row.ageMinutes;
    const ageStr = age >= 60 ? `${Math.floor(age / 60)}h${age % 60}m` : `${age}m`;
    const stalled = age >= STALL_MINUTES;
    const ageColor = stalled ? RED : DIM;
    const file = path.basename(row.path);
    const stallFlag = stalled ? `  ${RED}⚠ stalled — run: guildctl release --id "${row.id}"${R}` : "";
    console.log(`  ${YELLOW}${row.claimed_by.padEnd(18)}${R}  ${file}  ${ageColor}${ageStr}${R}${stallFlag}`);
  }
}

export function runWatch(db: Database.Database, intervalMs = 2000): void {
  function render(): void {
    process.stdout.write(CLEAR);

    const now = new Date().toLocaleTimeString();
    const stallNote = `${DIM}stall threshold: ${STALL_MINUTES}m${R}`;
    console.log(`${BOLD}guildctl watch${R}  ${DIM}refreshed ${now} · Ctrl+C to exit${R}  ${stallNote}`);

    printStatusSummary(db);
    printWavePlan(db);
    renderActiveSessions(db);
    renderEvents(getRecentEvents(db));
  }

  render();
  const handle = setInterval(render, intervalMs);

  process.on("SIGINT", () => {
    clearInterval(handle);
    process.stdout.write("\n");
    process.exit(0);
  });
}
