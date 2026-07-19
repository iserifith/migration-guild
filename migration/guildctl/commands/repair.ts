import type Database from "better-sqlite3";
import { reapDeadRuns } from "../../registry/commands/runs";
import { reconcileStaleClaims } from "../../registry/commands/claim";
import { releaseTask } from "../../registry/commands/artifacts";
import { setNext } from "../../registry/commands/operator";
import { printPhaseHeader, printWavePlan, printStatusSummary, printInProgress } from "../dashboard";
import { printStaleSessionWarnings } from "../monitoring";

const R = "\x1b[0m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const BOLD = "\x1b[1m";

export interface RepairOpts {
  dryRun?: boolean;
  wave?: number;
  /** Release all stuck in-progress artifacts, not only stale/expired claims. */
  releaseAllStuck?: boolean;
  /** Only release artifacts stuck for at least N minutes (requires releaseAllStuck). */
  olderThanMins?: number;
}

interface StuckArtifact {
  id: string;
  path: string;
  claimed_by: string;
  claimed_at: string;
  ageMinutes: number;
}

function getStuckArtifacts(db: Database.Database, wave: number | undefined, olderThanMins?: number): StuckArtifact[] {
  const waveClause = wave != null ? "AND a.wave = @wave" : "";
  const rows = db.prepare(`
    SELECT a.id, a.path, c.owner_id AS claimed_by, c.claimed_at,
      CAST((julianday('now') - julianday(c.claimed_at)) * 1440 AS INTEGER) AS ageMinutes
    FROM artifacts a
    JOIN artifact_claims c ON c.artifact_id = a.id AND c.state = 'active'
    WHERE a.status = 'in-progress' AND c.owner_id IS NOT NULL AND c.claimed_at IS NOT NULL
      ${waveClause}
    ORDER BY c.claimed_at ASC
  `).all({ wave: wave ?? null }) as StuckArtifact[];

  if (olderThanMins != null) {
    return rows.filter((r) => r.ageMinutes >= olderThanMins);
  }
  return rows;
}

function printRepairSummary(reaped: number, reconciled: number, released: number, dryRun: boolean): void {
  console.log(`\n  ${BOLD}Repair summary${R}`);
  const prefix = dryRun ? `${DIM}[dry-run]${R} ` : "";
  console.log(`  ${prefix}${reaped > 0 ? YELLOW : DIM}reaped dead runs${R}        ${reaped}`);
  console.log(`  ${prefix}${reconciled > 0 ? YELLOW : DIM}reconciled stale claims${R} ${reconciled}`);
  console.log(`  ${prefix}${released > 0 ? YELLOW : DIM}released stuck artifacts${R}  ${released}`);

  if (reaped === 0 && reconciled === 0 && released === 0) {
    console.log(`\n  ${GREEN}✓${R} No crash state detected — registry is clean.`);
  } else {
    console.log(`\n  ${GREEN}✓${R} Crash state cleared — safe to continue migration.`);
  }
}

export function runRepair(db: Database.Database, opts: RepairOpts = {}): void {
  const dryRun = opts.dryRun === true;

  printPhaseHeader(`Phase · Repair${dryRun ? " (dry-run)" : ""}`);
  if (opts.wave != null) {
    console.log(`  Scope: wave ${opts.wave}\n`);
  } else {
    console.log();
  }

  // ─── Step 1: Reap dead runs ──────────────────────────────────────────────
  // Runs whose PID disappeared (crashed, killed, terminal closed) are marked
  // as failed. This cascades into stale-claim reconciliation in the next step.
  process.stdout.write("  Scanning for dead runs...\n");
  const reapedRuns = dryRun
    ? reapDeadRunsDryRun(db)
    : reapDeadRuns(db);
  if (reapedRuns.length > 0) {
    for (const run of reapedRuns) {
      console.log(`  ${YELLOW}↯${R} reaped ${run.agent} run ${run.run_id} ${DIM}${run.termination_reason ?? ""}${R}`);
    }
  } else {
    console.log(`  ${DIM}no dead runs${R}`);
  }

  // ─── Step 2: Reconcile stale claims ──────────────────────────────────────
  // Releases claims whose lease expired or whose run is no longer active.
  // Returns the artifacts that were returned to their pre-claim status.
  process.stdout.write("\n  Reconciling stale claims...\n");
  let reconciledCount = 0;
  if (!dryRun) {
    const recovered = reconcileStaleClaims(db, "guildctl-repair");
    reconciledCount = recovered.length;
    for (const artifact of recovered) {
      console.log(`  ${GREEN}↻${R} ${artifact.id} returned to ${YELLOW}${artifact.status}${R}`);
    }
  } else {
    const recovered = reconcileStaleClaimsDryRun(db);
    reconciledCount = recovered.length;
    for (const artifact of recovered) {
      console.log(`  ${DIM}↻ (dry-run)${R} ${artifact.id} would return to ${artifact.status}`);
    }
  }
  if (reconciledCount === 0) {
    console.log(`  ${DIM}no stale claims${R}`);
  }

  // ─── Step 3: Release remaining stuck artifacts ───────────────────────────
  // After claim reconciliation, some artifacts may still be in-progress if
  // their claims were not yet stale but the user wants to force-release them.
  let releasedCount = 0;
  if (opts.releaseAllStuck !== false) {
    process.stdout.write("\n  Releasing stuck in-progress artifacts...\n");
    const stuck = getStuckArtifacts(db, opts.wave, opts.olderThanMins);
    if (stuck.length > 0) {
      for (const s of stuck) {
        if (dryRun) {
          console.log(`  ${DIM}↩ (dry-run)${R} ${s.id} ${s.claimed_by} ${YELLOW}${s.ageMinutes}m${R} ${DIM}${s.path}${R}`);
        } else {
          releaseTask(db, s.id, "guildctl-repair", `released via guildctl repair${opts.olderThanMins != null ? ` --older-than ${opts.olderThanMins}` : ""}`);
          console.log(`  ${GREEN}↩${R} ${s.id} ${s.claimed_by.padEnd(18)} ${YELLOW}${s.ageMinutes}m${R} ${DIM}${s.path}${R}`);
        }
      }
      releasedCount = stuck.length;
    } else {
      console.log(`  ${DIM}no stuck artifacts${R}`);
    }
  }

  // ─── Step 4: Record repair action in operator state ───────────────────────
  if (!dryRun) {
    const remaining = getRemainingCount(db, opts.wave);
    if (remaining > 0) {
      const pending = getPendingCount(db, opts.wave);
      const nextCmd = pending > 0
        ? "node migration/guildctl/dist/cli.js inventory"
        : opts.wave != null
          ? `node migration/guildctl/dist/cli.js migrate --wave ${opts.wave}`
          : "node migration/guildctl/dist/cli.js migrate";
      setNext(db, {
        summary: `Repair complete — ${remaining} artifact(s) still need migration.`,
        reason: pending > 0
          ? `${pending} artifact(s) still require inventory classification before planning.`
          : "Crash state cleared. Resume migration from where it stopped.",
        recommendedCommand: nextCmd,
      });
    } else {
      setNext(db, {
        summary: "Repair complete — no remaining migration work.",
        reason: "All first-class artifacts are in terminal status.",
        recommendedCommand: "node migration/guildctl/dist/cli.js status",
      });
    }
  }

  // ─── Step 5: Print summary and current status ────────────────────────────
  printRepairSummary(reapedRuns.length, reconciledCount, releasedCount, dryRun);

  console.log();
  printStatusSummary(db);
  printWavePlan(db);
  printInProgress(db);
  if (!dryRun) {
    printStaleSessionWarnings(db);
  }

  console.log();
  printNextStepsAfterRepair(db, opts.wave, dryRun);
}

function getRemainingCount(db: Database.Database, wave: number | undefined): number {
  const waveClause = wave != null ? "AND wave = @wave" : "";
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM artifacts
    WHERE tier = 'first-class'
      AND status IN ('pending','planned','analyzed','tests-written','in-progress')
      ${waveClause}
  `).get({ wave: wave ?? null }) as { n: number };
  return row.n;
}

function getPendingCount(db: Database.Database, wave: number | undefined): number {
  const waveClause = wave != null ? "AND wave = @wave" : "";
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM artifacts
    WHERE tier = 'first-class' AND status = 'pending'
      ${waveClause}
  `).get({ wave: wave ?? null }) as { n: number };
  return row.n;
}

