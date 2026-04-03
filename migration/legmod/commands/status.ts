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
  const cmd = "node migration/legmod/dist/cli.js";

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
    console.log(`  3. Migration (test-writer + code-writer run in parallel pools)\n`);
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


export function runStatus(db: Database.Database): void {
  printPhaseHeader("Migration Status");
  printStatusSummary(db);
  printWavePlan(db);
  printInProgress(db);
  console.log();
}
