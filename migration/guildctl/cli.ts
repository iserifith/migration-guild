#!/usr/bin/env node
import * as path from "path";
// Auto-load .env from project root (my-migration/) — works regardless of CWD
// so users don't need to `set -a && source .env && set +a` before every command.
import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: path.resolve(__dirname, "..", "..", "..", ".env"), quiet: true });

import { Command } from "commander";
import { getDb } from "../registry/db/connection";
import { assertDbExists } from "./util";
import { runInventory } from "./commands/inventory";
import { runPlan } from "./commands/plan";
import { runBootstrap } from "./commands/bootstrap";
import { runMigrate } from "./commands/migrate";
import { runReview } from "./commands/review";
import { runStatus, printNextSteps } from "./commands/status";
import { runWatch } from "./commands/watch";
import { runRelease } from "./commands/release";
import { runRemediate } from "./commands/remediate";
import { runEvidenceAdd, runEvidenceList } from "./commands/evidence";
import { runArbitrate } from "./commands/arbitrate";
import { runSocietyReport } from "./commands/society-report";
import { runBenchmarkCompare, runBenchmarkRecord, runBenchmarkReport } from "./commands/benchmark";
import { loadConfig, requireFoundryConfig } from "../foundry/config";
import { FoundryClient } from "../foundry/foundry-client";
import { registerTracingCommands } from "../foundry/tracing/commands";
import { registerBatchCommands } from "../foundry/batch/commands";
import { registerEvalCommands } from "../foundry/eval/commands";

const program = new Command();

program
  .name("guildctl")
  .description("guildctl — Migration Guild orchestrator")
  .version("0.1.0");

program.option("--db <path>", "Path to registry.db (overrides REGISTRY_DB env)");

const db = () => getDb(program.opts()["db"] as string | undefined);
const dbPath = () => program.opts()["db"] as string | undefined;

/** Lazily build a FoundryClient — only succeeds when foundry config is present. */
function getFoundryClient(): FoundryClient {
  const cfg = loadConfig();
  const foundry = requireFoundryConfig(cfg);
  return new FoundryClient(foundry);
}

// ─── inventory ────────────────────────────────────────────────────────────────

program
  .command("inventory")
  .description("Phase 1: Scan legacy Java files and register them in the registry")
  .action(async () => {
    await runInventory(db());
  });

// ─── plan ─────────────────────────────────────────────────────────────────────

program
  .command("plan")
  .description("Phase 2: Propose framework mappings, confirm them, and assign migration waves")
  .action(async () => {
    assertDbExists(dbPath());
    await runPlan(db());
  });

// ─── bootstrap ────────────────────────────────────────────────────────────────

program
  .command("bootstrap")
  .description("Phase 3: Scaffold the minimal target module in modern/")
  .action(async () => {
    assertDbExists(dbPath());
    await runBootstrap(db());
  });

// ─── migrate ──────────────────────────────────────────────────────────────────

program
  .command("migrate")
  .description("Phase 4: Migrate planned artifacts (TDD: tests first, then production code)")
  .option("-p, --parallel <n>", "Number of parallel migration sessions", parseInt)
  .option("-w, --wave <n>", "Only migrate artifacts in this wave number", parseInt)
  .action(async (opts) => {
    assertDbExists(dbPath());
    await runMigrate(db(), { parallel: opts.parallel, wave: opts.wave });
  });

// ─── review ───────────────────────────────────────────────────────────────────

program
  .command("review")
  .description("Phase 5: Review migrated files for correctness and flag rework")
  .option("-p, --parallel <n>", "Number of parallel review sessions", parseInt)
  .action(async (opts) => {
    assertDbExists(dbPath());
    await runReview(db(), { parallel: opts.parallel });
  });

// ─── status ───────────────────────────────────────────────────────────────────

program
  .command("status")
  .description("Print current migration status: wave plan, active sessions, status counts")
  .action(() => {
    assertDbExists(dbPath());
    runStatus(db());
  });

// ─── watch ────────────────────────────────────────────────────────────────────

program
  .command("watch")
  .description("Live dashboard: redraw every 2s showing status, waves, active sessions, recent events")
  .option("-i, --interval <ms>", "Refresh interval in milliseconds", parseInt)
  .action((opts) => {
    assertDbExists(dbPath());
    runWatch(db(), opts.interval);
  });

