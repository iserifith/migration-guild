import type Database from "better-sqlite3";
import { spawnAgent, summarizeRunFailures } from "../runner";
import { startPolling } from "../poller";
import { printPhaseHeader, printEvent, printWavePlan } from "../dashboard";
import { getLogDir } from "../util";
import { loadConfig, resolvePhaseModel } from "../../foundry/config";

function hasMigrationRemaining(db: Database.Database, wave?: number): boolean {
  const waveClause = wave != null ? "AND wave = @wave" : "";
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM artifacts
    WHERE tier = 'first-class'
      AND status IN ('planned','analyzed','in-progress','tests-written')
      ${waveClause}
  `).get({ wave: wave ?? null }) as { n: number };
  return row.n > 0;
}

export interface MigrateOpts {
  parallel?: number;       // kept for backward compat — sets both pools
  testParallel?: number;   // override parallel count for test-writer pool
  codeParallel?: number;   // override parallel count for code-writer pool
  wave?: number;
}

interface MigrateDeps {
  spawnAgent?: typeof spawnAgent;
  startPolling?: typeof startPolling;
  getLogDir?: typeof getLogDir;
}

export async function runMigrate(
  db: Database.Database,
  opts: MigrateOpts = {},
  deps: MigrateDeps = {},
): Promise<void> {
  const testParallel = Math.max(1, opts.testParallel ?? opts.parallel ?? 1);
  const codeParallel = Math.max(1, opts.codeParallel ?? opts.parallel ?? 1);
  const waveLabel = opts.wave != null ? ` (wave ${opts.wave})` : "";
  const cfg = loadConfig();
  const testModel = resolvePhaseModel("test-writing", cfg.foundry);
  const codeModel = resolvePhaseModel("code-writing", cfg.foundry);
  const runAgent = deps.spawnAgent ?? spawnAgent;
  const poll = deps.startPolling ?? startPolling;
  const logDir = (deps.getLogDir ?? getLogDir)();

  printPhaseHeader("Phase 3 · Migration");
  console.log(`  Pool 1 · Test writers   Agent: test-writer-agent   Model: ${testModel}   Parallel: ${testParallel}${waveLabel}`);
  console.log(`  Pool 2 · Code writers   Agent: code-writer-agent   Model: ${codeModel}   Parallel: ${codeParallel}${waveLabel}\n`);
  printWavePlan(db);
  console.log();

  const stopPolling = poll(db, (events) => {
    for (const e of events) printEvent(e);
  });

  try {
    // Pool 1 — Test writers: claim tasks and write JUnit 5 tests
    const testPrompt = opts.wave != null
      ? `Write tests for next task from wave ${opts.wave}`
      : "Write tests for next task";

    process.stdout.write(`\n  [Pool 1] Spawning ${testParallel} test-writer session(s)\n`);
    const testSessions = Array.from({ length: testParallel }, () =>
      runAgent({ agent: "test-writer-agent", model: testModel, prompt: testPrompt, db, logDir, phase: "test-writing" })
    );
    const testResults = await Promise.all(testSessions);
    const testFailure = summarizeRunFailures(testResults);
    if (testFailure) {
      throw new Error(`Test-writer pool failed: ${testFailure}`);
    }

    // Pool 2 — Code writers: pick up tests-written artifacts and write production code
    const codePrompt = opts.wave != null
      ? `Write production code for next tests-written task from wave ${opts.wave}`
      : "Write production code for next tests-written task";

    process.stdout.write(`\n  [Pool 2] Spawning ${codeParallel} code-writer session(s)\n`);
    const codeSessions = Array.from({ length: codeParallel }, () =>
      runAgent({ agent: "code-writer-agent", model: codeModel, prompt: codePrompt, db, logDir, phase: "code-writing" })
    );
    const codeResults = await Promise.all(codeSessions);
    const codeFailure = summarizeRunFailures(codeResults);
    if (codeFailure) {
      throw new Error(`Code-writer pool failed: ${codeFailure}`);
    }

    printWavePlan(db);

    if (hasMigrationRemaining(db, opts.wave)) {
      process.stderr.write(`\n  ⚠ Some tasks still remain — migration did not finish all first-class artifacts.\n`);
      process.stderr.write(`    Run: node migration/registry/dist/cli.js show-blockers\n\n`);
    } else {
      console.log("\n  ✓ Migration complete\n");
    }
  } finally {
    stopPolling();
  }
}
