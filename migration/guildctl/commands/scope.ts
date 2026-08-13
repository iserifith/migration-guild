import * as readline from "readline";
import type Database from "better-sqlite3";
import { printScopeMap } from "../dashboard";
import { requireNonEmptyRegistry } from "../readiness";
import { getModuleScopeSummary, recordScopeDecision } from "../../registry/commands/scope";

// ISSUE-68: scope gate. Runs after Inventory, before Plan. Reviews every
// module (grouped by artifacts.module) and records an explicit keep/drop
// decision, mirroring the confirmMappings human-confirmation gate in plan.ts.
export async function runScope(db: Database.Database): Promise<void> {
  requireNonEmptyRegistry(db, "scope");

  printScopeMap(db);

  const undecided = getModuleScopeSummary(db).filter((m) => m.decision === null && m.first_class_count > 0);
  if (undecided.length === 0) {
    process.stdout.write("\n  ✓ Every module already has a scope decision.\n");
    return;
  }

  if (process.env["GUILDCTL_AUTO_KEEP_SCOPE"] === "1") {
    for (const m of undecided) {
      recordScopeDecision(db, {
        module: m.module,
        decision: "keep",
        reason: "Auto-kept for benchmark run",
        decidedBy: "benchmark-runner",
      });
    }
    process.stdout.write(`\n  ✓ Auto-kept ${undecided.length} module(s) for benchmark\n`);
    return;
  }

  process.stdout.write(`\n  ${undecided.length} module(s) need a keep/drop decision before planning can proceed:\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>((res) => rl.question(q, res));

  for (const m of undecided) {
    process.stdout.write(
      `\n  ${m.module}  —  ${m.artifact_count} artifacts (${m.first_class_count} first-class, ${m.second_class_count} second-class)\n`,
    );
    if (m.depended_on_by.length > 0) {
      const dependents = m.depended_on_by.map((d) => `${d.module} (${d.edge_count})`).join(", ");
      process.stdout.write(`    ↳ depended on by: ${dependents}\n`);
    }

    let decided = false;
    while (!decided) {
      const answer = (await ask("  Keep or drop? [k]eep / [d]rop / [s]kip for now: ")).trim().toLowerCase();
      if (answer === "k" || answer === "keep") {
        const reason = (await ask("  Reason (optional, press enter to skip): ")).trim() || "Kept in scope";
        recordScopeDecision(db, { module: m.module, decision: "keep", reason, decidedBy: "operator" });
        process.stdout.write("  ✓ kept\n");
        decided = true;
      } else if (answer === "d" || answer === "drop") {
        let reason = "";
        while (!reason) {
          reason = (await ask("  Reason for dropping (required): ")).trim();
        }
        const result = recordScopeDecision(db, { module: m.module, decision: "drop", reason, decidedBy: "operator" });
        process.stdout.write(`  ✗ dropped — ${result.skippedArtifactIds.length} artifact(s) set to skipped\n`);
        if (result.inFlightArtifactIds.length > 0) {
          process.stdout.write(
            `    ⚠ ${result.inFlightArtifactIds.length} artifact(s) already past pending/planned/analyzed were left alone (not force-skipped)\n`,
          );
        }
        if (result.crossModuleWarnings.length > 0) {
          const dependents = result.crossModuleWarnings.map((d) => `${d.module} (${d.edge_count})`).join(", ");
          process.stdout.write(`    ⚠ other modules still import from "${m.module}": ${dependents}\n`);
        }
        decided = true;
      } else if (answer === "s" || answer === "skip" || answer === "") {
        process.stdout.write("  – left undecided, planning will remain blocked on this module\n");
        decided = true;
      }
    }
  }

  rl.close();
}
