#!/usr/bin/env node
import * as path from "path";
import * as fs from "fs";
import { execFileSync } from "child_process";
// Auto-load .env from the workspace root, regardless of CWD, so users don't
// need to `set -a && source .env && set +a`. Try several candidates: the
// current directory (where the user runs), plus the CLI install location for
// both source (migration/guildctl/cli.ts) and built (…/guildctl/dist) layouts.
// dotenv does not override already-set vars, so earlier candidates win.
import { config as dotenvConfig } from "dotenv";
for (const candidate of [
  path.resolve(process.cwd(), ".env"),
  path.resolve(__dirname, "..", "..", "..", ".env"),
  path.resolve(__dirname, "..", "..", ".env"),
]) {
  if (fs.existsSync(candidate)) dotenvConfig({ path: candidate, quiet: true });
}

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
import { runAuditCoverage, formatCoverageReport } from "./commands/audit";
import { runEvidenceAdd, runEvidenceList } from "./commands/evidence";
import { runArbitrate } from "./commands/arbitrate";
import { runSocietyReport } from "./commands/society-report";
import { runBenchmarkBaselineWorker, runBenchmarkCompare, runBenchmarkGuildReviewWorker, runBenchmarkGuildReworkWorker, runBenchmarkRecord, runBenchmarkReport, runBenchmarkRun } from "./commands/benchmark";
import {
  readGuildConfig,
  resolveGuildConfig,
  resolveWorkspaceRoot,
  scaffoldGuildConfig,
  setDottedPath,
  writeGuildConfig,
  stringifySimpleYaml,
} from "./config";
import { collectInitEvidence, createRunLedger, renderPrompt, scaffoldDefaultPrompts } from "./workspace";
import { checkHarness, resolveHarness } from "./harness";
import { detectStack, loadStackPack } from "./stack";

const program = new Command();

function isInsideGitWorkTree(root: string): boolean {
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() === "true";
  } catch {
    return false;
  }
}

program
  .name("guildctl")
  .description("guildctl — Migration Guild orchestrator")
  .version("0.1.0");

program.option("--db <path>", "Path to registry.db (overrides REGISTRY_DB env)");
program.option("--profile <name>", "Guild configuration profile to use", "default");
program.option("--workspace <path>", "Workspace root for migration phases (overrides cwd/.guild detection)");

// Bridge --workspace to GUILD_WORKSPACE before any command action runs, so the
// resolver (resolveWorkspaceRoot) and every cwd-defaulting helper agree on the
// same root without threading the flag through every signature.
program.hook("preAction", () => {
  const ws = program.opts()["workspace"] as string | undefined;
  if (ws) process.env.GUILD_WORKSPACE = path.resolve(ws);
});

// Resolve the active workspace root honoring --workspace / GUILD_WORKSPACE.
const workspaceRoot = () => resolveWorkspaceRoot({ workspace: program.opts()["workspace"] as string | undefined });

// `init` *creates* the workspace, so it can't rely on .guild detection or the
// CLI-install fallback — default to cwd, honoring an explicit --workspace/env.
const initRoot = () => {
  const flag = program.opts()["workspace"] as string | undefined;
  if (flag) return path.resolve(flag);
  if (process.env.GUILD_WORKSPACE) return path.resolve(process.env.GUILD_WORKSPACE);
  return process.cwd();
};

// ─── configurable Guild workspace ─────────────────────────────────────────────

program
  .command("init")
  .description("Scaffold .guild/config.yaml, prompt pack, runs, evidence, and .env.example")
  .option("--force", "Overwrite existing generated Guild config/prompts")
  .option("--stack <id>", "Select a stack pack instead of auto-detecting legacy/")
  .action((opts) => {
    const root = initRoot();
    const configPath = scaffoldGuildConfig(root, Boolean(opts.force));
    const stack = opts.stack ? loadStackPack(String(opts.stack), root).manifest.id : detectStack(root);
    const raw = readGuildConfig(configPath);
    raw["stack"] = stack;
    writeGuildConfig(raw, configPath);
    const cfg = resolveGuildConfig({ cwd: root, profile: program.opts()["profile"] as string | undefined });
    scaffoldDefaultPrompts(cfg);
    process.stdout.write(`✓ Guild config ready: ${configPath}\n`);
  });

program
  .command("config")
  .description("Print the resolved Guild config")
  .action(() => {
    const cfg = resolveGuildConfig({ cwd: workspaceRoot(), profile: program.opts()["profile"] as string | undefined });
    process.stdout.write(stringifySimpleYaml(cfg as unknown as Record<string, unknown>));
  });

program
  .command("config-set <key> <value>")
  .alias("config:set")
  .description("Set a dotted key in .guild/config.yaml")
  .action((key, value) => {
    const cfg = resolveGuildConfig({ cwd: workspaceRoot(), profile: "default" });
    const raw = readGuildConfig(cfg.configPath);
    setDottedPath(raw, key, value);
    writeGuildConfig(raw, cfg.configPath);
    process.stdout.write(`✓ Set ${key} in ${cfg.configPath}\n`);
  });

