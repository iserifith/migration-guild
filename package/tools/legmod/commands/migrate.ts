import type Database from "better-sqlite3";
import { spawnAgent } from "../runner";
import { startPolling } from "../poller";
import { printPhaseHeader, printEvent, printWavePlan } from "../dashboard";
import { getLogDir } from "../util";
import {
  getConfigPath,
  loadConfig,
  requirePhaseFoundryConfig,
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
import { needsBootstrap, runBootstrap } from "./bootstrap";

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
  parallel?: number;
  testParallel?: number;
  codeParallel?: number;
  wave?: number;
}

export function getMigrationFollowUp(
  db: Database.Database,
  wave?: number,
  hadFailures = false,
): { summary: string; command: string } {
  const analyzeQueue = getClaimabilityStats(db, "planned", wave);
  const testQueue = getClaimabilityStats(db, "analyzed", wave);
  const codeQueue = getClaimabilityStats(db, "tests-written", wave);
  const ready = analyzeQueue.ready + testQueue.ready + codeQueue.ready;
  const blocked = analyzeQueue.blocked + testQueue.blocked + codeQueue.blocked;
  const inProgress = Math.max(analyzeQueue.inProgress, testQueue.inProgress, codeQueue.inProgress);

  if (hadFailures) {
    return {
      summary: "One or more migration sessions failed before work could advance.",
      command: "node migration/registry/dist/cli.js list-runs --limit 20",
    };
  }

  if (inProgress > 0) {
    return {
      summary: "Some artifacts are still claimed and in progress.",
      command: "node migration/registry/dist/cli.js show-in-progress",
    };
  }

  if (ready > 0) {
    return {
      summary: "Artifacts are still claimable, but the last pass made no registry progress.",
      command: "node migration/registry/dist/cli.js list-runs --limit 20",
    };
  }

  if (blocked > 0) {
    return {
      summary: "Remaining artifacts are waiting on dependencies.",
      command: "node migration/registry/dist/cli.js wave-plan",
    };
  }

  return {
    summary: "Migration stopped with remaining artifacts, but no specific blocker was detected.",
    command: "node migration/registry/dist/cli.js status",
  };
}

