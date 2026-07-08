import * as readline from "readline";
import type Database from "better-sqlite3";
import { spawnAgent } from "../runner";
import type { AgentRunResult } from "../runner";
import { startPolling } from "../poller";
import { printPhaseHeader, printEvent, printWavePlan } from "../dashboard";
import { getLogDir } from "../util";
import { resolveGuildConfig, resolvePhaseModel, resolveWorkspaceRoot } from "../config";
import { setNext } from "../../registry/commands/operator";
import { setOperatorState } from "../../registry/commands/operator";
import { approveDependencyStrategy } from "../../registry/commands/modernization";
import { refreshCompatibilityAudits } from "../audit";
import { loadActiveStack, readStackInstruction } from "../stack";
import { evaluatePlanningReadiness, formatPlanningBlockMessage } from "../readiness";
import { formatInventoryValidationReport, loadClassificationSpec, validateInventoryQuality } from "../classification";

async function confirmMappings(
  db: Database.Database,
  mappings: ReturnType<typeof getMappings>
): Promise<void> {
  const unconfirmed = mappings.filter((m) => !m.confirmed);
  if (unconfirmed.length === 0) return;

  if (process.env["GUILDCTL_AUTO_CONFIRM_MAPPINGS"] === "1") {
    const confirm = db.prepare(`
      UPDATE stack_mappings SET confirmed = 1, confirmed_by = 'benchmark-runner', confirmed_at = datetime('now')
      WHERE id = ?
    `);
    for (const mapping of unconfirmed) confirm.run(mapping.id);
    process.stdout.write(`  ✓ Auto-confirmed ${unconfirmed.length} benchmark mapping(s)\n`);
    return;
  }

  console.log("\n  Proposed framework mappings — confirm each before planning proceeds:\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>((res) => rl.question(q, res));

  for (const m of unconfirmed) {
    const strategyHint = m.strategy ? ` (${m.strategy})` : "";
    process.stdout.write(`\n  ${m.legacy_framework.padEnd(30)} → ${m.target_framework}${strategyHint}\n`);
    if (m.notes) process.stdout.write(`  ${"\x1b[2m"}${m.notes}\x1b[0m\n`);

    let confirmed = false;
    while (!confirmed) {
      const answer = (await ask("  Confirm? [y]es / [n]o skip / [e]dit target: ")).trim().toLowerCase();
      if (answer === "y" || answer === "") {
        db.prepare(`
          UPDATE stack_mappings SET confirmed = 1, confirmed_by = 'operator', confirmed_at = datetime('now')
          WHERE id = ?
        `).run(m.id);
        process.stdout.write("  ✓ confirmed\n");
        confirmed = true;
      } else if (answer === "n") {
        process.stdout.write("  – skipped\n");
        confirmed = true;
      } else if (answer === "e") {
        const newTarget = (await ask("  New target framework: ")).trim();
        if (newTarget) {
          db.prepare(`
            UPDATE stack_mappings
            SET target_framework = ?, confirmed = 1, confirmed_by = 'operator', confirmed_at = datetime('now')
            WHERE id = ?
          `).run(newTarget, m.id);
          process.stdout.write(`  ✓ updated → ${newTarget}\n`);
          confirmed = true;
        }
      }
    }
  }

  rl.close();
}


function getMappings(db: Database.Database) {
  return db.prepare(`
    SELECT id, legacy_framework, target_framework, strategy, notes, confirmed
    FROM stack_mappings ORDER BY legacy_framework
  `).all() as Array<{
    id: string;
    legacy_framework: string;
    target_framework: string;
    strategy: string | null;
    notes: string | null;
    confirmed: number;
  }>;
}

interface PlanDeps {
  refreshCompatibilityAudits?: typeof refreshCompatibilityAudits;
  spawnAgent?: typeof spawnAgent;
  startPolling?: typeof startPolling;
  getLogDir?: typeof getLogDir;
  workspaceRoot?: string;
  // TASK-01: after each phase, verify the registry actually changed (don't
  // trust agent exit 0). Default false so callers/tests can opt in; the
  // production plan CLI enables it.
  enforceInvariants?: boolean;
  // TASK-01: re-run a phase that fails its invariant, injecting the failure
  // context into the retry prompt. Default 0 (no retry).
  retries?: number;
}

// TASK-01: a phase completed but the post-run registry invariant failed.
// Thrown (not process.exit) so the CLI boundary owns the exit code and tests
// can assert on it directly.
export class PlanInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanInvariantError";
  }
}