// ─── release ──────────────────────────────────────────────────────────────────

program
  .command("release")
  .description("Release stuck in-progress artifacts back to their pre-claim status")
  .option("--id <id>", "Release a single artifact by ID")
  .option("--all-stuck", "Release all artifacts stuck in-progress")
  .option("--older-than <mins>", "With --all-stuck: only release if claimed longer than N minutes", parseInt)
  .action(async (opts) => {
    assertDbExists(dbPath());
    await runRelease(db(), opts);
  });

// ─── remediate ───────────────────────────────────────────────────────────────

program
  .command("remediate")
  .description("Spawn remediation-agent to diagnose one exception and apply one safe registry-only recovery action")
  .option("--id <id>", "Target a specific artifact ID")
  .option("--timeout-mins <n>", "Remediation timeout in minutes", parseInt)
  .option("--model <name>", "Override model for remediation-agent")
  .option("--prompt <text>", "Override remediation prompt")
  .action(async (opts) => {
    assertDbExists(dbPath());
    await runRemediate(db(), {
      id: opts.id,
      timeoutMins: opts.timeoutMins,
      model: opts.model,
      prompt: opts.prompt,
    });
  });

// ─── evidence gate ────────────────────────────────────────────────────────────

const evidence = program
  .command("evidence")
  .description("Record and inspect proof submitted by Critics and evaluators");

evidence
  .command("add")
  .description("Record acceptance evidence for an artifact")
  .requiredOption("--artifact <id>", "Artifact ID")
  .requiredOption("--type <type>", "Evidence type: test-command | build-command | static-check | review-verdict | benchmark-result")
  .requiredOption("--produced-by <agent>", "Agent or role that produced the evidence")
  .option("--command <cmd>", "Command that produced this evidence")
  .option("--exit-code <n>", "Command exit code", parseInt)
  .option("--pass", "Mark evidence as passing")
  .option("--fail", "Mark evidence as failing")
  .requiredOption("--summary <text>", "Human-readable evidence summary")
  .option("--run-id <id>", "Associated run ID")
  .option("--output-path <path>", "Path to full evidence output")
  .option("--output-excerpt <text>", "Short output excerpt")
  .option("--json", "Print recorded evidence as JSON")
  .action(async (opts) => {
    assertDbExists(dbPath());
    await runEvidenceAdd(db(), opts);
  });

evidence
  .command("list")
  .description("List acceptance evidence for an artifact")
  .requiredOption("--artifact <id>", "Artifact ID")
  .option("--json", "Print evidence rows as JSON")
  .action((opts) => {
    assertDbExists(dbPath());
    runEvidenceList(db(), opts);
  });

program
  .command("arbitrate")
  .description("Approve or reject a migrated artifact from recorded evidence")
  .requiredOption("--artifact <id>", "Artifact ID")
  .option("--approve", "Approve artifact and promote it to reviewed")
  .option("--reject", "Reject artifact and move it to needs-rework")
  .requiredOption("--arbiter <agent>", "Independent arbiter agent or role")
  .requiredOption("--reason <text>", "Decision rationale")
  .option("--evidence <id...>", "Evidence IDs to attach to the decision")
  .option("--json", "Print arbitration decision as JSON")
  .action(async (opts) => {
    assertDbExists(dbPath());
    await runArbitrate(db(), opts);
  });


program
  .command("society-report")
  .description("Show judge-readable agent society proof: roles, dialogue, evidence, arbitration, efficiency")
  .option("--json", "Print report as JSON")
  .action((opts) => {
    assertDbExists(dbPath());
    runSocietyReport(db(), opts);
  });

const benchmark = program
  .command("benchmark")
  .description("Record, report, and compare single-agent vs guild benchmark runs");

