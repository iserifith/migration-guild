import type Database from "better-sqlite3";
import { spawnCopilot } from "../runner";
import { startPolling } from "../poller";
import { printPhaseHeader, printEvent, printStatusSummary } from "../dashboard";
import { getLogDir } from "../util";

function getMigratedPaths(db: Database.Database): string[] {
  const rows = db.prepare(`
    SELECT a.path FROM artifacts a
    WHERE a.tier = 'first-class' AND a.status = 'migrated'
      AND NOT EXISTS (
        SELECT 1 FROM runs r
        WHERE r.agent = 'review-agent'
          AND r.prompt LIKE '%' || a.path || '%'
          AND r.status = 'running'
      )
    ORDER BY a.path
  `).all() as Array<{ path: string }>;
  return rows.map((r) => r.path);
}

function hasMigratingRemaining(db: Database.Database): boolean {
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM artifacts
    WHERE tier = 'first-class' AND status IN ('planned','in-progress','tests-written','analyzed')
  `).get() as { n: number };
  return row.n > 0;
}

export interface ReviewOpts {
  parallel?: number;
}

export async function runReview(db: Database.Database, opts: ReviewOpts = {}): Promise<void> {
  const parallel = Math.max(1, opts.parallel ?? 1);
  const logDir = getLogDir();

  printPhaseHeader("Phase 4 · Review");
  console.log(`  Agent: review-agent   Model: claude-sonnet-4.6   Parallel: ${parallel}\n`);

  const stopPolling = startPolling(db, (events) => {
    for (const e of events) printEvent(e);
  });

  const reviewed = new Set<string>();

  // Keep polling for newly migrated files as long as migration is still running
  // or there are unreviewed migrated files remaining.
  while (true) {
    const newFiles = getMigratedPaths(db).filter((f) => !reviewed.has(f));

    if (newFiles.length === 0) {
      if (!hasMigratingRemaining(db)) break; // migration done, nothing left
      await new Promise((r) => setTimeout(r, 3000));  // wait for more to appear
      continue;
    }

    // Dispatch in batches of `parallel`
    for (let i = 0; i < newFiles.length; i += parallel) {
      const batch = newFiles.slice(i, i + parallel);
      batch.forEach((f) => reviewed.add(f));
      const procs = batch.map((file) =>
        spawnCopilot({ agent: "review-agent", model: "claude-sonnet-4.6", prompt: `Review migration for ${file}`, db, logDir })
      );
      await Promise.all(procs);
    }
  }

  stopPolling();
  printStatusSummary(db);
  console.log("\n  ✓ Review complete\n");
}