// ── TASK-01: post-phase registry invariant verification ──────────────────────
// An agent exiting 0 is NOT trusted. After each phase we verify the registry
// actually changed the way the phase promised. A hallucinated exit-0 (no writes)
// is treated as a phase failure — fed into --retries or a hard non-zero exit.

interface PhaseVerification {
  phase: string;
  agentExited: number;
  invariantPassed: boolean;
  message: string;
  at: string;
}

function recordPhaseVerification(
  db: Database.Database,
  phase: string,
  agentExited: number,
  invariantPassed: boolean,
  message: string,
): void {
  const entry: PhaseVerification = {
    phase,
    agentExited,
    invariantPassed,
    message,
    at: new Date().toISOString(),
  };
  setOperatorState(db, `plan_verification_${phase}`, entry);
}

function countRows(db: Database.Database, sql: string): number {
  return (db.prepare(sql).get() as { c: number }).c;
}

function verifyPlannerInvariant(db: Database.Database): { passed: boolean; message: string } {
  const total = countRows(db, "SELECT COUNT(*) c FROM artifacts");
  if (total === 0) return { passed: true, message: "no artifacts to assign waves to" };
  const nullWave = countRows(db, "SELECT COUNT(*) c FROM artifacts WHERE wave IS NULL");
  const assigned = total - nullWave;
  if (nullWave === 0) {
    return { passed: true, message: `all ${total} artifacts assigned to a wave` };
  }
  return {
    passed: false,
    message: `planner agent exited 0 but ${nullWave}/${total} artifacts still have wave = NULL (only ${assigned} assigned)`,
  };
}

function verifyStackAdvisorInvariant(
  db: Database.Database,
  baseline: number,
  inventoryNonEmpty: boolean,
): { passed: boolean; message: string } {
  const now = countRows(db, "SELECT COUNT(*) c FROM stack_mappings");
  if (!inventoryNonEmpty) {
    return { passed: true, message: "inventory empty — no mappings expected" };
  }
  if (now > baseline) {
    return { passed: true, message: `wrote ${now - baseline} new stack_mapping(s)` };
  }
  return {
    passed: false,
    message: `stack-advisor agent exited 0 but wrote 0 new stack_mappings (was ${baseline}, now ${now}) on a non-empty inventory`,
  };
}

interface PhaseRunResult {
  result: AgentRunResult;
  verified: { passed: boolean; message: string } | null;
}

async function runPhaseWithInvariant(opts: {
  db: Database.Database;
  runAgent: typeof spawnAgent;
  logDir: string;
  agent: string;
  model: string;
  phase: string;
  basePrompt: string;
  enforce: boolean;
  retries: number;
  verify: () => { passed: boolean; message: string };
  invariantLabel: string;
}): Promise<PhaseRunResult> {
  let prompt = opts.basePrompt;
  let retriesLeft = opts.retries;
  let result = await opts.runAgent({
    agent: opts.agent,
    model: opts.model,
    prompt,
    db: opts.db,
    logDir: opts.logDir,
    phase: opts.phase,
  });
  if (!opts.enforce) return { result, verified: null };

  let v = opts.verify();
  recordPhaseVerification(opts.db, opts.invariantLabel, result.exitCode, v.passed, v.message);

  while (!v.passed) {
    if (retriesLeft <= 0) {
      process.stderr.write(`\n  ✗ ${v.message}\n`);
      process.stderr.write(
        `    Known agent-hallucination failure mode: the ${opts.agent} agent exited ${result.exitCode} but the registry invariant failed.\n`,
      );
      process.stderr.write(`    Re-run planning with --retries to let the agent retry with failure context.\n`);
      throw new PlanInvariantError(v.message);
    }
    retriesLeft -= 1;
    process.stderr.write(
      `\n  ↻ ${opts.invariantLabel} invariant failed (${v.message}); retrying with failure context (${retriesLeft} retry left)\n`,
    );
    prompt = `${opts.basePrompt}\n\nPREVIOUS ATTEMPT FAILED its post-run invariant check: ${v.message}\nYou MUST make progress in the registry (call the actual write commands), not merely print a table and exit. Re-run and ensure every relevant row is written before exiting.`;
    result = await opts.runAgent({
      agent: opts.agent,
      model: opts.model,
      prompt,
      db: opts.db,
      logDir: opts.logDir,
      phase: opts.phase,
    });
    v = opts.verify();
    recordPhaseVerification(opts.db, opts.invariantLabel, result.exitCode, v.passed, v.message);
  }
  return { result, verified: v };
}