benchmark
  .command("record")
  .description("Record a manual benchmark run")
  .requiredOption("--mode <mode>", "single-agent | guild")
  .requiredOption("--fixture <name>", "Fixture name")
  .requiredOption("--elapsed-ms <n>", "Elapsed runtime in milliseconds", parseInt)
  .requiredOption("--total-runs <n>", "Total agent/tool runs", parseInt)
  .requiredOption("--failed-runs <n>", "Failed agent/tool runs", parseInt)
  .requiredOption("--artifacts-planned <n>", "Artifacts planned", parseInt)
  .requiredOption("--artifacts-completed <n>", "Artifacts completed", parseInt)
  .requiredOption("--evidence-pass-rate <n>", "Evidence pass rate from 0 to 1", parseFloat)
  .requiredOption("--rework-count <n>", "Rework count", parseInt)
  .requiredOption("--verdict <verdict>", "pass | fail")
  .option("--total-cost-usd <n>", "Total cost in USD", parseFloat)
  .option("--notes <text>", "Notes")
  .option("--json", "Print recorded row as JSON")
  .action((opts) => {
    assertDbExists(dbPath());
    runBenchmarkRecord(db(), opts);
  });

benchmark
  .command("report")
  .description("List benchmark runs")
  .option("--mode <mode>", "Filter by mode")
  .option("--fixture <name>", "Filter by fixture")
  .option("--json", "Print rows as JSON")
  .action((opts) => {
    assertDbExists(dbPath());
    runBenchmarkReport(db(), opts);
  });

benchmark
  .command("compare")
  .description("Compare single-agent baseline against guild benchmark")
  .requiredOption("--baseline <id>", "single-agent benchmark ID")
  .requiredOption("--guild <id>", "guild benchmark ID")
  .option("--json", "Print comparison as JSON")
  .action((opts) => {
    assertDbExists(dbPath());
    runBenchmarkCompare(db(), opts);
  });

// ─── run ──────────────────────────────────────────────────────────────────────

program
  .command("run [phase]")
  .description("Run a phase: inventory | plan | bootstrap | migrate | review | remediate. No phase = show what to run next.")
  .option("-p, --parallel <n>", "Number of parallel sessions (migrate / review)", parseInt)
  .option("-w, --wave <n>", "Only migrate artifacts in this wave number (migrate only)", parseInt)
  .action(async (phase: string | undefined, opts) => {
    switch (phase) {
      case "inventory":
        await runInventory(db());
        break;
      case "plan":
        assertDbExists(dbPath());
        await runPlan(db());
        break;
      case "bootstrap":
        assertDbExists(dbPath());
        await runBootstrap(db());
        break;
      case "migrate":
        assertDbExists(dbPath());
        await runMigrate(db(), { parallel: opts.parallel, wave: opts.wave });
        break;
      case "review":
        assertDbExists(dbPath());
        await runReview(db(), { parallel: opts.parallel });
        break;
      case "remediate":
        assertDbExists(dbPath());
        await runRemediate(db());
        break;
      case undefined:
        printNextSteps(db());
        break;
      default:
        process.stderr.write(`\n  ✗ Unknown phase: "${phase}". Valid: inventory, plan, bootstrap, migrate, review, remediate\n\n`);
        process.exit(1);
    }
  });

// ─── search-similar ───────────────────────────────────────────────────────────

program
  .command("search-similar")
  .description("Find artifacts semantically similar to a query using stored embeddings (requires guildctl batch-submit --type embed)")
  .requiredOption("--query <text>", "Natural language or code query")
  .option("--top-k <n>", "Number of results to return (default: 5)", parseInt)
  .option("--min-score <f>", "Minimum cosine similarity threshold 0–1 (default: 0)", parseFloat)
  .action(async (opts) => {
    assertDbExists(dbPath());
    const { searchSimilar } = await import("../foundry/retrieval");
    const results = await searchSimilar(db(), getFoundryClient(), opts.query as string, {
      topK: (opts.topK as number | undefined) ?? 5,
      minScore: (opts.minScore as number | undefined) ?? 0,
    });
    process.stdout.write(JSON.stringify(results, null, 2) + "\n");
  });

// ─── Foundry: batch ───────────────────────────────────────────────────────────

registerBatchCommands(
  program,
  db,
  () => getFoundryClient(),
  () => requireFoundryConfig(loadConfig()),
);

// ─── Foundry: tracing / cost ──────────────────────────────────────────────────

registerTracingCommands(program, db);

// ─── Foundry: eval ────────────────────────────────────────────────────────────

registerEvalCommands(program, db, () => getFoundryClient());

program.parse();
