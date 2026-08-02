import type Database from "better-sqlite3";
import { spawnAgent, summarizeRunFailures } from "../runner";
import { startPolling } from "../poller";
import { printPhaseHeader, printEvent, printStatusSummary } from "../dashboard";
import { getLogDir } from "../util";
import { loadConfig, resolvePhaseModel, resolveWorkspaceRoot } from "../config";
import { reapDeadRuns } from "../../registry/commands/runs";
import { requireNonEmptyRegistry } from "../readiness";
import { resolveAndReportRuntime } from "../runtime-report";

const REVIEW_TIMEOUT_MINUTES = Math.max(1, parseInt(process.env["GUILDCTL_REVIEW_TIMEOUT_MINS"] ?? "10", 10));

interface ReviewCandidate {
  id: string;
  path: string;
  verification_state: string;
  verification_reason: string;
}

/**
 * Review candidates carry their verification state and reason (FR-009).
 *
 * This is **triage input only**: it tells a reviewer where to look first. It
 * grants no approval power, cannot substitute for acceptance evidence, and
 * cannot unlock a status transition — the arbitration gate is unchanged
 * (Constitution IV, research R11). Nothing here filters an artifact out of
 * review on the strength of its verification state.
 */
function getMigratedArtifacts(db: Database.Database): ReviewCandidate[] {
  return db.prepare(`
    SELECT a.id, a.path,
           COALESCE(v.state,  'unverified')    AS verification_state,
           COALESCE(v.reason, 'not-attempted') AS verification_reason
    FROM artifacts a
    LEFT JOIN artifact_verifications v ON v.artifact_id = a.id
    WHERE a.tier = 'first-class' AND a.status = 'migrated'
      AND NOT EXISTS (
        SELECT 1 FROM runs r
        WHERE r.agent = 'review-agent'
          AND r.prompt LIKE '%' || a.path || '%'
          AND r.status = 'running'
      )
    ORDER BY a.path
  `).all() as ReviewCandidate[];
}

/** The triage note a reviewer sees alongside the artifact under review. */
export function formatReviewTriageNote(candidate: ReviewCandidate): string {
  if (candidate.verification_state === "verified") {
    return "verification: verified (triage input only — independent evidence is still required)";
  }
  return `verification: ${candidate.verification_state} (${candidate.verification_reason}) — triage input only, review on its merits`;
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
  const cfg = loadConfig();
  const model = resolvePhaseModel("review", cfg);
  const runAgent = deps.spawnAgent ?? spawnAgent;
  const poll = deps.startPolling ?? startPolling;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  printPhaseHeader("Phase 4 · Review");
  console.log(`  Agent: review-agent   Model: ${model}   Parallel: ${parallel}\n`);
  // FR-024: one resolution, reported here and reused by every review session.
  const runtime = resolveAndReportRuntime({ config: cfg, root: resolveWorkspaceRoot(), model });

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
        const procs = batch.map((candidate) =>
          runAgent({
            agent: "review-agent",
            model,
            prompt: `Review migration for ${candidate.path}\n${formatReviewTriageNote(candidate)}`,
            db,
            logDir,
            phase: "review",
            timeoutMs: REVIEW_TIMEOUT_MINUTES * 60_000,
            resolution: runtime,
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