function printNextStepsAfterRepair(db: Database.Database, wave: number | undefined, dryRun: boolean): void {
  const remaining = getRemainingCount(db, wave);
  const cmd = "node migration/guildctl/dist/cli.js";

  console.log("  ─── What to run next ────────────────────────────────────────\n");

  if (dryRun) {
    console.log(`  ${DIM}Dry-run complete — no changes were applied.${R}`);
    console.log(`  Run without --dry-run to perform the repair.\n`);
    return;
  }

  if (remaining > 0) {
    const pending = getPendingCount(db, wave);
    console.log(`  Continue migration:\n`);
    if (pending > 0) {
      console.log(`       ${cmd} inventory\n`);
    } else {
      const waveFlag = wave != null ? ` --wave ${wave}` : "";
      console.log(`       ${cmd} migrate${waveFlag}\n`);
    }
    return;
  }

  // Check if review is needed
  const reviewedRow = db.prepare(`
    SELECT COUNT(*) AS n FROM artifacts
    WHERE tier = 'first-class'
      AND status IN ('migrated')
  `).get() as { n: number };

  if (reviewedRow.n > 0) {
    console.log(`  Migration complete — run review:\n`);
    console.log(`       ${cmd} review\n`);
    return;
  }

  console.log(`  ${GREEN}✓${R} All phases complete!\n`);
}

