#!/usr/bin/env node
import * as path from "path";
import * as fs from "fs";
import { execFileSync } from "child_process";
// Load .env from the workspace root, regardless of CWD, so users don't need to
// `set -a && source .env && set +a`. The workspace `<cwd>/.env` describes this
// checkout's runtime and wins over an inherited value (FR-020); the two
// CLI-install-relative candidates remain compatibility inputs that only fill
// variables nobody else defined. Candidate order is unchanged.
//
// This must stay at module scope, above the first command import, because
// several modules read the environment while being imported — a value applied
// after that point would be applied too late to be observed.
//
// `--ambient-env` is scanned straight out of raw argv here because no parser
// exists yet; Commander performs the authoritative parse below, and a `.env`
// file can never set the mode that decides its own precedence.
import { hasAmbientEnvFlag, loadGuildEnvironment } from "./env";
loadGuildEnvironment({
  cwd: process.cwd(),
  ambientFlag: hasAmbientEnvFlag(process.argv),
});

import { Command } from "commander";
import { getDb } from "../registry/db/connection";
import { RegistryError } from "../registry/types";
import { assertDbExists, gitEnv } from "./util";
import { runInventory } from "./commands/inventory";
import { runScope } from "./commands/scope";
import { runPlan } from "./commands/plan";
import { PlanInvariantError } from "./commands/plan";
import { runBootstrap } from "./commands/bootstrap";
import { runMigrate } from "./commands/migrate";
import { runIngestDocs } from "./commands/ingest-docs";
import { getIndexDb } from "../index-db/connection";
import { IndexDbError } from "../index-db/commands/entries";
import { runReview } from "./commands/review";
import { runStatus, printNextSteps } from "./commands/status";
import { runRelease } from "./commands/release";
import { runRemediate } from "./commands/remediate";
import { runRepair } from "./commands/repair";
import { runAuditCoverage, formatCoverageReport } from "./commands/audit";
import { runEvidenceAdd, runEvidenceList } from "./commands/evidence";
import { runVerifyCommand } from "./commands/verify";
import { runCaptureFixtureCommand } from "./commands/capture-fixture";
import { runAutoCommand } from "./commands/auto";
import { PreflightGateError, runAutoRunCommand } from "./commands/auto-run";
import { runArbitrate } from "./commands/arbitrate";
import { runApprove } from "./commands/approve";
import { runSocietyReport } from "./commands/society-report";
import { runBenchmarkBaselineWorker, runBenchmarkCompare, runBenchmarkGuildReviewWorker, runBenchmarkGuildReworkWorker, runBenchmarkRecord, runBenchmarkReport, runBenchmarkRun } from "./commands/benchmark";
import {
  readGuildConfig,
  resolveGuildConfig,
  resolveWorkspaceRoot,
  resolveRegistryDbPath,
  registryPathWarning,
  scaffoldGuildConfig,
  setDottedPath,
  writeGuildConfig,
  stringifySimpleYaml,
} from "./config";
import { collectInitEvidence, createRunLedger, renderPrompt, scaffoldDefaultPrompts } from "./workspace";
import { preflightJson, renderPreflightReport, runPreflight } from "./preflight";
import { runPipelineStateChecks } from "./doctor";
import { detectStack, loadStackPack } from "./stack";
import { formatLimitDuration, KNOWN_LIMIT_PHASES, resolveEffectiveLimit, type EffectiveLimit } from "./limits";

const program = new Command();

