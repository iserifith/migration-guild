#!/usr/bin/env node
import { Command } from "commander";
import { getDb } from "../registry/db/connection";
import { assertDbExists } from "./util";
import { runInventory } from "./commands/inventory";
import { runPlan } from "./commands/plan";
import { runMigrate } from "./commands/migrate";
import { runReview } from "./commands/review";
import { runStatus } from "./commands/status";
import { runWatch } from "./commands/watch";
import { runAll } from "./commands/run";
import { runRelease } from "./commands/release";

const program = new Command();

program
  .name("legmod")
  .description("legmod — Java migration orchestrator")
  .version("0.1.0");

program.option("--db <path>", "Path to registry.db (overrides REGISTRY_DB env)");

const db = () => getDb(program.opts()["db"] as string | undefined);
const dbPath = () => program.opts()["db"] as string | undefined;

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
  .command("run")
  .description("Run the full pipeline: inventory → plan → migrate → review")
  .option("-p, --parallel <n>", "Number of parallel sessions for migrate and review phases", parseInt)
  .action(async (opts) => {
    await runAll(db(), { parallel: opts.parallel });
  });

program.parse();

