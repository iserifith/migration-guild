import type Database from "better-sqlite3";
import { releaseTask } from "../../registry/commands/artifacts";

const DIM = "\x1b[2m";
const R = "\x1b[0m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";

export interface ReleaseOpts {
  id?: string;
  allStuck?: boolean;
  olderThan?: number; // minutes
}

interface StuckArtifact {
  id: string;
  path: string;
  claimed_by: string;
  claimed_at: string;
  ageMinutes: number;
}

export function getStuckArtifacts(db: Database.Database, olderThanMins?: number): StuckArtifact[] {
  const rows = db.prepare(`
    SELECT id, path, claimed_by, claimed_at,
      CAST((julianday('now') - julianday(claimed_at)) * 1440 AS INTEGER) AS ageMinutes
    FROM artifacts
    WHERE status = 'in-progress' AND claimed_by IS NOT NULL AND claimed_at IS NOT NULL
    ORDER BY claimed_at ASC
  `).all() as StuckArtifact[];

  if (olderThanMins != null) {
    return rows.filter((r) => r.ageMinutes >= olderThanMins);
  }
  return rows;
}

export async function runRelease(db: Database.Database, opts: ReleaseOpts): Promise<void> {
  if (!opts.id && !opts.allStuck) {
    process.stderr.write("  Provide --id <id> or --all-stuck\n");
    process.exit(1);
  }

  if (opts.id) {
    releaseTask(db, opts.id, "operator", "released via guildctl release");
    console.log(`  ${GREEN}✓${R} Released ${opts.id}`);
    return;
  }

  // --all-stuck
  const stuck = getStuckArtifacts(db, opts.olderThan);
  if (stuck.length === 0) {
    const qualifier = opts.olderThan ? ` older than ${opts.olderThan}m` : "";
    console.log(`  No stuck artifacts${qualifier} found.`);
    return;
  }

  console.log(`\n  Releasing ${stuck.length} artifact(s):\n`);
  for (const s of stuck) {
    releaseTask(db, s.id, "operator", "released via guildctl release --all-stuck");
    console.log(`  ${GREEN}✓${R} ${s.claimed_by.padEnd(18)} ${YELLOW}${s.ageMinutes}m${R}  ${DIM}${s.path}${R}`);
  }
  console.log();
}