function isInsideGitWorkTree(root: string): boolean {
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: gitEnv(),
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
// Declared so `--help` documents it and Commander accepts it; the loader above
// already acted on it, because precedence has to be decided before any module
// reads the environment.
program.option("--ambient-env", "Let inherited environment values win over the workspace .env (default: .env wins)");

// Bridge --workspace to GUILD_WORKSPACE before any command action runs, so the
// resolver (resolveWorkspaceRoot) and every cwd-defaulting helper agree on the
// same root without threading the flag through every signature.
program.hook("preAction", (_thisCommand, actionCommand) => {
  const flag = program.opts()["workspace"] as string | undefined;
  if (flag) process.env.GUILD_WORKSPACE = path.resolve(flag);
  if (!["init", "config", "config-set"].includes(actionCommand.name())) {
    const warning = registryPathWarning(dbPath(), workspaceRoot());
    if (warning) process.stderr.write(`${warning}\n`);
  }
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

// ─── preflight ────────────────────────────────────────────────────────────────

const preflightOffline = (flag: unknown) => Boolean(flag) || process.env.GUILD_PREFLIGHT_OFFLINE === "1";

program
  .command("preflight")
  .description("Validate the runtime path a phase run would take: resolve it, then prove the provider answers")
  .option("--offline", "Perform no live call; report live-dependent results as unvalidated")
  .option("--json", "Print the preflight result as JSON")
  .option("--budget-seconds <n>", "Override the shared preflight budget for this invocation", parseFloat)
  .action(async (opts) => {
    const cfg = resolveGuildConfig({ cwd: workspaceRoot(), profile: program.opts()["profile"] as string | undefined });
    const result = await runPreflight({
      config: cfg,
      root: cfg.guildRoot,
      offline: preflightOffline(opts.offline),
      budgetSeconds: opts.budgetSeconds,
    });
    process.stdout.write(opts.json
      ? `${JSON.stringify(preflightJson(result), null, 2)}\n`
      : renderPreflightReport(result));
    // `unvalidated` is a deliberate operator choice, so it exits 0 — the
    // verdict string, not the exit code, is what keeps it out of a green tick.
    if (result.verdict === "fail") process.exit(1);
  });

program
  .command("doctor")
  .description("Validate Guild config, the resolved runtime path, prompt pack, git, and run directories")
  .option("--offline", "Run preflight without a live call; the runtime path reports as unvalidated")
  .action(async (opts) => {
    const checks: Array<[boolean, string]> = [];
    let cfg;
    try {
      cfg = resolveGuildConfig({ cwd: workspaceRoot(), profile: program.opts()["profile"] as string | undefined });
      checks.push([true, `config loaded: ${cfg.configPath}`]);
    } catch (err) {
      process.stderr.write(`✗ ${(err as Error).message}\n`);
      process.exit(1);
    }
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

    // The former model / harness / credential ticks are one delegated preflight,
    // so a green doctor means a validated runtime path — and an offline doctor
    // reports `unvalidated` instead of a tick it has not earned.
    process.stdout.write("\nRuntime path:\n");
    const preflight = await runPreflight({
      config: cfg,
      root: cfg.guildRoot,
      offline: preflightOffline(opts.offline),
    });
    process.stdout.write(renderPreflightReport(preflight));

    let stateFailed = false;
    try {
      process.stdout.write("\nPipeline state:\n");
      const stateChecks = runPipelineStateChecks({ db: db(), workspaceRoot: workspaceRoot(), config: cfg });
      for (const check of stateChecks) {
        const icon = check.status === "pass" ? "✓" : check.status === "warn" ? "⚠" : "✗";
        process.stdout.write(`${icon} ${check.message}\n`);
      }
      stateFailed = stateChecks.some((check) => check.status === "fail");
    } catch (err) {
      stateFailed = true;
      process.stdout.write(`✗ pipeline-state checks failed to run: ${(err as Error).message}\n`);
    }

    if (checks.some(([ok]) => !ok) || preflight.verdict === "fail" || stateFailed) process.exit(1);
  });

// ─── limits ───────────────────────────────────────────────────────────────────

program
  .command("limits")
  .description("Report each phase's effective time limits, their sources, and the precedence order — before a run (unrelated to auto-run --limit, which bounds artifact count)")
  .option("--phase <phase>", "Only report this phase")
  .option("--json", "Print as JSON")
  .action((opts) => {
    const cfg = resolveGuildConfig({ cwd: workspaceRoot(), profile: program.opts()["profile"] as string | undefined });
    const phases = opts.phase ? [String(opts.phase)] : KNOWN_LIMIT_PHASES;
    const rows: EffectiveLimit[] = [];
    for (const phase of phases) {
      rows.push(resolveEffectiveLimit(phase, "ceiling", cfg, process.env));
      rows.push(resolveEffectiveLimit(phase, "inactivity", cfg, process.env));
    }
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ precedenceOrder: rows[0]?.precedenceOrder ?? [], limits: rows }, null, 2)}\n`);
      return;
    }
    process.stdout.write(
      `Precedence (first match wins): ${(rows[0]?.precedenceOrder ?? []).join(" → ")}\n\n`,
    );
    process.stdout.write(`${"phase".padEnd(14)} ${"kind".padEnd(12)} ${"effective".padEnd(10)} ${"knob".padEnd(30)} ${"source".padEnd(19)} floor\n`);
    for (const row of rows) {
      const floor = row.floorApplied ? `applied (requested ${formatLimitDuration(row.requestedValueMs)})` : "—";
      process.stdout.write(
        `${row.phase.padEnd(14)} ${row.kind.padEnd(12)} ${formatLimitDuration(row.effectiveValueMs).padEnd(10)} ${row.knob.padEnd(30)} ${row.source.padEnd(19)} ${floor}\n`,
      );
    }
  });

const dbPath = () => resolveRegistryDbPath({ explicitPath: program.opts()["db"] as string | undefined, workspaceRoot: workspaceRoot() });
const warnRegistryPathIfNeeded = () => {
  const warning = registryPathWarning(dbPath(), workspaceRoot());
  if (warning) process.stderr.write(`${warning}\n`);
};
const db = () => {
  warnRegistryPathIfNeeded();
  return getDb(dbPath(), workspaceRoot());
};


// ─── inventory ────────────────────────────────────────────────────────────────

program
  .command("inventory")
  .description("Phase 1: Scan legacy Java files and register them in the registry")
  .option("--batch-size <n>", "Artifacts per classification agent call (default 100; resumable)")
  .option("--resume", "Only classify artifacts still missing a classification (default behavior)", false)
  .action(async (opts) => {
    if (opts.batchSize) process.env["GUILDCTL_CLASSIFICATION_BATCH_SIZE"] = String(opts.batchSize);
    warnRegistryPathIfNeeded();
    assertDbExists(dbPath());
    await runInventory(db());
  });

// ─── plan ─────────────────────────────────────────────────────────────────────

program
  .command("plan")
  .description("Phase 2: Propose framework mappings, confirm them, and assign migration waves")
  .option("--override-audit", "Proceed past open critical audit findings (logged as an override)")
  .option("--retries <n>", "Re-run a phase that fails its post-run invariant, injecting failure context", parseInt)
  .option("--enforce-invariants", "Verify the registry actually changed after each phase (don't trust agent exit 0)", false)
  .action(async (opts) => {
    assertDbExists(dbPath());
    try {
      await runPlan(db(), {
        overrideAudit: Boolean(opts.overrideAudit),
        retries: opts.retries ?? 0,
        enforceInvariants: opts.enforceInvariants === true || opts.enforceInvariants === "true",
      });
    } catch (error) {
      if (error instanceof PlanInvariantError) {
        process.stderr.write(`
  ✗ Planning failed invariant verification: ${error.message}
`);
        process.exit(1);
      }
      throw error;
    }
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

// ─── ingest-docs (007-doc-rag-lookup, US3) ────────────────────────────────────

program
  .command("ingest-docs")
  .description("Populate .guild/index.db with version-pinned documentation for the confirmed locked 'keep' set (007-doc-rag-lookup, FR-003/FR-005)")
  .requiredOption("--triggered-by <actor>", "Operator or authorized automation actor identity")
  .option("--library <name>", "Restrict this run to one library (targeted re-ingest after a single version change)")
  .action(async (opts) => {
    const indexDb = getIndexDb();
    try {
      const report = await runIngestDocs(db(), indexDb, {
        triggeredBy: opts.triggeredBy,
        library: opts.library,
      });
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    } catch (error) {
      if (error instanceof IndexDbError) {
        process.stderr.write(`\n  ✗ ${error.message}\n\n`);
        process.exit(1);
      }
      throw error;
    }
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
  .action(async (opts) => {
    assertDbExists(dbPath());
    // watch reads GUILDCTL_STALL_MINS at module scope; load it only after the
    // bootstrap environment loader has run.
    const { runWatch } = await import("./commands/watch");
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

// ─── repair ───────────────────────────────────────────────────────────────────

program
  .command("repair")
  .description("Recover from crash or interrupted migration: reap dead runs, release stale claims, prepare to continue")
  .option("--dry-run", "Show what would be repaired without making any changes")
  .option("-w, --wave <n>", "Only repair artifacts in this wave", parseInt)
  .option("--no-release-stuck", "Do not force-release in-progress artifacts (only reconcile stale claims)")
  .option("--older-than <mins>", "Only release stuck artifacts older than N minutes", parseInt)
  .action((opts) => {
    assertDbExists(dbPath());
    runRepair(db(), {
      dryRun: opts.dryRun === true,
      wave: opts.wave,
      releaseAllStuck: opts.releaseStuck !== false,
      olderThanMins: opts.olderThan,
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
  .requiredOption("--type <type>", "Evidence type: test-command | build-command | static-check | review-verdict | benchmark-result (for characterization-fixture, use `guildctl capture-fixture` instead)")
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
  .command("verify")
  .description("Run configured runtime verification commands and record verifier-owned evidence")
  .requiredOption("--artifact <id>", "Artifact ID")
  .option("--command <cmd...>", "Verification command(s); repeat or separate with ;;")
  .option("--json", "Print verification result as JSON")
  .action(async (opts) => {
    assertDbExists(dbPath());
    await runVerifyCommand(db(), opts);
  });

program
  .command("capture-fixture")
  .description("Run an already-passing legacy test seam and record its input/output as characterization-fixture evidence")
  .requiredOption("--artifact <id>", "Artifact ID")
  .requiredOption("--seam <name>", "Identifier for the test seam being invoked")
  .requiredOption("--command <cmd>", "The already-passing unit/invocation-level test command to run")
  .option("--json", "Print the captured fixture (or skip reason) as JSON")
  .action(async (opts) => {
    assertDbExists(dbPath());
    await runCaptureFixtureCommand(db(), opts);
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
  .option("--run-id <id>", "Existing run the evidence was produced under (approve only)")
  .option("--operator-token <token>", "Run operator credential for --run-id (approve only)")
  .option("--json", "Print arbitration decision as JSON")
  .action(async (opts) => {
    assertDbExists(dbPath());
    try {
      await runArbitrate(db(), opts);
    } catch (err) {
      if (err instanceof RegistryError) {
        // US1 (#153): a credential/independence failure is an expected operator
        // error, not a crash — one clean line, non-zero exit, no stack trace.
        process.stderr.write(`\n✗ ${err.message}\n\n`);
        process.exit(1);
      }
      throw err;
    }
  });

program
  .command("approve")
  .description("List artifacts held at pending-approval, or record the human approve/reject decision that releases one")
  .argument("[artifact]", "Artifact ID to approve or reject (omit with --list)")
  .option("--list", "List artifacts currently awaiting approval")
  .option("--reject", "Reject the artifact (default is approve)")
  .option("--reason <text>", "Rejection rationale (required with --reject)")
  .option("--run-id <id>", "Existing run to bind the decision to")
  .option("--operator-token <token>", "Run operator credential for --run-id")
  .option("--json", "Print the pending list or recorded decision as JSON")
  .action(async (artifact, opts) => {
    assertDbExists(dbPath());
    try {
      await runApprove(db(), { ...opts, artifact });
    } catch (err) {
      if (err instanceof RegistryError) {
        // US2 (spec 013): a gate/independence/reason refusal is an expected
        // operator error, not a crash — one clean line, non-zero exit, no
        // stack trace (same boundary shape as arbitrate above).
        process.stderr.write(`\n✗ ${err.message}\n\n`);
        process.exit(1);
      }
      throw err;
    }
  });

program
  .command("auto")
  .description("Run one artifact through migrate, verify, repair, and reverify under a bounded supervisor")
  .requiredOption("--artifact <id>", "Artifact ID")
  .option("--command <cmd...>", "Verification command(s); repeat or separate with ;;")
  .option("--max-attempts <n>", "Maximum migrate/repair attempts", parseInt)
  .option("--resume", "Resume the artifact from persisted verifier/arbitration state")
  .option("--json", "Print supervisor result as JSON")
  .action(async (opts) => {
    assertDbExists(dbPath());
    try {
      await runAutoCommand(db(), { ...opts, registryDbPath: dbPath() });
    } catch (err) {
      if (err instanceof RegistryError) {
        // US3 (#155): a resume/claim refusal is an expected operator error, not
        // a crash — one clean line, non-zero exit, no stack trace.
        process.stderr.write(`\n✗ ${err.message}\n\n`);
        process.exit(1);
      }
      throw err;
    }
  });

program
  .command("auto-run")
  .description("Process dependency-ready artifacts sequentially through the bounded autonomous supervisor")
  .option("--command <cmd...>", "Verification command(s); repeat or separate with ;;")
  .option("--max-attempts <n>", "Maximum migrate/repair attempts per artifact", parseInt)
  .option("-w, --wave <n>", "Only process artifacts in this wave", parseInt)
  .option("--limit <n>", "Stop cleanly after processing N artifacts", parseInt)
  .option("--no-resume", "Do not resume migrated crash states before dispatching new planned work")
  .option("--json", "Print one final queue result as JSON")
  .action(async (opts) => {
    assertDbExists(dbPath());
    try {
      await runAutoRunCommand(db(), { ...opts, registryDbPath: dbPath() });
    } catch (err) {
      if (!(err instanceof PreflightGateError)) throw err;
      // The runtime path is not known good, so nothing was claimed. Report it
      // as the gate it is, not as a crash.
      process.stderr.write(`\n✗ ${err.message}\n  Run \`guildctl preflight\` for the resolved path.\n\n`);
      process.exit(1);
    }
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
  .description("Run a phase: init | inventory | scope | plan | bootstrap | migrate | review | remediate | repair. init performs evidence mapping; legacy phases use registry.")
  .option("-p, --parallel <n>", "Number of parallel sessions (migrate / review)", parseInt)
  .option("-w, --wave <n>", "Only migrate artifacts in this wave number (migrate only)", parseInt)
  .action(async (phase: string | undefined, opts) => {
    try {
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
      case "scope":
        assertDbExists(dbPath());
        await runScope(db());
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
      case "repair":
        assertDbExists(dbPath());
        runRepair(db());
        break;
      case undefined:
        printNextSteps(db());
        break;
      default:
        process.stderr.write(`\n  ✗ Unknown phase: "${phase}". Valid: init, inventory, scope, plan, bootstrap, migrate, review, remediate, repair\n\n`);
        process.exit(1);
      }
    } catch (err) {
      process.stderr.write(`${(err as Error)?.message ?? String(err)}\n`);
      process.exitCode = 1;
    }
  });


program.parse();