program
  .command("doctor")
  .description("Validate Guild config, OpenAI-compatible env, prompt pack, git, and run directories")
  .action(() => {
    const checks: Array<[boolean, string]> = [];
    let cfg;
    try {
      cfg = resolveGuildConfig({ cwd: workspaceRoot(), profile: program.opts()["profile"] as string | undefined });
      checks.push([true, `config loaded: ${cfg.configPath}`]);
    } catch (err) {
      process.stderr.write(`✗ ${(err as Error).message}\n`);
      process.exit(1);
    }
    checks.push([!!cfg.model.model, `model configured: ${cfg.model.model || "missing"}`]);
    try {
      const harnessCheck = checkHarness(resolveHarness(cfg, cfg.guildRoot));
      checks.push([harnessCheck.ok, harnessCheck.message]);
    } catch (err) {
      checks.push([false, (err as Error).message]);
    }
    checks.push([!cfg.model.api_key_env || !!process.env[cfg.model.api_key_env], cfg.model.api_key_env ? `${cfg.model.api_key_env} ${process.env[cfg.model.api_key_env] ? "present" : "missing"}` : "no API key env required"]);
    const promptPackPath = path.resolve(cfg.guildRoot, cfg.prompts.directory, cfg.prompts.active_pack);
    checks.push([fs.existsSync(promptPackPath), `prompt pack: ${promptPackPath}`]);
    const gitDetected = isInsideGitWorkTree(cfg.guildRoot);
    checks.push([
      gitDetected || !cfg.evidence.include_git_diff,
      gitDetected
        ? "git repo detected"
        : cfg.evidence.include_git_diff
          ? "git repo not detected; run git init or set evidence.include_git_diff false"
          : "git repo not detected; git diff evidence disabled",
    ]);
    fs.mkdirSync(path.join(cfg.guildRoot, ".guild", "runs"), { recursive: true });
    checks.push([fs.existsSync(path.join(cfg.guildRoot, ".guild", "runs")), "run ledger directory writable"]);
    for (const [ok, message] of checks) process.stdout.write(`${ok ? "✓" : "✗"} ${message}\n`);
    if (checks.some(([ok]) => !ok)) process.exit(1);
  });

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
  .option("--override-audit", "Proceed past open critical audit findings (logged as an override)")
  .action(async (opts) => {
    assertDbExists(dbPath());
    await runPlan(db(), { overrideAudit: Boolean(opts.overrideAudit) });
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

// ─── audit ───────────────────────────────────────────────────────────────────

const audit = program
  .command("audit")
  .description("Audit commands for coverage, completeness, and invariants");

audit
  .command("coverage")
  .description("Verify all files on disk are registered and all registered artifacts are in terminal state")
  .action(() => {
    assertDbExists(dbPath());
    const result = runAuditCoverage(db());
    const report = formatCoverageReport(result);
    process.stdout.write(report + "\n");
    if (result.onDiskNotRegistered.length > 0 || result.registeredMissingOnDisk.length > 0 || result.registeredNonTerminal.length > 0) {
      process.exit(1);
    }
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
  .command("run")
  .description("Execute a fixture as a single-agent baseline, guild pipeline, or both")
  .requiredOption("--fixture <id>", "Fixture ID (for example: legacy-customer-utils)")
  .option("--mode <mode>", "guild | baseline | both", "both")
  .action(async (opts) => {
    await runBenchmarkRun(db(), opts);
  });

benchmark
  .command("baseline-worker", { hidden: true })
  .action(async () => {
    await runBenchmarkBaselineWorker(db());
  });

benchmark.command("guild-review-worker", { hidden: true }).action(async () => {
  await runBenchmarkGuildReviewWorker(db());
});

benchmark.command("guild-rework-worker", { hidden: true }).action(async () => {
  await runBenchmarkGuildReworkWorker(db());
});

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
  .description("Run a phase: init | inventory | plan | bootstrap | migrate | review | remediate. init performs evidence mapping; legacy phases use registry.")
  .option("-p, --parallel <n>", "Number of parallel sessions (migrate / review)", parseInt)
  .option("-w, --wave <n>", "Only migrate artifacts in this wave number (migrate only)", parseInt)
  .action(async (phase: string | undefined, opts) => {
    switch (phase) {
      case "init": {
        const cfg = resolveGuildConfig({ cwd: initRoot(), profile: program.opts()["profile"] as string | undefined });
        scaffoldDefaultPrompts(cfg);
        const evidence = collectInitEvidence(cfg.guildRoot);
        const prompt = renderPrompt({ cfg, mode: "init", evidenceSummary: evidence.observedFacts.join("\n"), input: { phase } });
        const runDir = createRunLedger({ cfg, mode: "init", input: { phase }, prompt, evidence });
        process.stdout.write(`✓ Init evidence run recorded: ${runDir}\n`);
        process.stdout.write(`  Report: ${path.join(runDir, "report.md")}\n`);
        break;
      }
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
        process.stderr.write(`\n  ✗ Unknown phase: "${phase}". Valid: init, inventory, plan, bootstrap, migrate, review, remediate\n\n`);
        process.exit(1);
    }
  });


program.parse();
