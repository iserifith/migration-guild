import type Database from "better-sqlite3";
import { runInventory } from "./inventory";
import { runPlan } from "./plan";
import { runMigrate, type MigrateOpts } from "./migrate";
import { runReview, type ReviewOpts } from "./review";
import { runStatus } from "./status";

export interface RunAllOpts extends MigrateOpts, ReviewOpts {}

function phaseState(db: Database.Database) {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN wave IS NOT NULL THEN 1 ELSE 0 END) AS planned,
      SUM(CASE WHEN status IN ('migrated','reviewed','completed') THEN 1 ELSE 0 END) AS migrated,
      SUM(CASE WHEN status IN ('reviewed','completed') THEN 1 ELSE 0 END) AS reviewed
    FROM artifacts WHERE tier = 'first-class'
  `).get() as { total: number; planned: number; migrated: number; reviewed: number };
  return row;
}

export async function runAll(db: Database.Database, opts: RunAllOpts = {}): Promise<void> {
  runStatus(db);

  const s = phaseState(db);

  // Phase 1: inventory — skip if artifacts already registered
  if (s.total === 0) {
    await runInventory(db);
  } else {
    console.log("  ↷ Inventory already done — skipping\n");
  }

  // Phase 2: plan — skip if all first-class artifacts have waves assigned
  const s2 = phaseState(db);
  if (s2.total > 0 && s2.planned < s2.total) {
    await runPlan(db);
  } else {
    console.log("  ↷ Planning already done — skipping\n");
  }

  // Phase 3: migrate — skip if nothing left to migrate
  const s3 = phaseState(db);
  if (s3.migrated < s3.total) {
    await runMigrate(db, opts);
  } else {
    console.log("  ↷ Migration already done — skipping\n");
  }

  // Phase 4: review — skip if everything is reviewed
  const s4 = phaseState(db);
  if (s4.reviewed < s4.total) {
    await runReview(db, opts);
  } else {
    console.log("  ↷ Review already done — skipping\n");
  }

  runStatus(db);
}
