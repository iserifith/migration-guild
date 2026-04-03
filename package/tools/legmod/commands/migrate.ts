import type Database from "better-sqlite3";
import { spawnAgent } from "../runner";
import { startPolling } from "../poller";
import { printPhaseHeader, printEvent, printWavePlan } from "../dashboard";
import { getLogDir } from "../util";
import {
  getConfigPath,
  loadConfig,
  resolvePhaseModel,
  resolvePhaseProvider,
} from "../../foundry/config";
import {
  getClaimabilityStats,
  getStatusCounts,
  printCompletionReason,
  printPoolSummary,
  printQueueSnapshot,
  printResolvedRuntime,
  printStaleSessionWarnings,
} from "../monitoring";

function statusCountsChanged(before: Record<string, number>, after: Record<string, number>): boolean {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if ((before[key] ?? 0) !== (after[key] ?? 0)) return true;
  }
  return false;
}

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

export async function runMigrate(db: Database.Database, opts: MigrateOpts = {}): Promise<void> {
  const testParallel = Math.max(1, opts.testParallel ?? opts.parallel ?? 1);
  const codeParallel = Math.max(1, opts.codeParallel ?? opts.parallel ?? 1);
  const waveLabel = opts.wave != null ? ` (wave ${opts.wave})` : "";
  const cfg = loadConfig();
  const testModel = resolvePhaseModel("test-writing", cfg.foundry);
  const codeModel = resolvePhaseModel("code-writing", cfg.foundry);
  const testProvider = resolvePhaseProvider("test-writing", cfg.foundry);
  const codeProvider = resolvePhaseProvider("code-writing", cfg.foundry);
  const configPath = getConfigPath();

  printPhaseHeader("Phase 3 · Migration");
  console.log(`  Pool 1 · Test writers   Agent: test-writer-agent   Model: ${testModel}   Parallel: ${testParallel}${waveLabel}`);
  console.log(`  Pool 2 · Code writers   Agent: code-writer-agent   Model: ${codeModel}   Parallel: ${codeParallel}${waveLabel}\n`);
  printResolvedRuntime({
    phase: "test-writing",
    provider: testProvider,
    model: testModel,
    configPath,
    batchEnabled: cfg.foundry?.batchEnabled,
    providerType: cfg.foundry?.providerType,
    endpoint: testProvider === "foundry" ? cfg.foundry?.openaiEndpoint : undefined,
  });
  printResolvedRuntime({
    phase: "code-writing",
    provider: codeProvider,
    model: codeModel,
    configPath,
    batchEnabled: cfg.foundry?.batchEnabled,
    providerType: cfg.foundry?.providerType,
    endpoint: codeProvider === "foundry" ? cfg.foundry?.openaiEndpoint : undefined,
  });
  printWavePlan(db);
  console.log();

  const stopPolling = startPolling(db, (events) => {
    for (const e of events) printEvent(e);
  });

  const testPrompt = opts.wave != null
    ? `Write tests for next task from wave ${opts.wave}`
    : "Write tests for next task";
  const codePrompt = opts.wave != null
    ? `Write production code for next tests-written task from wave ${opts.wave}`
    : "Write production code for next tests-written task";
  let pass = 1;

  while (hasMigrationRemaining(db, opts.wave)) {
    console.log(`\n  Pass ${pass}`);

    process.stdout.write(`\n  [Pool 1] Spawning ${testParallel} test-writer session(s)\n`);
    const testQueueBefore = getClaimabilityStats(db, "planned", opts.wave);
    printQueueSnapshot("Test queue", testQueueBefore);
    const beforeTests = getStatusCounts(db, opts.wave);
    const testSessions = Array.from({ length: testParallel }, () =>
      spawnAgent({ agent: "test-writer-agent", model: testModel, prompt: testPrompt, db, logDir: getLogDir(), phase: "test-writing" })
    );
    const testResults = await Promise.all(testSessions);
    const afterTests = getStatusCounts(db, opts.wave);
    printPoolSummary({
      label: "Test writers",
      results: testResults,
      before: beforeTests,
      after: afterTests,
      advancedStatus: "tests-written",
      claimability: getClaimabilityStats(db, "planned", opts.wave),
    });
    printStaleSessionWarnings(db);

    process.stdout.write(`\n  [Pool 2] Spawning ${codeParallel} code-writer session(s)\n`);
    const codeQueueBefore = getClaimabilityStats(db, "tests-written", opts.wave);
    printQueueSnapshot("Code queue", codeQueueBefore);
    const beforeCode = getStatusCounts(db, opts.wave);
    const codeSessions = Array.from({ length: codeParallel }, () =>
      spawnAgent({ agent: "code-writer-agent", model: codeModel, prompt: codePrompt, db, logDir: getLogDir(), phase: "code-writing" })
    );
    const codeResults = await Promise.all(codeSessions);
    const afterCode = getStatusCounts(db, opts.wave);
    printPoolSummary({
      label: "Code writers",
      results: codeResults,
      before: beforeCode,
      after: afterCode,
      advancedStatus: "migrated",
      claimability: getClaimabilityStats(db, "tests-written", opts.wave),
    });
    printStaleSessionWarnings(db);

    const progressMade = statusCountsChanged(beforeTests, afterCode);
    if (!progressMade) {
      console.log("\n  No further migration progress detected in this pass.");
      break;
    }

    pass += 1;
  }

  stopPolling();
  printWavePlan(db);
  const finalCounts = getStatusCounts(db, opts.wave);
  printCompletionReason("Migration outcome", finalCounts, ["migrated", "reviewed", "completed", "skipped"]);

  if (hasMigrationRemaining(db, opts.wave)) {
    process.stderr.write(`\n  ⚠ Some tasks still remain — migration did not finish all first-class artifacts.\n`);
    process.stderr.write(`    Run: node migration/registry/dist/cli.js show-blockers\n\n`);
  } else {
    console.log("\n  ✓ Migration complete\n");
  }
}
