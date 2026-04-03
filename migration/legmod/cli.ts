#!/usr/bin/env node
import * as path from "path";
// Auto-load .env from project root (my-migration/) — works regardless of CWD
// so users don't need to `set -a && source .env && set +a` before every command.
import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: path.resolve(__dirname, "..", "..", "..", ".env") });

import { Command } from "commander";
import { getDb } from "../registry/db/connection";
import { assertDbExists } from "./util";
import { runInventory } from "./commands/inventory";
import { runPlan } from "./commands/plan";
import { runMigrate } from "./commands/migrate";
import { runReview } from "./commands/review";
import { runStatus, printNextSteps } from "./commands/status";
import { runWatch } from "./commands/watch";
import { runRelease } from "./commands/release";
import { loadConfig, requireFoundryConfig } from "../foundry/config";
import { FoundryClient } from "../foundry/foundry-client";
import { registerTracingCommands } from "../foundry/tracing/commands";
import { registerBatchCommands } from "../foundry/batch/commands";
import { registerEvalCommands } from "../foundry/eval/commands";

const program = new Command();

program
  .name("legmod")
  .description("legmod — Java migration orchestrator")
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

// ─── migrate ──────────────────────────────────────────────────────────────────

program
  .command("migrate")
  .description("Phase 3: Migrate planned artifacts (TDD: tests first, then production code)")
  .option("-p, --parallel <n>", "Number of parallel migration sessions", parseInt)
  .option("-w, --wave <n>", "Only migrate artifacts in this wave number", parseInt)
  .action(async (opts) => {
    assertDbExists(dbPath());
    await runMigrate(db(), { parallel: opts.parallel, wave: opts.wave });
  });

// ─── review ───────────────────────────────────────────────────────────────────

program
  .command("review")
  .description("Phase 4: Review migrated files for correctness and flag rework")
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

// ─── run ──────────────────────────────────────────────────────────────────────

program
  .command("run [phase]")
  .description("Run a phase: inventory | plan | migrate | review. No phase = show what to run next.")
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
      case "migrate":
        assertDbExists(dbPath());
        await runMigrate(db(), { parallel: opts.parallel, wave: opts.wave });
        break;
      case "review":
        assertDbExists(dbPath());
        await runReview(db(), { parallel: opts.parallel });
        break;
      case undefined:
        printNextSteps(db());
        break;
      default:
        process.stderr.write(`\n  ✗ Unknown phase: "${phase}". Valid: inventory, plan, migrate, review\n\n`);
        process.exit(1);
    }
  });

// ─── search-similar ───────────────────────────────────────────────────────────

program
  .command("search-similar")
  .description("Find artifacts semantically similar to a query using stored embeddings (requires legmod batch --type embed)")
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
