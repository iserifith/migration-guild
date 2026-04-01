import * as readline from "readline";
import type Database from "better-sqlite3";
import { spawnCopilot } from "../runner";
import { startPolling } from "../poller";
import { printPhaseHeader, printEvent, printWavePlan } from "../dashboard";
import { getLogDir } from "../util";

async function confirmMappings(
  db: Database.Database,
  mappings: ReturnType<typeof getMappings>
): Promise<void> {
  const unconfirmed = mappings.filter((m) => !m.confirmed);
  if (unconfirmed.length === 0) return;

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

export async function runPlan(db: Database.Database): Promise<void> {
  // ── Stack advisor ───────────────────────────────────────────────────────────
  printPhaseHeader("Phase 2a · Stack Advisor");
  console.log("  Agent: stack-advisor   Model: claude-sonnet-4.6\n");

  let stopPolling = startPolling(db, (events) => {
    for (const e of events) printEvent(e);
  });

  let code = await spawnCopilot({
    agent: "stack-advisor",
    model: "claude-sonnet-4.6",
    prompt: "Analyze all registered artifacts and propose a legacy→target framework mapping table.",
    db,
    logDir: getLogDir(),
  });

  stopPolling();

  if (code !== 0) {
    process.stderr.write(`\n  ✗ Stack advisor exited with code ${code}\n`);
    process.exit(code);
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

  // ── Planner ─────────────────────────────────────────────────────────────────
  printPhaseHeader("Phase 2b · Planner");
  console.log("  Agent: planner-agent   Model: claude-sonnet-4.6\n");

  stopPolling = startPolling(db, (events) => {
    for (const e of events) printEvent(e);
  });

  code = await spawnCopilot({
    agent: "planner-agent",
    model: "claude-sonnet-4.6",
    prompt: "Run planning: build the dependency graph and assign wave numbers to all pending artifacts.",
    db,
    logDir: getLogDir(),
  });

  stopPolling();
  printWavePlan(db);

  if (code !== 0) {
    process.stderr.write(`\n  ✗ Planner exited with code ${code}\n`);
    process.exit(code);
  }
  console.log("\n  ✓ Planning complete\n");
}
