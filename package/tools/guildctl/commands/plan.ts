import * as path from "path";
import * as readline from "readline";
import type Database from "better-sqlite3";
import { spawnAgent } from "../runner";
import { startPolling } from "../poller";
import { printPhaseHeader, printEvent, printWavePlan } from "../dashboard";
import { getLogDir } from "../util";
import { loadConfig, resolvePhaseModel } from "../config";
import { setNext } from "../../registry/commands/operator";
import { refreshCompatibilityAudits } from "../audit";
import { evaluatePlanningReadiness, formatPlanningBlockMessage } from "../readiness";

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
}

export async function runPlan(
  db: Database.Database,
  deps: PlanDeps = {},
): Promise<void> {
  const cfg = loadConfig();
  const planningModel = resolvePhaseModel("planning", cfg);
  const projectRoot = path.resolve(__dirname, "..", "..", "..");
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

  let stopPolling = poll(db, (events) => {
    for (const e of events) printEvent(e);
  });

  let result = await runAgent({
    agent: "stack-advisor",
    model: planningModel,
    prompt: "Analyze all registered artifacts and propose a legacy→target framework mapping table.",
    db,
    logDir,
    phase: "planning",
  });

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

  stopPolling = poll(db, (events) => {
    for (const e of events) printEvent(e);
  });

  result = await runAgent({
    agent: "planner-agent",
    model: planningModel,
    prompt: "Run planning: build the dependency graph and assign wave numbers to all pending artifacts.",
    db,
    logDir,
    phase: "planning",
  });

  stopPolling();
  printWavePlan(db);

  if (result.exitCode !== 0) {
    process.stderr.write(`\n  ✗ Planner exited with code ${result.exitCode}\n`);
    process.exit(result.exitCode);
  }
  console.log("\n  ✓ Planning complete\n");
}
