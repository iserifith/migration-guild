import type Database from "better-sqlite3";
import { spawnCopilot } from "../runner";
import { startPolling } from "../poller";
import { printPhaseHeader, printEvent, printWavePlan } from "../dashboard";
import { getLogDir } from "../util";

function hasPlannedRemaining(db: Database.Database, wave?: number): boolean {
  const waveClause = wave != null ? "AND wave = @wave" : "";
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM artifacts
    WHERE tier = 'first-class' AND status IN ('planned','in-progress') ${waveClause}
  `).get({ wave: wave ?? null }) as { n: number };
  return row.n > 0;
}

export interface MigrateOpts {
  parallel?: number;
  wave?: number;
}

export async function runMigrate(db: Database.Database, opts: MigrateOpts = {}): Promise<void> {
  const parallel = Math.max(1, opts.parallel ?? 1);
  const waveLabel = opts.wave != null ? ` (wave ${opts.wave})` : "";

  printPhaseHeader("Phase 3 · Migration");
  console.log(`  Agent: migration-agent   Model: gpt-5-mini   Parallel: ${parallel}${waveLabel}\n`);
  printWavePlan(db);
  console.log();

  const stopPolling = startPolling(db, (events) => {
    for (const e of events) printEvent(e);
  });

  // Each session is long-lived: it loops internally claiming tasks until
  // the registry returns exit code 2 (nothing left to claim). We spawn
  // exactly N sessions and wait for all of them to finish naturally.
  const prompt = opts.wave != null
    ? `Migrate next task from wave ${opts.wave}`
    : "Migrate next task";

  process.stdout.write(`\n  Spawning ${parallel} session(s) — each will claim tasks until none remain\n`);

  const sessions = Array.from({ length: parallel }, () =>
    spawnCopilot({ agent: "migration-agent", model: "gpt-5-mini", prompt, db, logDir: getLogDir() })
  );

  await Promise.all(sessions);
  stopPolling();
  printWavePlan(db);

  if (hasPlannedRemaining(db, opts.wave)) {
    process.stderr.write(`\n  ⚠ Some tasks still remain — dependencies may be blocking.\n`);
    process.stderr.write(`    Run: node migration/registry/dist/cli.js show-blockers\n\n`);
  } else {
    console.log("\n  ✓ Migration complete\n");
  }
}