export async function runMigrate(db: Database.Database, opts: MigrateOpts = {}): Promise<void> {
  if (needsBootstrap(db)) {
    console.log("  ↷ Target module not scaffolded — running bootstrap first.\n");
    await runBootstrap(db);
  }

  const analyzeParallel = Math.max(1, opts.testParallel ?? opts.parallel ?? 1);
  const testParallel = Math.max(1, opts.testParallel ?? opts.parallel ?? 1);
  const codeParallel = Math.max(1, opts.codeParallel ?? opts.parallel ?? 1);
  const waveLabel = opts.wave != null ? ` (wave ${opts.wave})` : "";
  const cfg = loadConfig();
  const analyzeModel = resolvePhaseModel("analysis", cfg.foundry);
  const testModel = resolvePhaseModel("test-writing", cfg.foundry);
  const codeModel = resolvePhaseModel("code-writing", cfg.foundry);
  const analyzeProvider = resolvePhaseProvider("analysis", cfg.foundry);
  const testProvider = resolvePhaseProvider("test-writing", cfg.foundry);
  const codeProvider = resolvePhaseProvider("code-writing", cfg.foundry);
  if (analyzeProvider === "foundry") requirePhaseFoundryConfig("analysis", cfg);
  if (testProvider === "foundry") requirePhaseFoundryConfig("test-writing", cfg);
  if (codeProvider === "foundry") requirePhaseFoundryConfig("code-writing", cfg);
  const configPath = getConfigPath();

  printPhaseHeader("Phase 4 · Migration");
  console.log(`  Pool 0 · Analyzers      Agent: analyze-agent       Model: ${analyzeModel}   Parallel: ${analyzeParallel}${waveLabel}`);
  console.log(`  Pool 1 · Test writers   Agent: test-writer-agent   Model: ${testModel}   Parallel: ${testParallel}${waveLabel}`);
  console.log(`  Pool 2 · Code writers   Agent: code-writer-agent   Model: ${codeModel}   Parallel: ${codeParallel}${waveLabel}\n`);
  printResolvedRuntime({
    phase: "analysis",
    provider: analyzeProvider,
    model: analyzeModel,
    configPath,
    batchEnabled: cfg.foundry?.batchEnabled,
    providerType: cfg.foundry?.providerType,
    endpoint: analyzeProvider === "foundry" ? cfg.foundry?.openaiEndpoint : undefined,
  });
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

  const analyzePrompt = opts.wave != null
    ? `Analyze next task from wave ${opts.wave}`
    : "Analyze next task";
  const testPrompt = opts.wave != null
    ? `Write tests for next analyzed task from wave ${opts.wave}`
    : "Write tests for next analyzed task";
  const codePrompt = opts.wave != null
    ? `Write production code for next tests-written task from wave ${opts.wave}`
    : "Write production code for next tests-written task";
  let pass = 1;
  let hadFailures = false;

  while (hasMigrationRemaining(db, opts.wave)) {
    console.log(`\n  Pass ${pass}`);

    process.stdout.write(`\n  [Pool 0] Spawning ${analyzeParallel} analyzer session(s)\n`);
    const analyzeQueueBefore = getClaimabilityStats(db, "planned", opts.wave);
    printQueueSnapshot("Analyze queue", analyzeQueueBefore);
    const beforeAnalyze = getStatusCounts(db, opts.wave);
    const analyzeResults = analyzeQueueBefore.total === 0
      ? []
      : await Promise.all(Array.from({ length: analyzeParallel }, () =>
          spawnAgent({ agent: "analyze-agent", model: analyzeModel, prompt: analyzePrompt, db, logDir: getLogDir(), phase: "analysis", releaseClaimsOnFailure: true })
        ));
    hadFailures ||= analyzeResults.some((result) => result.exitCode !== 0);
    const afterAnalyze = getStatusCounts(db, opts.wave);
    printPoolSummary({
      label: "Analyzers",
      results: analyzeResults,
      before: beforeAnalyze,
      after: afterAnalyze,
      advancedStatus: "analyzed",
      claimability: getClaimabilityStats(db, "planned", opts.wave),
    });
    printStaleSessionWarnings(db);

    process.stdout.write(`\n  [Pool 1] Spawning ${testParallel} test-writer session(s)\n`);
    const testQueueBefore = getClaimabilityStats(db, "analyzed", opts.wave);
    printQueueSnapshot("Test queue", testQueueBefore);
    const beforeTests = getStatusCounts(db, opts.wave);
    const testResults = testQueueBefore.total === 0
      ? []
      : await Promise.all(Array.from({ length: testParallel }, () =>
          spawnAgent({ agent: "test-writer-agent", model: testModel, prompt: testPrompt, db, logDir: getLogDir(), phase: "test-writing", releaseClaimsOnFailure: true })
        ));
    hadFailures ||= testResults.some((result) => result.exitCode !== 0);
    const afterTests = getStatusCounts(db, opts.wave);
    printPoolSummary({
      label: "Test writers",
      results: testResults,
      before: beforeTests,
      after: afterTests,
      advancedStatus: "tests-written",
      claimability: getClaimabilityStats(db, "analyzed", opts.wave),
    });
    printStaleSessionWarnings(db);

    process.stdout.write(`\n  [Pool 2] Spawning ${codeParallel} code-writer session(s)\n`);
    const codeQueueBefore = getClaimabilityStats(db, "tests-written", opts.wave);
    printQueueSnapshot("Code queue", codeQueueBefore);
    const beforeCode = getStatusCounts(db, opts.wave);
    const codeResults = codeQueueBefore.total === 0
      ? []
      : await Promise.all(Array.from({ length: codeParallel }, () =>
          spawnAgent({ agent: "code-writer-agent", model: codeModel, prompt: codePrompt, db, logDir: getLogDir(), phase: "code-writing", releaseClaimsOnFailure: true })
        ));
    hadFailures ||= codeResults.some((result) => result.exitCode !== 0);
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

    const progressMade = statusCountsChanged(beforeAnalyze, afterCode);
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
    const followUp = getMigrationFollowUp(db, opts.wave, hadFailures);
    process.stderr.write(`\n  ⚠ Some tasks still remain — migration did not finish all first-class artifacts.\n`);
    process.stderr.write(`    ${followUp.summary}\n`);
    process.stderr.write(`    Run: ${followUp.command}\n\n`);
  } else {
    console.log("\n  ✓ Migration complete\n");
  }
}
