import type Database from "better-sqlite3";
import { spawnAgent } from "../runner";
import type { AgentRunResult } from "../runner";
import { startPolling } from "../poller";
import { printPhaseHeader, printEvent, printStatusSummary } from "../dashboard";
import { getLogDir } from "../util";
import { getConfigPath, loadConfig, requirePhaseFoundryConfig, resolvePhaseModel, resolvePhaseProvider } from "../../foundry/config";
import { getStatusCounts, printCompletionReason, printPoolSummary, printResolvedRuntime, printStaleSessionWarnings } from "../monitoring";
import { reapDeadRuns } from "../../registry/commands/runs";

const REVIEW_TIMEOUT_MINUTES = Math.max(1, parseInt(process.env["LEGMOD_REVIEW_TIMEOUT_MINS"] ?? "10", 10));

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

export async function runReview(db: Database.Database, opts: ReviewOpts = {}): Promise<void> {
  const parallel = Math.max(1, opts.parallel ?? 1);
  const logDir = getLogDir();
  const cfg = loadConfig();
  const model = resolvePhaseModel("review", cfg.foundry);
  const provider = resolvePhaseProvider("review", cfg.foundry);
  if (provider === "foundry") requirePhaseFoundryConfig("review", cfg);

  printPhaseHeader("Phase 5 · Review");
  console.log(`  Agent: review-agent   Model: ${model}   Parallel: ${parallel}\n`);
  printResolvedRuntime({
    phase: "review",
    provider,
    model,
    configPath: getConfigPath(),
    batchEnabled: cfg.foundry?.batchEnabled,
    providerType: cfg.foundry?.providerType,
    endpoint: provider === "foundry" ? cfg.foundry?.openaiEndpoint : undefined,
  });

  const stopPolling = startPolling(db, (events) => {
    for (const e of events) printEvent(e);
  });

  const results: AgentRunResult[] = [];
  const before = getStatusCounts(db);
  let stalled = false;

  // Keep polling for newly migrated files as long as migration is still running
  // or there are unreviewed migrated files remaining.
  while (true) {
    reapDeadRuns(db, "review-agent");
    const newArtifacts = getMigratedArtifacts(db);

    if (newArtifacts.length === 0) {
      if (!hasMigratingRemaining(db) && !hasReviewRemaining(db) && !hasRunningReviewRuns(db)) break;
      await new Promise((r) => setTimeout(r, 3000));  // wait for more to appear
      continue;
    }

    let progressMade = false;

    // Dispatch in batches of `parallel`
    for (let i = 0; i < newArtifacts.length; i += parallel) {
      const batch = newArtifacts.slice(i, i + parallel);
      const snapshotBefore = getReviewSnapshot(db);
      const procs = batch.map(({ path: file }) =>
        spawnAgent({
          agent: "review-agent",
          model,
          prompt: `Review migration for ${file}`,
          db,
          logDir,
          phase: "review",
          timeoutMs: REVIEW_TIMEOUT_MINUTES * 60_000,
        })
      );
      results.push(...await Promise.all(procs));
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

  stopPolling();
  printPoolSummary({
    label: "Review",
    results,
    before,
    after: getStatusCounts(db),
    advancedStatus: "reviewed",
  });
  printStaleSessionWarnings(db);
  printStatusSummary(db);
  printCompletionReason("Review outcome", getStatusCounts(db));
  if (stalled) {
    process.stderr.write("\n  ⚠ Review incomplete\n\n");
  } else {
    console.log("\n  ✓ Review complete\n");
  }
}
