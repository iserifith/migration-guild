import * as fs from "fs";
import * as path from "path";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { spawnAgent } from "../runner";
import type { AgentRunResult } from "../runner";
import { startPolling } from "../poller";
import { printPhaseHeader, printEvent, printStatusSummary } from "../dashboard";
import { getLogDir } from "../util";
import { resolveGuildConfig, resolvePhaseModel, resolveWorkspaceRoot } from "../config";
import { registerArtifact } from "../../registry/commands/artifacts";
import {
  extractSourceDependencies,
  recordAutoDependencies,
} from "../../registry/commands/sourceDeps";
import { setNext } from "../../registry/commands/operator";
import { applySchema } from "../../registry/db/schema";
import { refreshCompatibilityAudits } from "../audit";
import { evaluatePlanningReadiness, formatPlanningBlockMessage } from "../readiness";
import { findMatchingFiles, loadActiveStack, readStackInstruction, censusSourceFiles, countFilesForStack, listStackPacks } from "../stack";
import { deriveArtifactModule, formatInventoryValidationReport, getInventoryCompletionStatus, loadClassificationSpec, recordInventoryCompletion, validateInventoryQuality } from "../classification";

// ─── File scanner ────────────────────────────────────────────────────────────

function deriveArtifactId(filePath: string, legacyRoot: string, sourceExtension: string, module: string): string {
  const rel = path.relative(legacyRoot, filePath);
  const noExt = rel.endsWith(sourceExtension) ? rel.slice(0, -sourceExtension.length) : rel;
  const parts = noExt.split(path.sep);
  const className = parts[parts.length - 1];
  return `legacy-source:${module}:${className}`;
}

function derivePathQualifiedArtifactId(filePath: string, legacyRoot: string, sourceExtension: string, module: string): string {
  const rel = path.relative(legacyRoot, filePath);
  const noExt = rel.endsWith(sourceExtension) ? rel.slice(0, -sourceExtension.length) : rel;
  const qualifiedPath = noExt.split(path.sep).join(".").replaceAll(":", "_");
  const pathHash = createHash("sha256").update(qualifiedPath).digest("hex").slice(0, 12);
  return `legacy-source:${module}:${pathHash}.${qualifiedPath}`;
}

// ─── Skip accounting ─────────────────────────────────────────────────────────

interface SkipRecord {
  path: string;
  reason: string;
}

