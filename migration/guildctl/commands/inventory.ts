import * as fs from "fs";
import * as path from "path";
import type Database from "better-sqlite3";
import { spawnAgent } from "../runner";
import { startPolling } from "../poller";
import { printPhaseHeader, printEvent, printStatusSummary } from "../dashboard";
import { getLogDir } from "../util";
import { resolveGuildConfig, resolvePhaseModel, resolveWorkspaceRoot } from "../config";
import { registerArtifact } from "../../registry/commands/artifacts";
import { setNext } from "../../registry/commands/operator";
import { applySchema } from "../../registry/db/schema";
import { refreshCompatibilityAudits } from "../audit";
import { evaluatePlanningReadiness, formatPlanningBlockMessage } from "../readiness";
import { findMatchingFiles, loadActiveStack, readStackInstruction, censusSourceFiles, countFilesForStack, listStackPacks } from "../stack";
import { deriveArtifactModule, formatInventoryValidationReport, getInventoryCompletionStatus, loadClassificationSpec, recordInventoryCompletion, validateInventoryQuality } from "../classification";

// ─── File scanner ────────────────────────────────────────────────────────────

function deriveArtifactId(filePath: string, projectRoot: string, legacyRoot: string, sourceExtension: string, module: string): string {
  const rel = path.relative(legacyRoot, filePath);
  const noExt = rel.endsWith(sourceExtension) ? rel.slice(0, -sourceExtension.length) : rel;
  const parts = noExt.split(path.sep);
  const className = parts[parts.length - 1];
  return `legacy-source:${module}:${className}`;
}

