import * as readline from "readline";
import type Database from "better-sqlite3";
import { spawnAgent } from "../runner";
import type { AgentRunResult } from "../runner";
import { startPolling } from "../poller";
import { printPhaseHeader, printEvent, printScopeMap, printWavePlan } from "../dashboard";
import { getLogDir } from "../util";
import { resolveGuildConfig, resolvePhaseModel, resolveWorkspaceRoot } from "../config";
import { setNext } from "../../registry/commands/operator";
import { setOperatorState } from "../../registry/commands/operator";
import { approveDependencyStrategy } from "../../registry/commands/modernization";
import { getUndecidedModules, recordScopeDecision } from "../../registry/commands/scope";
import { refreshCompatibilityAudits } from "../audit";
import { loadActiveStack, readStackInstruction } from "../stack";
import { evaluatePlanningReadiness, formatPlanningBlockMessage, requireNonEmptyRegistry } from "../readiness";
import { collectDispositions } from "../dispositions";
import { confirmDisposition, listDispositions } from "../../registry/commands/dispositions";
import type { DependencyDisposition, DependencyDispositionKind } from "../../registry/types";
import { formatInventoryValidationReport, loadClassificationSpec, validateInventoryQuality } from "../classification";
import { resolveAndReportRuntime } from "../runtime-report";
import type { ResolvedRuntimeConfig } from "../harness";

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


// ─── Feature 005 US3: high-risk artifact confirmation gate ──────────────────

interface PendingRiskConfirmation {
  artifact_id: string;
  risk_score: number;
  reason_codes_json: string;
}

/**
 * Surfaces pending high-risk artifacts for an explicit operator decision after
 * the Planner phase. Mirrors confirmMappings' shape exactly (research.md §5):
 *  - GUILDCTL_AUTO_CONFIRM_RISK=1 bulk-confirms as 'benchmark-runner' (CI/benchmark bypass)
 *  - interactive TTY: y/n readline loop recording 'operator' decisions
 *  - non-interactive stdin with the env var unset: leave rows pending — the
 *    claim gate keeps them unclaimable (FR-012), the process does not hang.
 */