// ─── Dry-run helpers (inspect without mutating) ─────────────────────────────

interface DeadRunLike {
  run_id: string;
  agent: string;
  termination_reason: string | null;
}

function reapDeadRunsDryRun(db: Database.Database): DeadRunLike[] {
  // re-ap without side effects: query the same rows reapDeadRuns would reap,
  // but don't call finishRun on them.
  const rows = db.prepare(`
    SELECT run_id, agent, termination_reason,
      CAST((julianday('now') - julianday(started_at)) * 1440 AS INTEGER) AS age_minutes,
      pid
    FROM runs
    WHERE status = 'running'
  `).all() as Array<{ run_id: string; agent: string; termination_reason: string | null; age_minutes: number; pid: number | null }>;

  const STALE_RUN_MINUTES = parseInt(process.env["GUILDCTL_STALE_RUN_MINUTES"] ?? "10", 10);
  return rows
    .filter((row) => row.pid == null && row.age_minutes >= STALE_RUN_MINUTES)
    .map((row) => ({
      run_id: row.run_id,
      agent: row.agent,
      termination_reason: row.termination_reason,
    }));
}

interface ArtifactLike {
  id: string;
  status: string;
}

function reconcileStaleClaimsDryRun(db: Database.Database): ArtifactLike[] {
  const { now } = db.prepare("SELECT datetime('now') AS now").get() as { now: string };
  const rows = db.prepare(`
    SELECT c.artifact_id AS id, c.from_status AS status
    FROM artifact_claims c
    LEFT JOIN runs r ON r.run_id = c.run_id
    WHERE c.state = 'active'
      AND (
        c.lease_expires_at <= @now
        OR (c.run_id IS NOT NULL AND (r.run_id IS NULL OR r.status != 'running'))
      )
    ORDER BY c.claimed_at ASC
  `).all({ now }) as ArtifactLike[];
  return rows;
}
