import * as fs from "fs";
import * as path from "path";
import type Database from "better-sqlite3";
import { spawnAgent } from "../runner";
import { startPolling } from "../poller";
import { printPhaseHeader, printEvent, printStatusSummary } from "../dashboard";
import { getLogDir } from "../util";
import { loadConfig, resolvePhaseModel } from "../config";
import { registerArtifact } from "../../registry/commands/artifacts";
import { setNext } from "../../registry/commands/operator";
import { applySchema } from "../../registry/db/schema";
import { refreshCompatibilityAudits } from "../audit";
import { evaluatePlanningReadiness, formatPlanningBlockMessage } from "../readiness";
import { findMatchingFiles, loadActiveStack } from "../stack";

// ─── File scanner ────────────────────────────────────────────────────────────

function deriveArtifactId(filePath: string, legacyRoot: string, sourceExtension: string, mainSourceDir: string): string {
  const rel = path.relative(legacyRoot, filePath);
  const noExt = rel.endsWith(sourceExtension) ? rel.slice(0, -sourceExtension.length) : rel;
  const parts = noExt.split(path.sep);
  const className = parts[parts.length - 1];

  const sourceParts = mainSourceDir.split("/");
  const sourceEnd = parts.findIndex((part, index) => sourceParts.every((sourcePart, offset) => parts[index + offset] === sourcePart));
  const pkgParts = sourceEnd >= 0 ? parts.slice(sourceEnd + sourceParts.length, -1) : parts.slice(0, -1);
  const module = pkgParts.join(".") || "default";

  return `legacy-source:${module}:${className}`;
}

function scanAndRegister(db: Database.Database, projectRoot: string): number {
  const legacyDir = path.join(projectRoot, "legacy");
  process.stdout.write(`  [scan] projectRoot : ${projectRoot}\n`);
  process.stdout.write(`  [scan] legacyDir   : ${legacyDir}\n`);
  process.stdout.write(`  [scan] legacyDir exists: ${fs.existsSync(legacyDir)}\n`);

  const cfg = loadConfig();
  const pack = loadActiveStack(cfg, projectRoot);
  const files = findMatchingFiles(legacyDir, pack.manifest.source_globs);
  process.stdout.write(`  [scan] source files found: ${files.length}\n`);

  // Show DB filename so we know which file is being written
  const dbFilename = (db as unknown as { name?: string }).name ?? "(unknown)";
  process.stdout.write(`  [scan] DB file     : ${dbFilename}\n\n`);

  let registered = 0;
  let skipped = 0;

  for (const file of files) {
    const id = deriveArtifactId(file, legacyDir, pack.manifest.scaffold.source_extension, pack.manifest.scaffold.main_source_dir);
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

// ─── Main ────────────────────────────────────────────────────────────────────

export async function runInventory(db: Database.Database): Promise<void> {
  printPhaseHeader("Phase 1 · Inventory");

  // Ensure schema exists (idempotent)
  applySchema(db);

  // Always resolve project root from __dirname (migration/guildctl/dist → my-migration/)
  const projectRoot = path.resolve(__dirname, "..", "..", "..");

  // Step 1: scan source files directly — no agent needed
  process.stdout.write("  Scanning legacy/ for source files…\n");
  const count = scanAndRegister(db, projectRoot);
  process.stdout.write(`  ✓ ${count} file(s) registered\n\n`);

  const stopPolling = startPolling(db, (events) => {
    for (const e of events) printEvent(e);
  });

  const cfg = loadConfig();
  const model = resolvePhaseModel("inventory", cfg);
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