// Reconcile the discovered/registered/skipped arithmetic. The invariant is
// discovered === registered + skipped; any imbalance is a scanner bug, not
// benign dedup, so we surface it loudly rather than let it pass silently.
export function reconcileInventoryCounts(
  discovered: number,
  registered: number,
  skipCounts: Record<string, number>,
): string {
  const skipped = Object.values(skipCounts).reduce((a, b) => a + b, 0);
  const reasonParts = Object.entries(skipCounts)
    .filter(([, n]) => n > 0)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([reason, n]) => `${reason}: ${n}`);
  const reasonLine = reasonParts.length > 0 ? `  [scan] skip reasons: ${reasonParts.join(", ")}\n` : "";
  const report = `  [scan] discovered: ${discovered}  registered: ${registered}  skipped: ${skipped}\n${reasonLine}`;
  if (discovered !== registered + skipped) {
    throw new Error(
      `Inventory count mismatch: discovered (${discovered}) != registered (${registered}) + skipped (${skipped}). ` +
      `A file dropped out without a recorded skip reason — this is a scanner bug.`,
    );
  }
  return report;
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

  const skipLogDir = path.join(projectRoot, ".guild", "logs");
  fs.mkdirSync(skipLogDir, { recursive: true });
  const skipLogPath = path.join(skipLogDir, "inventory-skips.log");
  if (fs.existsSync(skipLogPath)) fs.rmSync(skipLogPath);

  const seen = new Set<string>();
  const skipCounts: Record<string, number> = {};
  const skipDetails: SkipRecord[] = [];
  // TASK-10: collect (id, content, lang) so source-level deps can be extracted
  // after every artifact is registered (so cross-references resolve).
  const sourceFiles: Array<{ id: string; content: string; lang: "java" | "python" | "other" }> = [];

  function recordSkip(relPath: string, reason: string): void {
    skipCounts[reason] = (skipCounts[reason] ?? 0) + 1;
    skipDetails.push({ path: relPath, reason });
    fs.appendFileSync(skipLogPath, `${relPath}\t${reason}\n`);
  }

  let registered = 0;
  const ext = pack.manifest.scaffold.source_extension;
  const candidates = files.map((file) => {
    const relPath = path.relative(projectRoot, file);
    const module = deriveArtifactModule(spec, relPath);
    const baseId = deriveArtifactId(file, legacyDir, ext, module);
    return { file, relPath, module, baseId };
  });
  const baseIdCounts = new Map<string, number>();
  for (const candidate of candidates) {
    const slugKey = candidate.baseId.toLowerCase();
    baseIdCounts.set(slugKey, (baseIdCounts.get(slugKey) ?? 0) + 1);
  }

  const resolvedCandidates = candidates.map((candidate) => {
    const collision = (baseIdCounts.get(candidate.baseId.toLowerCase()) ?? 0) > 1;
    const existingBase = collision
      ? db.prepare("SELECT path FROM artifacts WHERE id = ?").get(candidate.baseId) as { path: string } | undefined
      : undefined;
    const qualifiedId = derivePathQualifiedArtifactId(candidate.file, legacyDir, ext, candidate.module);
    const id = collision && existingBase?.path !== candidate.relPath ? qualifiedId : candidate.baseId;
    return { ...candidate, id, qualifiedId };
  });
  const qualifiedAliases = new Map(resolvedCandidates.map((candidate) => [candidate.qualifiedId, candidate.id]));

  for (const candidate of resolvedCandidates) {
    const { file, relPath, module, id } = candidate;
    const exists = db.prepare("SELECT id FROM artifacts WHERE id = ?").get(id);

    if (seen.has(id)) {
      // Path qualification should make this unreachable; retain explicit accounting
      // so any future identity regression fails visibly rather than dropping a file.
      recordSkip(relPath, "duplicate-slug");
      continue;
    }

    // Refresh source-derived dependencies for both new and already-registered
    // artifacts so partial-registry upgrades replace stale ambiguous edges.
    if (!/\/test\//i.test(relPath) && !/\/tests\//i.test(relPath)) {
      const lang: "java" | "python" | "other" = ext === ".java" ? "java" : ext === ".py" ? "python" : "other";
      try {
        sourceFiles.push({ id, content: fs.readFileSync(file, "utf-8"), lang });
      } catch {
        // unreadable source — leave it out of the dep graph
      }
    }

    if (exists) {
      // Already in the registry from a prior run — benign dedup, not a loss.
      recordSkip(relPath, "already-registered");
      seen.add(id);
      continue;
    }

    try {
      registerArtifact(db, { id, kind: "legacy-source", path: relPath, module });
      registered++;
      seen.add(id);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("already registered")) {
        // Any other failure must still be counted so the arithmetic balances.
        recordSkip(relPath, `other(${msg.slice(0, 80)})`);
      } else {
        recordSkip(relPath, "already-registered");
        seen.add(id);
      }
    }
  }

  const report = reconcileInventoryCounts(files.length, registered, skipCounts);
  process.stdout.write(report);

  // TASK-10: extract source-level dependency links now that all artifacts are
  // registered, so imports/extends can resolve to real artifact ids.
  const idSet = new Set<string>(
    (db.prepare("SELECT id FROM artifacts").all() as Array<{ id: string }>).map((r) => r.id),
  );
  let autoLinks = 0;
  for (const sf of sourceFiles) {
    const deps = extractSourceDependencies(sf.id, sf.content, sf.lang, idSet, qualifiedAliases);
    recordAutoDependencies(db, sf.id, deps);
    autoLinks += deps.length;
  }
  process.stdout.write(`  [deps] source-level links auto-detected: ${autoLinks}\n`);

  if (skipDetails.length > 0) {
    process.stdout.write(`  [scan] ${skipDetails.length} file(s) skipped — see ${skipLogPath}\n`);
  }

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

// TASK-02: default batch size (artifacts per agent call). Override via env or
// config key inventory.classificationBatchSize.
function classificationBatchSize(cwd?: string): number {
  const raw = process.env["GUILDCTL_CLASSIFICATION_BATCH_SIZE"];
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 1) return Math.floor(n);
  }
  const cfg = resolveGuildConfig({ cwd: cwd ?? process.cwd() });
  return cfg.inventory?.classificationBatchSize ?? 100;
}

