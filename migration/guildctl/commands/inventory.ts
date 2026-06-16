import * as fs from "fs";
import * as path from "path";
import type Database from "better-sqlite3";
import { spawnAgent } from "../runner";
import { startPolling } from "../poller";
import { printPhaseHeader, printEvent, printStatusSummary } from "../dashboard";
import { getLogDir } from "../util";
import {
  loadConfig,
  requireFoundryConfig,
  resolvePhaseModel,
  resolvePhaseProvider,
} from "../../foundry/config";
import { FoundryClient } from "../../foundry/foundry-client";
import { submitBatch } from "../../foundry/batch/submit";
import { waitForBatch } from "../../foundry/batch/poll";
import { applyInventoryResults } from "../../foundry/batch/apply";
import { registerArtifact } from "../../registry/commands/artifacts";
import { setNext } from "../../registry/commands/operator";
import { applySchema } from "../../registry/db/schema";
import { refreshCompatibilityAudits } from "../audit";
import { evaluatePlanningReadiness, formatPlanningBlockMessage } from "../readiness";

// ─── File scanner ────────────────────────────────────────────────────────────

function findJavaFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...findJavaFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".java")) results.push(full);
  }
  return results;
}

/** Derive artifact id from a legacy .java path.
 *  Format: legacy-source:<module>:<ClassName>
 *  e.g.  legacy-source:com.example.util:StringUtils
 */
function deriveArtifactId(filePath: string, legacyRoot: string): string {
  const rel = path.relative(legacyRoot, filePath); // e.g. src/main/java/com/example/Foo.java
  const noExt = rel.replace(/\.java$/, "");
  const parts = noExt.split(path.sep);
  const className = parts[parts.length - 1];

  // Drop leading src/main/java or src/test/java segments if present
  const javaIdx = parts.findIndex(
    (p, i) => p === "java" && i > 0 && parts[i - 1] === "main",
  );
  const pkgParts = javaIdx >= 0 ? parts.slice(javaIdx + 1, -1) : parts.slice(0, -1);
  const module = pkgParts.join(".") || "default";

  return `legacy-source:${module}:${className}`;
}

/** Register all .java files in legacy/ that aren't already in the DB. */
function scanAndRegister(db: Database.Database, projectRoot: string): number {
  const legacyDir = path.join(projectRoot, "legacy");
  process.stdout.write(`  [scan] projectRoot : ${projectRoot}\n`);
  process.stdout.write(`  [scan] legacyDir   : ${legacyDir}\n`);
  process.stdout.write(`  [scan] legacyDir exists: ${fs.existsSync(legacyDir)}\n`);

  const files = findJavaFiles(legacyDir);
  process.stdout.write(`  [scan] .java files found: ${files.length}\n`);

  // Show DB filename so we know which file is being written
  const dbFilename = (db as unknown as { name?: string }).name ?? "(unknown)";
  process.stdout.write(`  [scan] DB file     : ${dbFilename}\n\n`);

  let registered = 0;
  let skipped = 0;

  for (const file of files) {
    const id = deriveArtifactId(file, legacyDir);
    const exists = db.prepare("SELECT id FROM artifacts WHERE id = ?").get(id);
    if (exists) { skipped++; continue; }

    const relPath = path.relative(projectRoot, file);
    try {
      registerArtifact(db, { id, kind: "legacy-source", path: relPath });
      registered++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("already registered")) {
        process.stderr.write(`  [warn] Could not register ${id}: ${msg}\n`);
      } else {
        skipped++;
      }
    }
  }

  process.stdout.write(`  [scan] registered: ${registered}  skipped (already exist): ${skipped}\n`);

  // Verify the count is actually in the DB right now
  const actual = (db.prepare("SELECT COUNT(*) as n FROM artifacts").get() as { n: number }).n;
  process.stdout.write(`  [scan] DB artifacts count after insert: ${actual}\n\n`);

  return registered;
}

// ─── Batch path (Foundry) ────────────────────────────────────────────────────

async function runInventoryBatch(db: Database.Database): Promise<void> {
  const cfg = loadConfig();
  const foundry = requireFoundryConfig(cfg);
  const client = new FoundryClient(foundry);

  process.stdout.write("  Provider: foundry (batch)\n\n");

  const job = await submitBatch(db, client, foundry, "inventory");
  process.stdout.write(`  Batch job submitted: ${job.job_id} — waiting for completion…\n`);

  const completed = await waitForBatch(db, client, job.job_id);
  if (completed.status === "failed") {
    process.stderr.write(`\n  ✗ Foundry batch job failed: ${completed.job_id}\n`);
    process.exit(1);
  }

  await applyInventoryResults(db, client, completed);
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function runInventory(db: Database.Database): Promise<void> {
  printPhaseHeader("Phase 1 · Inventory");

  // Ensure schema exists (idempotent)
  applySchema(db);

  // Always resolve project root from __dirname (migration/guildctl/dist → my-migration/)
  const projectRoot = path.resolve(__dirname, "..", "..", "..");

  // Step 1: scan legacy/ and register all .java files directly — no agent needed
  process.stdout.write("  Scanning legacy/ for Java files…\n");
  const count = scanAndRegister(db, projectRoot);
  process.stdout.write(`  ✓ ${count} file(s) registered\n\n`);

  const stopPolling = startPolling(db, (events) => {
    for (const e of events) printEvent(e);
  });

  const cfg = loadConfig();
  const inventoryProvider = resolvePhaseProvider("inventory", cfg.foundry);

  if (inventoryProvider === "foundry" && cfg.foundry?.batchEnabled) {
    // Step 2a: Foundry batch — classify all registered artifacts
    await runInventoryBatch(db);
  } else {
    // Step 2b: local Copilot agent — classify each artifact (role, framework, etc.)
    const model = resolvePhaseModel("inventory", cfg.foundry);
    console.log(`  Agent: context-agent   Model: ${model}\n`);
    const result = await spawnAgent({
      agent: "context-agent",
      model,
      prompt:
        "Classify each artifact in the registry: set its role, framework, and any relevant tags. " +
        "Use `node migration/registry/dist/cli.js list-artifacts --status pending` to see what needs classifying. " +
        "Then use `node migration/registry/dist/cli.js update-artifact --id <artifact-id> --module <module> --role <role> --framework <framework>` " +
        "to write classifications, and `node migration/registry/dist/cli.js add-tag --id <artifact-id> --tag <tag>` for any relevant tags.",
      db,
      logDir: getLogDir(),
      phase: "inventory",
    });

    if (result.exitCode !== 0) {
      stopPolling();
      process.stderr.write(`\n  ✗ Classification agent exited with code ${result.exitCode}\n`);
      process.exit(result.exitCode);
    }
  }

  stopPolling();
  const auditSummary = refreshCompatibilityAudits(db, projectRoot);
  const readiness = evaluatePlanningReadiness(db);
  const blockMessage = formatPlanningBlockMessage(readiness);
  console.log(`  Pre-plan audit: ${auditSummary.jvm.critical} critical JVM  ${auditSummary.jvm.warnings} warning JVM  ${auditSummary.dependencies.total} dependency findings\n`);
  if (blockMessage) {
    setNext(db, {
      summary: blockMessage.summary,
      reason: blockMessage.reason,
      recommendedCommand: blockMessage.command,
    });
    console.log(`  ⚠ ${blockMessage.summary}`);
    console.log(`    ${blockMessage.reason}`);
    console.log(`    Run: ${blockMessage.command}\n`);
  }
  printStatusSummary(db);
  console.log("\n  ✓ Inventory complete\n");
}