export async function runPlan(
  db: Database.Database,
  deps: PlanDeps = {},
): Promise<void> {
  const projectRoot = deps.workspaceRoot ?? resolveWorkspaceRoot();
  const cfg = resolveGuildConfig({ cwd: projectRoot });
  const planningModel = resolvePhaseModel("planning", cfg);
  const pack = loadActiveStack(cfg, projectRoot);
  const refreshAudits = deps.refreshCompatibilityAudits ?? refreshCompatibilityAudits;
  const runAgent = deps.spawnAgent ?? spawnAgent;
  const poll = deps.startPolling ?? startPolling;
  const logDir = (deps.getLogDir ?? getLogDir)();

  printPhaseHeader("Phase 2 · Planning readiness");
  const auditSummary = refreshAudits(db, projectRoot);
  const initialReadiness = evaluatePlanningReadiness(db);
  const jvmBlock = formatPlanningBlockMessage({
    ...initialReadiness,
    unresolvedDependencyFindings: [],
  });
  console.log(`  Pre-plan audit refreshed for ${auditSummary.artifact_count} artifact(s)`);
  console.log(`  JVM findings: critical=${auditSummary.jvm.critical}  warning=${auditSummary.jvm.warnings}`);
  console.log(`  Dependency findings: total=${auditSummary.dependencies.total}  unresolved=${auditSummary.dependencies.unresolved}\n`);

  const inventoryReport = validateInventoryQuality(db, loadClassificationSpec(pack), { workspaceRoot: projectRoot });
  if (!inventoryReport.valid) {
    const reportText = formatInventoryValidationReport(inventoryReport);
    setNext(db, {
      summary: "Inventory quality gate blocked planning.",
      reason: reportText,
      recommendedCommand: "node migration/registry/dist/cli.js batch-classify --file <json> --dry-run",
    });
    throw new Error(`Inventory quality gate blocked planning: ${inventoryReport.errors.join("; ")}`);
  }

  if (jvmBlock) {
    setNext(db, {
      summary: jvmBlock.summary,
      reason: jvmBlock.reason,
      recommendedCommand: jvmBlock.command,
    });
    process.stderr.write(`  ✗ ${jvmBlock.summary}\n`);
    process.stderr.write(`    ${jvmBlock.reason}\n`);
    process.stderr.write(`    Run: ${jvmBlock.command}\n\n`);
    process.exit(1);
  }

  if (initialReadiness.warningJvmFindings.length > 0) {
    console.log(`  ⚠ Warning-only JVM findings remain on ${new Set(initialReadiness.warningJvmFindings.map((finding) => finding.artifact_id)).size} artifact(s).`);
    console.log("    Planning may continue, but operators should record remediation notes before migration.\n");
  }

  // ── Stack advisor ───────────────────────────────────────────────────────────
  printPhaseHeader("Phase 2a · Stack Advisor");
  console.log(`  Agent: stack-advisor   Model: ${planningModel}\n`);

  const stackAdvisorBaseline = countRows(db, "SELECT COUNT(*) c FROM stack_mappings");
  const inventoryNonEmpty = countRows(db, "SELECT COUNT(*) c FROM artifacts") > 0;

  let stopPolling = poll(db, (events) => {
    for (const e of events) printEvent(e);
  });

  const stackAdvisorRun = await runPhaseWithInvariant({
    db,
    runAgent,
    logDir,
    agent: "stack-advisor",
    model: planningModel,
    phase: "planning",
    basePrompt: "Analyze all registered artifacts and propose a legacy→target framework mapping table.\n\n" + readStackInstruction(pack, "mappings"),
    enforce: deps.enforceInvariants ?? false,
    retries: deps.retries ?? 0,
    invariantLabel: "stack-advisor",
    verify: () => verifyStackAdvisorInvariant(db, stackAdvisorBaseline, inventoryNonEmpty),
  });
  const result = stackAdvisorRun.result;

  stopPolling();

  if (result.exitCode !== 0) {
    process.stderr.write(`\n  ✗ Stack advisor exited with code ${result.exitCode}\n`);
    process.exit(result.exitCode);
  }

  // ── Human confirmation gate ─────────────────────────────────────────────────
  const mappings = getMappings(db);
  if (mappings.length > 0) {
    console.log("\n  Proposed framework mappings:\n");
    for (const m of mappings) {
      const status = m.confirmed ? "✓ confirmed" : "  pending";
      console.log(`    ${status}  ${m.legacy_framework.padEnd(30)} → ${m.target_framework}${m.strategy ? `  (${m.strategy})` : ""}`);
    }

    const unconfirmed = mappings.filter((m) => !m.confirmed);
    if (unconfirmed.length > 0) {
      await confirmMappings(db, mappings);
    }
  }

  // Benchmark/non-interactive auto-approval of dependency strategies, mirroring
  // GUILDCTL_AUTO_CONFIRM_MAPPINGS — keeps the unattended guild pipeline moving
  // through the modernization gate the way an operator would.
  if (process.env["GUILDCTL_AUTO_APPROVE_DEPENDENCIES"] === "1") {
    const unresolved = evaluatePlanningReadiness(db).unresolvedDependencyFindings;
    for (const finding of unresolved) {
      const target = (finding.target_hint ?? "").trim();
      approveDependencyStrategy(db, {
        findingId: finding.finding_id,
        strategy: target ? "upgrade" : "remove",
        targetDependency: target || undefined,
        rationale: "Auto-approved for benchmark run",
        approvedBy: "benchmark-runner",
      });
    }
    if (unresolved.length) process.stdout.write(`  ✓ Auto-approved ${unresolved.length} dependency strategy(ies) for benchmark\n`);
  }

  const readiness = evaluatePlanningReadiness(db);
  const dependencyBlock = formatPlanningBlockMessage({
    ...readiness,
    blockingJvmFindings: [],
  });
  if (dependencyBlock) {
    setNext(db, {
      summary: dependencyBlock.summary,
      reason: dependencyBlock.reason,
      recommendedCommand: dependencyBlock.command,
    });
    process.stderr.write(`  ✗ ${dependencyBlock.summary}\n`);
    process.stderr.write(`    ${dependencyBlock.reason}\n`);
    process.stderr.write("    Approve each strategy with:\n");
    process.stderr.write("      node migration/registry/dist/cli.js approve-dependency-strategy --finding-id <id> --strategy <upgrade|replace|remove> --target-dependency <coord> --approved-by <name> --rationale <text>\n");
    process.stderr.write(`    Inspect open findings with: ${dependencyBlock.command}\n\n`);
    process.exit(1);
  }

  // ── Planner ─────────────────────────────────────────────────────────────────
  printPhaseHeader("Phase 2b · Planner");
  console.log(`  Agent: planner-agent   Model: ${planningModel}\n`);

  const plannerRun = await runPhaseWithInvariant({
    db,
    runAgent,
    logDir,
    agent: "planner-agent",
    model: planningModel,
    phase: "planning",
    basePrompt: "Run planning: build the dependency graph and assign wave numbers to all pending artifacts.",
    enforce: deps.enforceInvariants ?? false,
    retries: deps.retries ?? 0,
    invariantLabel: "planner",
    verify: () => verifyPlannerInvariant(db),
  });
  const plannerResult = plannerRun.result;

  stopPolling = poll(db, (events) => {
    for (const e of events) printEvent(e);
  });

  stopPolling();
  printWavePlan(db);

  if (plannerResult.exitCode !== 0) {
    process.stderr.write(`\n  ✗ Planner exited with code ${plannerResult.exitCode}\n`);
    process.exit(plannerResult.exitCode);
  }
  console.log("\n  ✓ Planning complete\n");
}