export function scanAndRegister(db: Database.Database, projectRoot: string): number {
  const legacyDir = path.join(projectRoot, "legacy");
  process.stdout.write(`  [scan] projectRoot : ${projectRoot}\n`);
  process.stdout.write(`  [scan] legacyDir   : ${legacyDir}\n`);
  process.stdout.write(`  [scan] legacyDir exists: ${fs.existsSync(legacyDir)}\n`);

  const cfg = resolveGuildConfig({ cwd: projectRoot });
  const pack = loadActiveStack(cfg, projectRoot);
  const spec = loadClassificationSpec(pack);

  // TASK-03: language census — count every source-like file by extension before
  // applying the stack filter, so an empty/stale result is never silent.
  const { counts: census, total: censusTotal } = censusSourceFiles(legacyDir);
  const censusLine = [...census.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([ext, n]) => `${ext}: ${n}`)
    .join(", ");
  process.stdout.write(`  [scan] language census: ${censusLine || "none"}\n`);

  const files = findMatchingFiles(legacyDir, pack.manifest.source_globs);
  process.stdout.write(`  [scan] files matching stack '${pack.manifest.id}': ${files.length}\n`);

  if (censusTotal === 0) {
    throw new Error(
      "No source files found in legacy/. Check --legacy-url points at a populated codebase.",
    );
  }

  if (files.length === 0) {
    // Suggest a stack pack whose source globs best match the census.
    const ranked = listStackPacks(projectRoot)
      .map((candidate) => ({ id: candidate.manifest.id, n: countFilesForStack(legacyDir, candidate) }))
      .filter((entry) => entry.n > 0)
      .sort((a, b) => b.n - a.n);
    const suggestion = ranked.length > 0
      ? ` A stack pack that matches this codebase was detected: '${ranked[0]!.id}' (${ranked[0]!.n} file(s)).`
      : "";
    const available = listStackPacks(projectRoot).map((p) => p.manifest.id).join(", ");
    throw new Error(
      `No files matching stack '${pack.manifest.id}' found, but ${censusTotal} source file(s) were detected (${censusLine}).\n` +
      "The configured stack does not match this codebase.\n" +
      `Available stacks: ${available}.${suggestion}`,
    );
  }

  // Warning tier: large share of the census is outside the configured stack.
  const outOfStack = censusTotal - files.length;
  if (outOfStack > 0 && outOfStack / censusTotal > 0.5) {
    process.stderr.write(
      `  [warn] ${outOfStack} of ${censusTotal} source file(s) do not match stack '${pack.manifest.id}'. ` +
      "Continuing with the matching subset; out-of-stack files are ignored by inventory.\n",
    );
  }

  // Show DB filename so we know which file is being written
  const dbFilename = (db as unknown as { name?: string }).name ?? "(unknown)";
  process.stdout.write(`  [scan] DB file     : ${dbFilename}\n\n`);

  let registered = 0;
  let skipped = 0;

  for (const file of files) {
    const relPath = path.relative(projectRoot, file);
    const module = deriveArtifactModule(spec, relPath);
    const id = deriveArtifactId(file, projectRoot, legacyDir, pack.manifest.scaffold.source_extension, module);
    const exists = db.prepare("SELECT id FROM artifacts WHERE id = ?").get(id);
    if (exists) { skipped++; continue; }

    try {
      registerArtifact(db, { id, kind: "legacy-source", path: relPath, module });
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

interface InventoryDeps {
  spawnAgent?: typeof spawnAgent;
  startPolling?: typeof startPolling;
  getLogDir?: typeof getLogDir;
  refreshCompatibilityAudits?: typeof refreshCompatibilityAudits;
  scanAndRegister?: typeof scanAndRegister;
}

function inventoryTimeoutMs(): number {
  const raw = process.env["GUILDCTL_INVENTORY_TIMEOUT_MINUTES"];
  const minutes = raw ? Number(raw) : 30;
  return Math.max(1, Number.isFinite(minutes) ? minutes : 30) * 60_000;
}

function artifactIds(db: Database.Database): string[] {
  return db.prepare("SELECT id FROM artifacts ORDER BY id").pluck().all() as string[];
}

function removeArtifacts(db: Database.Database, ids: string[]): void {
  if (ids.length === 0) return;
  const tx = db.transaction(() => {
    const del = db.prepare("DELETE FROM artifacts WHERE id = ?");
    for (const id of ids) del.run(id);
  });
  tx();
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function runInventory(db: Database.Database, workspaceRoot = resolveWorkspaceRoot(), deps: InventoryDeps = {}): Promise<void> {
  printPhaseHeader("Phase 1 · Inventory");

  // Ensure schema exists (idempotent)
  applySchema(db);

  const projectRoot = workspaceRoot;

  // Step 1: scan source files directly — no agent needed
  process.stdout.write("  Scanning legacy/ for source files…\n");
  const count = (deps.scanAndRegister ?? scanAndRegister)(db, projectRoot);
  process.stdout.write(`  ✓ ${count} file(s) registered\n\n`);

  const stopPolling = (deps.startPolling ?? startPolling)(db, (events) => {
    for (const e of events) printEvent(e);
  });

  const cfg = resolveGuildConfig({ cwd: projectRoot });
  const pack = loadActiveStack(cfg, projectRoot);
  const spec = loadClassificationSpec(pack);
  const model = resolvePhaseModel("inventory", cfg);
  const expectedArtifactIds = (db.prepare("SELECT id FROM artifacts WHERE tier = 'first-class' ORDER BY id").pluck().all() as string[]);
  const allowedArtifactIdsBeforeAgent = artifactIds(db);
  const specForPrompt = JSON.stringify(spec, null, 2);
  console.log(`  Agent: context-agent   Model: ${model}\n`);
  const result = await (deps.spawnAgent ?? spawnAgent)({
    agent: "context-agent",
    model,
    prompt:
        "Classify ONLY the orchestrator-registered first-class artifacts. Do not register new artifacts. " +
        "Write a structured JSON batch with id, module, role, framework, confidence, evidence, ambiguous/signals when needed, then apply it using " +
        "`node migration/registry/dist/cli.js batch-classify --file <json>`. Do not use arbitrary tags; lifecycle tags are not classification evidence. " +
        "When the batch is applied, record explicit phase completion evidence with `node migration/registry/dist/cli.js mark-inventory-complete`.\n\n" +
        `Expected artifact IDs (${expectedArtifactIds.length}):\n${expectedArtifactIds.join("\n")}\n\n` +
        "Classification contract JSON:\n" + specForPrompt + "\n\n" +
        readStackInstruction(pack, "classify"),
    db,
    logDir: (deps.getLogDir ?? getLogDir)(),
    phase: "inventory",
    timeoutMs: inventoryTimeoutMs(),
  });

  if (result.exitCode !== 0) {
    stopPolling();
    removeArtifacts(db, artifactIds(db).filter((id) => !allowedArtifactIdsBeforeAgent.includes(id)));
    recordInventoryCompletion(db, { status: "failed", runId: result.runId, reason: `classification agent exited with code ${result.exitCode}` });
    throw new Error(`Classification agent exited with code ${result.exitCode}`);
  }

  stopPolling();
  const completionStatus = getInventoryCompletionStatus(db);
  const createdArtifactIds = artifactIds(db).filter((id) => !allowedArtifactIdsBeforeAgent.includes(id));
  const validation = validateInventoryQuality(db, spec, {
    expectedArtifactIds,
    allowedSecondClassArtifactIds: allowedArtifactIdsBeforeAgent.filter((id) => !expectedArtifactIds.includes(id)),
    completionStatus,
    requireCompletion: true,
    workspaceRoot: projectRoot,
  });
  if (!validation.valid) {
    removeArtifacts(db, createdArtifactIds);
    recordInventoryCompletion(db, { status: "failed", runId: result.runId, reason: validation.errors.join("; ") || "inventory validation failed" });
    const reportText = formatInventoryValidationReport(validation);
    setNext(db, {
      summary: "Inventory quality gate failed.",
      reason: reportText,
      recommendedCommand: "Fix classifications with node migration/registry/dist/cli.js batch-classify --file <json> --dry-run, then rerun guildctl run inventory",
    });
    process.stderr.write(`\n  ✗ Inventory quality gate failed\n${reportText}\n`);
    throw new Error(`Inventory quality gate failed: ${validation.errors.join("; ")}`);
  }

  const auditSummary = (deps.refreshCompatibilityAudits ?? refreshCompatibilityAudits)(db, projectRoot);
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