export async function confirmHighRiskArtifacts(db: Database.Database): Promise<void> {
  const pending = db.prepare(`
    SELECT rc.artifact_id, ra.risk_score, ra.reason_codes_json
    FROM risk_confirmations rc
    JOIN artifact_risk_assessments ra ON ra.artifact_id = rc.artifact_id
    WHERE rc.decision = 'pending'
    ORDER BY ra.risk_score DESC, rc.artifact_id
  `).all() as PendingRiskConfirmation[];
  if (pending.length === 0) return;

  if (process.env["GUILDCTL_AUTO_CONFIRM_RISK"] === "1") {
    const confirm = db.prepare(`
      UPDATE risk_confirmations SET decision = 'confirmed', decided_by = 'benchmark-runner', decided_at = datetime('now')
      WHERE artifact_id = ? AND decision = 'pending'
    `);
    for (const row of pending) confirm.run(row.artifact_id);
    process.stdout.write(`  ✓ Auto-confirmed ${pending.length} high-risk artifact(s) for migration\n`);
    return;
  }

  if (!process.stdin.isTTY) {
    process.stdout.write(
      `  ⚠ ${pending.length} high-risk artifact(s) pending human confirmation — held from migration (set GUILDCTL_AUTO_CONFIRM_RISK=1 to bulk-confirm in automation)\n`,
    );
    return;
  }

  console.log("\n  High-risk artifacts — confirm each before it can be claimed for migration:\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>((res) => rl.question(q, res));

  for (const row of pending) {
    const reasons = JSON.parse(row.reason_codes_json) as string[];
    process.stdout.write(`\n  ${row.artifact_id}  (risk score ${row.risk_score})\n`);
    for (const reason of reasons) process.stdout.write(`    ${"\x1b[2m"}${reason}${"\x1b[0m"}\n`);

    let decided = false;
    while (!decided) {
      const answer = (await ask("  Confirm for migration? [y]es / [n]o decline: ")).trim().toLowerCase();
      if (answer === "y" || answer === "") {
        db.prepare(`
          UPDATE risk_confirmations SET decision = 'confirmed', decided_by = 'operator', decided_at = datetime('now')
          WHERE artifact_id = ? AND decision = 'pending'
        `).run(row.artifact_id);
        process.stdout.write("  ✓ confirmed — claimable\n");
        decided = true;
      } else if (answer === "n") {
        db.prepare(`
          UPDATE risk_confirmations SET decision = 'declined', decided_by = 'operator', decided_at = datetime('now')
          WHERE artifact_id = ? AND decision = 'pending'
        `).run(row.artifact_id);
        process.stdout.write("  – declined — remains blocked\n");
        decided = true;
      }
    }
  }

  rl.close();
}

// ─── Feature 006 US2: dependency disposition confirmation gate ──────────────

/**
 * Surfaces unconfirmed dependency dispositions (status='proposed' OR a pending
 * re-proposal) for an explicit operator decision after the Planner phase.
 * Mirrors confirmMappings' prompt shape, extended with the override affordance
 * required by US2 (contracts/cli-surface.md "Plan-phase interactive flow"):
 *  - GUILDCTL_AUTO_CONFIRM_DISPOSITIONS=1 bulk-confirms every pending proposal
 *    and folds every pending re-proposal as 'benchmark-runner'
 *    (change_kind='auto-confirm').
 *  - interactive TTY: y/n/e readline loop; 'e' prompts for new kind/target/
 *    rationale, recorded as change_kind='override'.
 *  - non-interactive stdin with the env var unset: rows stay pending, a
 *    silence-first warning is printed, the process does NOT hang — the
 *    end-of-Plan disposition readiness gate (runPlan) blocks sign-off.
 */
export async function confirmDispositions(db: Database.Database): Promise<void> {
  const pending = listDispositions(db).filter(
    (row) => row.status === "proposed" || row.pending_disposition != null,
  );
  if (pending.length === 0) return;

  if (process.env["GUILDCTL_AUTO_CONFIRM_DISPOSITIONS"] === "1") {
    for (const row of pending) {
      confirmDisposition(db, {
        libraryName: row.library_name,
        confirmedBy: "benchmark-runner",
        autoConfirm: true,
      });
    }
    process.stdout.write(`  ✓ Auto-confirmed ${pending.length} dependency disposition(s) for benchmark\n`);
    return;
  }

  if (!process.stdin.isTTY) {
    process.stdout.write(
      `  ⚠ ${pending.length} dependency disposition(s) pending human confirmation — planning sign-off will be blocked (set GUILDCTL_AUTO_CONFIRM_DISPOSITIONS=1 to bulk-confirm in automation)\n`,
    );
    return;
  }

  console.log("\n  Proposed dependency dispositions — confirm each before planning sign-off:\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>((res) => rl.question(q, res));

  for (const row of pending) {
    printDispositionPrompt(row);

    let decided = false;
    while (!decided) {
      const isReProposal = row.status === "confirmed" && row.pending_disposition != null;
      const answer = (await ask(
        isReProposal
          ? "  Accept new disposition? [y]es / [n]o keep current / [e]dit: "
          : "  Confirm? [y]es / [n]o skip / [e]dit disposition: ",
      )).trim().toLowerCase();
      if (answer === "y" || answer === "") {
        confirmDisposition(db, { libraryName: row.library_name, confirmedBy: "operator" });
        process.stdout.write("  ✓ confirmed\n");
        decided = true;
      } else if (answer === "n") {
        process.stdout.write(isReProposal ? "  – current disposition kept\n" : "  – skipped (counts in the readiness gate)\n");
        decided = true;
      } else if (answer === "e") {
        const override = await promptDispositionOverride(ask);
        if (override) {
          confirmDisposition(db, {
            libraryName: row.library_name,
            confirmedBy: "operator",
            ...override,
          });
          process.stdout.write(`  ✓ updated → ${override.disposition}\n`);
          decided = true;
        }
      }
    }
  }

  rl.close();
}

function printDispositionPrompt(row: DependencyDisposition): void {
  const usage = row.usage_json
    ? (JSON.parse(row.usage_json) as { using_artifact_count?: number; scan_notes?: string[] })
    : null;
  const target = row.disposition === "replace-with-native"
    ? ` (${row.native_replacement})`
    : row.disposition === "inline"
      ? ` (${row.inline_note})`
      : row.locked_target_version
        ? ` @${row.locked_target_version}`
        : "";

  if (row.status === "confirmed" && row.pending_disposition != null) {
    const pendingTarget = row.pending_disposition === "replace-with-native"
      ? ` (${row.pending_native_replacement})`
      : row.pending_disposition === "inline"
        ? ` (${row.pending_inline_note})`
        : row.pending_locked_target_version
          ? ` @${row.pending_locked_target_version}`
          : "";
    process.stdout.write(
      `\n  ${row.library_name}   (confirmed: ${row.disposition}${target})  → NEW PROPOSAL: ${row.pending_disposition}${pendingTarget}\n`,
    );
    if (row.pending_rationale) process.stdout.write(`    ${"\x1b[2m"}Re-run evidence: ${row.pending_rationale}${"\x1b[0m"}\n`);
    return;
  }

  process.stdout.write(`\n  ${row.library_name}   → ${row.disposition}${target}\n`);
  if (usage?.using_artifact_count != null) {
    process.stdout.write(`    ${"\x1b[2m"}Used by ${usage.using_artifact_count} artifact(s).${"\x1b[0m"}\n`);
  }
  process.stdout.write(`    ${"\x1b[2m"}${row.rationale}${"\x1b[0m"}\n`);
}

const DISPOSITION_KIND_PROMPT = /^(keep|replace-with-native|inline)$/;

async function promptDispositionOverride(
  ask: (q: string) => Promise<string>,
): Promise<{
  disposition: DependencyDispositionKind;
  nativeReplacement?: string;
  inlineNote?: string;
  lockedTargetVersion?: string;
  rationale: string;
} | null> {
  const kindRaw = (await ask("  New disposition (keep | replace-with-native | inline): ")).trim();
  if (!DISPOSITION_KIND_PROMPT.test(kindRaw)) {
    process.stdout.write("  ✗ unknown disposition — leaving row unchanged\n");
    return null;
  }
  const disposition = kindRaw as DependencyDispositionKind;
  let nativeReplacement: string | undefined;
  let inlineNote: string | undefined;
  let lockedTargetVersion: string | undefined;
  if (disposition === "replace-with-native") {
    nativeReplacement = (await ask("  Native replacement (e.g. java.time): ")).trim();
    if (!nativeReplacement) {
      process.stdout.write("  ✗ native replacement is required — leaving row unchanged\n");
      return null;
    }
  } else if (disposition === "inline") {
    inlineNote = (await ask("  Inline note (what gets inlined where): ")).trim();
    if (!inlineNote) {
      process.stdout.write("  ✗ inline note is required — leaving row unchanged\n");
      return null;
    }
  } else {
    lockedTargetVersion = (await ask("  Locked target version: ")).trim();
    if (!lockedTargetVersion) {
      process.stdout.write("  ✗ locked target version is required for keep — leaving row unchanged\n");
      return null;
    }
  }
  const rationale = (await ask("  Rationale: ")).trim();
  if (!rationale) {
    process.stdout.write("  ✗ rationale is required — leaving row unchanged\n");
    return null;
  }
  return { disposition, nativeReplacement, inlineNote, lockedTargetVersion, rationale };
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
  overrideAudit?: boolean;
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
  if (now > 0) {
    return { passed: true, message: `reused ${now} existing stack_mapping(s)` };
  }
  return {
    passed: false,
    message: "stack-advisor agent exited 0 but no stack_mappings exist for a non-empty inventory",
  };
}

function hasUncoveredFrameworks(db: Database.Database): boolean {
  const row = db.prepare(`
    SELECT COUNT(*) AS c FROM (
      SELECT DISTINCT framework FROM artifact_classifications
      WHERE framework IS NOT NULL AND framework != ''
    ) f
    WHERE NOT EXISTS (
      SELECT 1 FROM stack_mappings m WHERE m.legacy_framework = f.framework
    )
  `).get() as { c: number };
  return row.c > 0;
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
  /** The phase-entry resolution; retries reuse it rather than resolving again. */
  resolution?: ResolvedRuntimeConfig;
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
    resolution: opts.resolution,
  });
  if (!opts.enforce) return { result, verified: null };

  let v = opts.verify();
  recordPhaseVerification(opts.db, opts.invariantLabel, result.exitCode, v.passed, v.message);

  while (!v.passed) {
    if (retriesLeft <= 0) {
      process.stderr.write(`
  ✗ ${v.message}
`);
      process.stderr.write(
        `    Known agent-hallucination failure mode: the ${opts.agent} agent exited ${result.exitCode} but the registry invariant failed.
`,
      );
      process.stderr.write(`    Re-run planning with --retries to let the agent retry with failure context.
`);
      throw new PlanInvariantError(v.message);
    }
    retriesLeft -= 1;
    process.stderr.write(
      `
  ↻ ${opts.invariantLabel} invariant failed (${v.message}); retrying with failure context (${retriesLeft} retry left)
`,
    );
    prompt = `${opts.basePrompt}

PREVIOUS ATTEMPT FAILED its post-run invariant check: ${v.message}
You MUST make progress in the registry (call the actual write commands), not merely print a table and exit. Re-run and ensure every relevant row is written before exiting.`;
    result = await opts.runAgent({
      agent: opts.agent,
      model: opts.model,
      prompt,
      db: opts.db,
      logDir: opts.logDir,
      phase: opts.phase,
      resolution: opts.resolution,
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
  requireNonEmptyRegistry(db, "plan");
  const projectRoot = deps.workspaceRoot ?? resolveWorkspaceRoot();
  const cfg = resolveGuildConfig({ cwd: projectRoot });
  const planningModel = resolvePhaseModel("planning", cfg);
  const pack = loadActiveStack(cfg, projectRoot);
  const refreshAudits = deps.refreshCompatibilityAudits ?? refreshCompatibilityAudits;
  const runAgent = deps.spawnAgent ?? spawnAgent;
  const poll = deps.startPolling ?? startPolling;
  const logDir = (deps.getLogDir ?? getLogDir)();

  printPhaseHeader("Phase 2 · Planning readiness");
  // FR-024: one resolution for the phase, reported before any agent starts and
  // reused by both the stack-advisor and planner runs.
  const runtime = resolveAndReportRuntime({ config: cfg, root: projectRoot, model: planningModel });
  const auditSummary = refreshAudits(db, projectRoot);

  // Benchmark/non-interactive auto-keep of undecided module scope, mirroring
  // GUILDCTL_AUTO_CONFIRM_MAPPINGS / GUILDCTL_AUTO_APPROVE_DEPENDENCIES.
  if (process.env["GUILDCTL_AUTO_KEEP_SCOPE"] === "1") {
    const undecidedModules = getUndecidedModules(db);
    for (const m of undecidedModules) {
      recordScopeDecision(db, {
        module: m.module,
        decision: "keep",
        reason: "Auto-kept for benchmark run",
        decidedBy: "benchmark-runner",
      });
    }
    if (undecidedModules.length) process.stdout.write(`  ✓ Auto-kept ${undecidedModules.length} module(s) in scope for benchmark\n`);
  }

  const initialReadiness = evaluatePlanningReadiness(db);
  // Disposition gate is end-of-Plan (T023) — mask it from all pre-Planner
  // block evaluations so freshly collected proposals never block wave
  // assignment mid-run (research.md §7).
  const scopeBlock = formatPlanningBlockMessage({
    ...initialReadiness,
    unconfirmedDispositions: [],
    blockingJvmFindings: [],
    unresolvedDependencyFindings: [],
  });
  const jvmBlock = formatPlanningBlockMessage({
    ...initialReadiness,
    unconfirmedDispositions: [],
    unresolvedDependencyFindings: [],
    unresolvedScopeModules: [],
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

  // ── Scope gate (ISSUE-68) ───────────────────────────────────────────────────
  // Every module needs an explicit keep/drop decision before planning — no
  // silent "keep by default." No --override flag: unlike the audit gates,
  // there's no sanctioned bypass, since a skipped decision here means an
  // artifact nobody reviewed flows straight into a migration wave.
  if (scopeBlock) {
    printScopeMap(db);
    setNext(db, {
      summary: scopeBlock.summary,
      reason: scopeBlock.reason,
      recommendedCommand: scopeBlock.command,
    });
    process.stderr.write(`\n  ✗ ${scopeBlock.summary}\n`);
    process.stderr.write(`    ${scopeBlock.reason}\n`);
    process.stderr.write(`    Run: ${scopeBlock.command}\n\n`);
    process.exit(1);
  }

  if (jvmBlock) {
    if (deps.overrideAudit) {
      setNext(db, {
        summary: "Pre-plan audit override applied (--override-audit).",
        reason: `Blocked by ${initialReadiness.blockingJvmFindings.length} critical compatibility finding(s); operator bypassed the gate.`,
        recommendedCommand: "node migration/registry/dist/cli.js findings list --severity critical",
      });
      process.stderr.write(`  ⚠ Pre-plan audit OVERRIDDEN via --override-audit (${initialReadiness.blockingJvmFindings.length} critical finding(s) bypassed).\n`);
    } else {
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

  let stopPolling: () => void = () => undefined;
  if (stackAdvisorBaseline > 0 && !hasUncoveredFrameworks(db)) {
    const verification = verifyStackAdvisorInvariant(db, stackAdvisorBaseline, inventoryNonEmpty);
    if (deps.enforceInvariants) {
      recordPhaseVerification(db, "stack-advisor", 0, verification.passed, verification.message);
    }
    console.log(`  ✓ ${verification.message}; skipping redundant advisor run\n`);
  } else {
    stopPolling = poll(db, (events) => {
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
      resolution: runtime,
    });
    const result = stackAdvisorRun.result;

    stopPolling();

    if (result.exitCode !== 0) {
      process.stderr.write(`\n  ✗ Stack advisor exited with code ${result.exitCode}\n`);
      process.exit(result.exitCode);
    }
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
    unconfirmedDispositions: [], // disposition gate is end-of-Plan (T023), not pre-Planner
    blockingJvmFindings: [],
    unresolvedScopeModules: [],
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

  // ── Dependency dispositions (006) — collector pass BEFORE the Planner ──────
  // Every declared library gets exactly one proposed disposition row; the
  // Planner agent only refines rows that already exist (plan.md Summary).
  {
    const summary = collectDispositions(db, pack, projectRoot);
    console.log(`  ✓ Dependency dispositions: ${summary.libraries.length} library(ies) proposed`);
    for (const note of summary.scan_notes) console.log(`    ⚠ ${note}`);
    for (const warning of summary.warnings) console.log(`    ⚠ ${warning}`);
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
    basePrompt: "Run planning: build the dependency graph and assign wave numbers to all pending artifacts. " +
      "Dependency disposition proposals already exist in the registry for every declared library; refine them where AST-level usage evidence supports a different disposition kind by running " +
      "`node migration/registry/dist/cli.js propose-disposition --library <group:artifact> --disposition <keep|replace-with-native|inline> --rationale <text> [--native-replacement <api>] [--inline-note <note>] [--locked-target-version <ver>]`. " +
      "Never invent a replacement to avoid a 'keep' outcome; missing evidence degrades toward keep.",
    enforce: deps.enforceInvariants ?? false,
    retries: deps.retries ?? 0,
    invariantLabel: "planner",
    verify: () => verifyPlannerInvariant(db),
    resolution: runtime,
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

  // Feature 005 US3: surface pending high-risk artifacts for explicit operator
  // confirmation — deliberately AFTER the Planner phase (research.md §5) so
  // pending high-risk work never blocks wave assignment for everything else.
  // Enforcement lives at the claim boundary (claim.ts), not here.
  await confirmHighRiskArtifacts(db);

  // Feature 006 US2: dependency disposition confirmation — also AFTER the
  // Planner phase (research.md §7), so pending proposals never block wave
  // assignment mid-run. The gate below keeps planning fail-closed: unconfirmed
  // rows block sign-off rather than being silently defaulted.
  await confirmDispositions(db);

  // End-of-Plan disposition readiness gate (mirrors the dependencyBlock gate
  // above): re-evaluate readiness and fail closed on unconfirmed dispositions.
  const finalReadiness = evaluatePlanningReadiness(db);
  const dispositionBlock = formatPlanningBlockMessage({
    ...finalReadiness,
    blockingJvmFindings: [],
    unresolvedScopeModules: [],
    unresolvedDependencyFindings: [],
  });
  if (dispositionBlock) {
    setNext(db, {
      summary: dispositionBlock.summary,
      reason: dispositionBlock.reason,
      recommendedCommand: dispositionBlock.command,
    });
    process.stderr.write(`  ✗ ${dispositionBlock.summary}\n`);
    process.stderr.write(`    ${dispositionBlock.reason}\n`);
    process.stderr.write(`    Run: ${dispositionBlock.command}\n\n`);
    process.exit(1);
  }
}