function chunk<T>(items: T[], size: number): T[][] {
  if (size < 1) size = 1;
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
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
// TASK-02: classify in batches so a single slow/timeout repo no longer loses
  // ALL work. Each batch is its own agent call with its own timeout; completed
  // batches persist independently. Re-running inventory resumes from the first
  // artifact that still lacks a classification (idempotent on a finished repo).
  const batchSize = classificationBatchSize(projectRoot);
  const maxBatchRetries = cfg.inventory?.maxBatchRetries ?? 2;

  // Resume support: only artifacts that are still unclassified.
  const firstClassIds = db
    .prepare("SELECT id FROM artifacts WHERE tier = 'first-class' ORDER BY id")
    .pluck()
    .all() as string[];
  const unclassifiedIds = db
    .prepare(
      `SELECT a.id FROM artifacts a
       LEFT JOIN artifact_classifications c ON c.artifact_id = a.id
       WHERE a.tier = 'first-class' AND c.artifact_id IS NULL
       ORDER BY a.id`,
    )
    .pluck()
    .all() as string[];
  const expectedArtifactIds = firstClassIds;
  const allowedArtifactIdsBeforeAgent = artifactIds(db);

  const total = firstClassIds.length;
  if (unclassifiedIds.length === 0) {
    process.stdout.write(`  ✓ All ${total} first-class artifact(s) already classified — inventory is a no-op\n`);
  } else {
    const batches = chunk(unclassifiedIds, batchSize);
    process.stdout.write(
      `  Classifying ${unclassifiedIds.length}/${total} unclassified artifact(s) in ${batches.length} batch(es) of ≤${batchSize}\n`,
    );

    let persistedBatches = 0;
    let failedBatches = 0;
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const batchLabel = `batch ${i + 1}/${batches.length} (${batch.length} artifacts)`;
      let attempt = 0;
      let result: AgentRunResult | null = null;
      while (attempt <= maxBatchRetries) {
        attempt += 1;
        console.log(`\n  Agent: context-agent · ${batchLabel} · attempt ${attempt}\n`);
        result = await (deps.spawnAgent ?? spawnAgent)({
          agent: "context-agent",
          model,
          prompt:
            "Classify ONLY the orchestrator-registered first-class artifacts listed below. Do not register new artifacts. " +
            "Write a structured JSON batch with id, module, role, framework, confidence, evidence, ambiguous/signals when needed, then apply it using " +
            "`node migration/registry/dist/cli.js batch-classify --file <json>`. Do not use arbitrary tags; lifecycle tags are not classification evidence. " +
            "evidence MUST be a JSON array of strings, e.g. [\"negative-evidence: no configured framework signal matched\", \"django: Django Model import\"]. " +
            "When the batch is applied, record explicit phase completion evidence with `node migration/registry/dist/cli.js mark-inventory-complete`.\n\n" +
            `Batch artifact IDs (${batch.length}):\n${batch.join("\n")}\n\n` +
            "Classification contract JSON:\n" + JSON.stringify(spec, null, 2) + "\n\n" +
            readStackInstruction(pack, "classify"),
          db,
          logDir: (deps.getLogDir ?? getLogDir)(),
          phase: "inventory",
          timeoutMs: inventoryTimeoutMs(),
        });
        if (result.exitCode === 0) break;
        process.stderr.write(`  ✗ ${batchLabel} attempt ${attempt} exited with code ${result.exitCode}\n`);
        if (attempt > maxBatchRetries) {
          failedBatches += 1;
          process.stderr.write(`  ✗ ${batchLabel} failed after ${maxBatchRetries} retry(ies)\n`);
        }
      }
      // A persisted batch is one whose artifacts now have classifications. Only
      // count it when the agent succeeded; a failed batch keeps its prior state.
      const classifiedNow = db
        .prepare(
          `SELECT COUNT(*) c FROM artifact_classifications WHERE artifact_id IN (${batch.map(() => "?").join(",")})`,
        )
        .all(...batch) as { c: number }[];
      if (classifiedNow[0].c === batch.length) persistedBatches += 1;
    }

    const stillUnclassified = db
      .prepare(
        `SELECT COUNT(*) c FROM artifacts a
         LEFT JOIN artifact_classifications c ON c.artifact_id = a.id
         WHERE a.tier = 'first-class' AND c.artifact_id IS NULL`,
      )
      .get() as { c: number };
    process.stdout.write(
      `\n  Classification summary: ${total - stillUnclassified.c}/${total} classified across ${persistedBatches} persisted batch(es), ${failedBatches} failed batch(es)\n`,
    );
    if (stillUnclassified.c > 0) {
      process.stderr.write(
        `  ⚠ ${stillUnclassified.c} artifact(s) remain unclassified — NOT silently defaulted. Re-run inventory to resume.\n`,
      );
    }
  }

  stopPolling();

  const completionStatus = getInventoryCompletionStatus(db);
  const createdArtifactIds = artifactIds(db).filter((id) => !allowedArtifactIdsBeforeAgent.includes(id));
  // Guard: an agent must never register artifacts outside the scan (TASK-02 keeps
  // each batch self-contained, so any new id is a contract violation).
  const unexpected = createdArtifactIds.filter((id) => !allowedArtifactIdsBeforeAgent.includes(id));
  if (unexpected.length > 0) {
    removeArtifacts(db, createdArtifactIds);
    recordInventoryCompletion(db, { status: "failed", runId: "n/a", reason: `unexpected registration of ${unexpected.length} artifact(s)` });
    throw new Error(`Unexpected registration of artifacts by agent: ${unexpected.join(", ")}`);
  }

  const validation = validateInventoryQuality(db, spec, {
    expectedArtifactIds,
    allowedSecondClassArtifactIds: allowedArtifactIdsBeforeAgent.filter((id) => !expectedArtifactIds.includes(id)),
    completionStatus,
    requireCompletion: true,
    workspaceRoot: projectRoot,
  });
  if (!validation.valid) {
    removeArtifacts(db, createdArtifactIds);
    recordInventoryCompletion(db, { status: "failed", runId: "n/a", reason: validation.errors.join("; ") || "inventory validation failed" });
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
