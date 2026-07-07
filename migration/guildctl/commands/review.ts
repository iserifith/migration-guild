import type Database from "better-sqlite3";
import { spawnAgent, summarizeRunFailures } from "../runner";
import { startPolling } from "../poller";
import { printPhaseHeader, printEvent, printStatusSummary } from "../dashboard";
import { getLogDir } from "../util";
import { loadConfig, resolvePhaseModel } from "../config";
import { reapDeadRuns } from "../../registry/commands/runs";
import { requireNonEmptyRegistry } from "../readiness";

const REVIEW_TIMEOUT_MINUTES = Math.max(1, parseInt(process.env["GUILDCTL_REVIEW_TIMEOUT_MINS"] ?? "10", 10));

function getMigratedArtifacts(db: Database.Database): Array<{ id: string; path: string }> {
  return db.prepare(`
    SELECT a.id, a.path FROM artifacts a
    WHERE a.tier = 'first-class' AND a.status = 'migrated'
      AND NOT EXISTS (
        SELECT 1 FROM runs r
        WHERE r.agent = 'review-agent'
          AND r.prompt LIKE '%' || a.path || '%'
          AND r.status = 'running'
      )
    ORDER BY a.path
  `).all() as Array<{ id: string; path: string }>;
}

function hasMigratingRemaining(db: Database.Database): boolean {
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM artifacts
    WHERE tier = 'first-class' AND status IN ('planned','in-progress','tests-written','analyzed')
  `).get() as { n: number };
  return row.n > 0;
}

function hasReviewRemaining(db: Database.Database): boolean {
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM artifacts
    WHERE tier = 'first-class' AND status = 'migrated'
  `).get() as { n: number };
  return row.n > 0;
}

function hasRunningReviewRuns(db: Database.Database): boolean {
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM runs
    WHERE agent = 'review-agent' AND status = 'running'
  `).get() as { n: number };
  return row.n > 0;
}

function getReviewSnapshot(db: Database.Database): { migrated: number } {
  return db.prepare(`
    SELECT COUNT(*) AS migrated FROM artifacts
    WHERE tier = 'first-class' AND status = 'migrated'
  `).get() as { migrated: number };
}

export interface ReviewOpts {
  parallel?: number;
}

interface ReviewDeps {
  spawnAgent?: typeof spawnAgent;
  startPolling?: typeof startPolling;
  getLogDir?: typeof getLogDir;
  sleep?: (ms: number) => Promise<void>;
}

export async function runReview(
  db: Database.Database,
  opts: ReviewOpts = {},
  deps: ReviewDeps = {},
): Promise<void> {
  requireNonEmptyRegistry(db, "review");
  const parallel = Math.max(1, opts.parallel ?? 1);
  const logDir = (deps.getLogDir ?? getLogDir)();
  const model = resolvePhaseModel("review", loadConfig());
  const runAgent = deps.spawnAgent ?? spawnAgent;
  const poll = deps.startPolling ?? startPolling;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  printPhaseHeader("Phase 4 · Review");
  console.log(`  Agent: review-agent   Model: ${model}   Parallel: ${parallel}\n`);

  const stopPolling = poll(db, (events) => {
    for (const e of events) printEvent(e);
  });
  let stalled = false;
  let completed = false;

  try {
    // Keep polling for newly migrated files as long as migration is still running
    // or there are unreviewed migrated files remaining.
    while (true) {
      reapDeadRuns(db, "review-agent");
      const newArtifacts = getMigratedArtifacts(db);

      if (newArtifacts.length === 0) {
        if (!hasMigratingRemaining(db) && !hasReviewRemaining(db) && !hasRunningReviewRuns(db)) break;
        await sleep(3000);
        continue;
      }

      let progressMade = false;

      // Dispatch in batches of `parallel`
      for (let i = 0; i < newArtifacts.length; i += parallel) {
        const batch = newArtifacts.slice(i, i + parallel);
        const snapshotBefore = getReviewSnapshot(db);
        const procs = batch.map(({ path: file }) =>
          runAgent({
            agent: "review-agent",
            model,
            prompt: `Review migration for ${file}`,
            db,
            logDir,
            phase: "review",
            timeoutMs: REVIEW_TIMEOUT_MINUTES * 60_000,
          })
        );
        const results = await Promise.all(procs);
        const failure = summarizeRunFailures(results);
        if (failure) {
          throw new Error(`Review pool failed: ${failure}`);
        }
        const snapshotAfter = getReviewSnapshot(db);
        progressMade ||= snapshotAfter.migrated < snapshotBefore.migrated;
      }

      if (!progressMade && !hasMigratingRemaining(db) && hasReviewRemaining(db) && !hasRunningReviewRuns(db)) {
        process.stderr.write("\n  ⚠ Review stalled — migrated artifacts remain, but review-agent made no registry progress.\n");
        process.stderr.write("    Check: node migration/registry/dist/cli.js list-runs --agent review-agent\n\n");
        stalled = true;
        break;
      }
    }
    completed = !stalled;
  } finally {
    stopPolling();
    printStatusSummary(db);
    if (stalled) {
      process.stderr.write("\n  ⚠ Review incomplete\n\n");
    } else if (completed) {
      console.log("\n  ✓ Review complete\n");
    }
  }
}
