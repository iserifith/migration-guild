import type Database from "better-sqlite3";
import { printPhaseHeader, printWavePlan, printStatusSummary, printInProgress } from "../dashboard";

export interface PhaseState {
  total: number;
  planned: number;
  migrated: number;
  reviewed: number;
}

const MIGRATION_DONE_STATUSES = "'migrated','reviewed','completed','skipped'";
const REVIEW_DONE_STATUSES = "'reviewed','completed','skipped'";

export function phaseState(db: Database.Database): PhaseState {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN wave IS NOT NULL THEN 1 ELSE 0 END) AS planned,
      SUM(CASE WHEN status IN (${MIGRATION_DONE_STATUSES}) THEN 1 ELSE 0 END) AS migrated,
      SUM(CASE WHEN status IN (${REVIEW_DONE_STATUSES}) THEN 1 ELSE 0 END) AS reviewed
    FROM artifacts WHERE tier = 'first-class'
  `).get() as PhaseState;
  return row;
}

export function printNextSteps(db: Database.Database): void {
  const s = phaseState(db);
  const cmd = "node migration/guildctl/dist/cli.js";

  console.log("\n  ─── What to run next ─────────────────────────────────────────\n");

  if (s.total === 0) {
    console.log(`  1. Inventory (register all Java files)\n`);
    console.log(`       ${cmd} run inventory\n`);
    return;
  }

  if (s.planned < s.total) {
    console.log(`  2. Planning (assign migration waves)\n`);
    console.log(`       ${cmd} run plan\n`);
    return;
  }

  if (s.migrated < s.total) {
    console.log(`  3. Migration (analyze + test-writer + code-writer pipeline)\n`);
    console.log(`       ${cmd} run migrate --parallel 3\n`);
    console.log(`     ↳ Each --parallel session is an independent agent.`);
    console.log(`       Run multiple terminals if you want more throughput.\n`);
    return;
  }

  if (s.reviewed < s.total) {
    console.log(`  4. Review (can run in parallel with migration)\n`);
    console.log(`       ${cmd} run review --parallel 2\n`);
    console.log(`     ↳ Start this once some files are migrated — no need to wait for all.\n`);
    return;
  }

  console.log(`  ✓ All phases complete!\n`);
  console.log(`     Check output in modern/ and migration/artifacts/\n`);
}


export interface VerificationSplit {
  verified: number;
  unverified: number;
  "verification-failed": number;
}

/**
 * FR-008 / SC-005: the verified / unverified / verification-failed split, read
 * through the coalescing LEFT JOIN so an artifact with no verification attempt
 * counts as unverified rather than disappearing.
 *
 * COUNT-shaped by design, so it stays fast on ~3,000-artifact registries.
 */
export function verificationSplit(db: Database.Database): VerificationSplit {
  const rows = db.prepare(`
    SELECT COALESCE(v.state, 'unverified') AS state, COUNT(*) AS count
    FROM artifacts a
    LEFT JOIN artifact_verifications v ON v.artifact_id = a.id
    WHERE a.tier = 'first-class'
    GROUP BY COALESCE(v.state, 'unverified')
  `).all() as Array<{ state: string; count: number }>;

  const split: VerificationSplit = { verified: 0, unverified: 0, "verification-failed": 0 };
  for (const row of rows) {
    if (row.state in split) split[row.state as keyof VerificationSplit] = row.count;
  }
  return split;
}

export function printVerificationSplit(db: Database.Database): void {
  const split = verificationSplit(db);
  if (split.verified + split.unverified + split["verification-failed"] === 0) return;
  console.log(
    `  Verification:  ${split.verified} verified · ${split.unverified} unverified · ${split["verification-failed"]} verification-failed`,
  );
  console.log(`                 (list with: registry list-verification --state <state>)`);
}

export function runStatus(db: Database.Database): void {
  printPhaseHeader("Migration Status");
  printStatusSummary(db);
  printVerificationSplit(db);
  printWavePlan(db);
  printInProgress(db);
  console.log();
}
