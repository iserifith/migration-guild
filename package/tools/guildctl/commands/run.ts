import type Database from "better-sqlite3";
import { printNextSteps } from "./status";

export async function runAll(db: Database.Database): Promise<void> {
  printNextSteps(db);
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

  // Gate: abort if inventory produced nothing
  const s2 = phaseState(db);
  if (s2.total === 0) {
    process.stderr.write("  ✗ Inventory produced no artifacts — check that legacy/ contains .java files\n\n");
    process.exit(1);
  }

  // Phase 2: plan — skip if all first-class artifacts have waves assigned
  if (s2.planned < s2.total) {
    await runPlan(db);
  } else {
    console.log("  ↷ Planning already done — skipping\n");
  }

  // Gate: abort if planning assigned no waves
  const s3 = phaseState(db);
  if (s3.planned === 0) {
    process.stderr.write("  ✗ Planning produced no wave assignments — re-run `run plan` once the stack advisor has confirmed mappings\n\n");
    process.exit(1);
  }

  // Phase 3: migrate — skip if nothing left to migrate
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
