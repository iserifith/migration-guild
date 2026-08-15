import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import type { AgentRunResult } from "../guildctl/runner";
import { runPlan } from "../guildctl/commands/plan";
import {
  confirmDisposition,
  upsertProposedDisposition,
} from "../registry/commands/dispositions";
import { registerArtifact } from "../registry/commands/artifacts";
import { applySchema } from "../registry/db/schema";

/**
 * T018 — US2 auto-confirm / fail-closed / collector-ordering coverage for
 * specs/006-dependency-disposition (FR-006/FR-007, quickstart Scenario 3,
 * Constitution Principle V control-flow coverage).
 *
 * Mirrors plan-risk-confirmation.test.ts's runPlan-driven fixture style.
 */

// Auto-confirm mappings and auto-keep scope so the phase reaches the
// disposition gate without hanging on unrelated prompts.
process.env["GUILDCTL_AUTO_CONFIRM_MAPPINGS"] = "1";
process.env["GUILDCTL_AUTO_KEEP_SCOPE"] = "1";

const repoRoot = path.resolve(__dirname, "..", "..");

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function fixtureRoot(stack = "java-spring"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guild-plan-disposition-"));
  fs.cpSync(path.join(repoRoot, "stacks"), path.join(root, "stacks"), { recursive: true });
  fs.mkdirSync(path.join(root, ".guild"), { recursive: true });
  fs.writeFileSync(path.join(root, ".guild", "config.yaml"), `version: 1\nstack: ${stack}\n`);
  return root;
}

function registerClassified(db: Database.Database, id: string): void {
  registerArtifact(db, {
    id,
    kind: "legacy-source",
    path: `legacy/src/main/java/${id.replaceAll(":", "/")}.java`,
    tier: "first-class",
    module: "com.acme",
    role: "service",
    framework: "plain-java",
  });
  db.prepare(`
    INSERT INTO artifact_classifications (artifact_id, framework, role, confidence, ambiguous, evidence_json, signals_json)
    VALUES (?, 'plain-java', 'service', 0.85, 0, ?, '[]')
    ON CONFLICT(artifact_id) DO NOTHING
  `).run(id, JSON.stringify(["negative-evidence: no configured framework signal matched"]));
}

function writeSource(root: string, id: string, imports: string[]): void {
  const rel = `legacy/src/main/java/${id.replaceAll(":", "/")}.java`;
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${imports.map((i) => `import ${i};`).join("\n")}\nclass ${id.split(":")[2]} {}\n`);
}

function writePom(root: string, dependencies: Array<{ group: string; artifact: string; version?: string }>): void {
  const deps = dependencies.map((d) =>
    `<dependency><groupId>${d.group}</groupId><artifactId>${d.artifact}</artifactId>${d.version ? `<version>${d.version}</version>` : ""}</dependency>`,
  ).join("\n");
  fs.writeFileSync(path.join(root, "legacy", "pom.xml"), `<project><dependencies>\n${deps}\n</dependencies></project>`);
}

interface DispositionRow {
  library_name: string;
  status: string;
  disposition: string;
  confirmed_by: string | null;
  pending_disposition: string | null;
}

function dispositions(db: Database.Database): DispositionRow[] {
  return db.prepare(
    "SELECT library_name, status, disposition, confirmed_by, pending_disposition FROM dependency_dispositions ORDER BY library_name",
  ).all() as DispositionRow[];
}

function historyKinds(db: Database.Database): string[] {
  return db.prepare("SELECT change_kind FROM dependency_disposition_history").all()
    .map((row) => (row as { change_kind: string }).change_kind);
}

class ExitError extends Error {
  constructor(readonly code: number) {
    super(`exit:${code}`);
  }
}

async function withInterceptedExit(fn: () => Promise<void>): Promise<ExitError | null> {
  const originalExit = process.exit;
  process.exit = ((code?: number) => {
    throw new ExitError(code ?? 0);
  }) as typeof process.exit;
  try {
    await fn();
    return null;
  } catch (error) {
    assert.ok(error instanceof ExitError, `expected ExitError, got ${error}`);
    return error;
  } finally {
    process.exit = originalExit;
  }
}

const auditSummary = {
  artifact_count: 1,
  jvm: { critical: 0, warnings: 0 },
  dependencies: { total: 0, unresolved: 0 },
  tools: [],
};

function success(agent: string): AgentRunResult {
  return { runId: `${agent}-run`, agent, model: "test-model", prompt: "p", logFile: "/tmp/x.log", exitCode: 0 };
}

const planDeps = (root: string, onAgent?: (agent: string, db: Database.Database) => void, db?: Database.Database) => ({
  workspaceRoot: root,
  refreshCompatibilityAudits: () => auditSummary,
  startPolling: () => () => undefined,
  getLogDir: () => "/tmp",
  spawnAgent: async ({ agent }: { agent: string }) => {
    if (onAgent && db) onAgent(agent, db);
    return success(agent);
  },
});

test("GUILDCTL_AUTO_CONFIRM_DISPOSITIONS=1 bulk-confirms proposals and folds pending re-proposals as benchmark-runner", async () => {
  process.env["GUILDCTL_AUTO_CONFIRM_DISPOSITIONS"] = "1";
  const db = createDb();
  const root = fixtureRoot();
  try {
    registerClassified(db, "legacy-source:com.acme:UsesJoda");
    writeSource(root, "legacy-source:com.acme:UsesJoda", ["org.joda.time.DateTime"]);
    writePom(root, [{ group: "joda-time", artifact: "joda-time", version: "2.10" }]);

    // Pre-seed a confirmed row with a pending re-proposal — auto-confirm must
    // fold the pending group as well as confirming fresh proposals.
    upsertProposedDisposition(db, {
      libraryName: "com.acme:legacy-helper",
      disposition: "keep",
      lockedTargetVersion: "1.0.0",
      rationale: "Operator-settled keep.",
      proposedBy: "operator-policy",
    });
    confirmDisposition(db, { libraryName: "com.acme:legacy-helper", confirmedBy: "operator" });
    upsertProposedDisposition(db, {
      libraryName: "com.acme:legacy-helper",
      disposition: "inline",
      inlineNote: "Two methods — inline into the shared utility class.",
      rationale: "Re-run evidence: only two methods used.",
      proposedBy: "planner-collector",
    });

    await runPlan(db, planDeps(root, undefined, db));

    const rows = dispositions(db);
    assert.ok(rows.length >= 2, "joda-time + legacy-helper rows exist");
    for (const row of rows) {
      assert.equal(row.status, "confirmed", `${row.library_name} confirmed`);
      assert.equal(row.confirmed_by, "benchmark-runner");
      assert.equal(row.pending_disposition, null, `${row.library_name} pending folded`);
    }
    const helper = rows.find((row) => row.library_name === "com.acme:legacy-helper")!;
    assert.equal(helper.disposition, "inline", "pending re-proposal folded into primary");
    assert.ok(historyKinds(db).includes("auto-confirm"), "history records change_kind='auto-confirm'");
  } finally {
    delete process.env["GUILDCTL_AUTO_CONFIRM_DISPOSITIONS"];
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("env unset + non-interactive stdin: rows stay proposed, warning printed, no hang, end-of-Plan gate exits 1 (Scenario 3)", async () => {
  delete process.env["GUILDCTL_AUTO_CONFIRM_DISPOSITIONS"];
  const db = createDb();
  const root = fixtureRoot();
  try {
    registerClassified(db, "legacy-source:com.acme:UsesJoda");
    writeSource(root, "legacy-source:com.acme:UsesJoda", ["org.joda.time.DateTime"]);
    writePom(root, [{ group: "joda-time", artifact: "joda-time", version: "2.10" }]);

    const written: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
      written.push(String(chunk));
      return originalWrite(chunk as never, ...(rest as never[]));
    }) as typeof process.stdout.write;

    let exit: ExitError | null;
    try {
      exit = await withInterceptedExit(() => runPlan(db, planDeps(root, undefined, db)));
    } finally {
      process.stdout.write = originalWrite;
    }

    assert.ok(exit, "runPlan exits via the disposition readiness gate");
    assert.equal(exit!.code, 1);
    const rows = dispositions(db);
    assert.ok(rows.length >= 1);
    for (const row of rows) {
      assert.equal(row.status, "proposed", "never silently defaulted");
      assert.equal(row.confirmed_by, null);
    }
    const output = written.join("");
    assert.match(output, /GUILDCTL_AUTO_CONFIRM_DISPOSITIONS=1/, "silence-first warning names the bypass");
    // No readline prompt was shown (non-interactive path).
    assert.doesNotMatch(output, /Confirm\? \[y\]es/);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("bare runPlan with NO pre-seeded dispositions: collector writes rows BEFORE the Planner spawns (Principle V)", async () => {
  process.env["GUILDCTL_AUTO_CONFIRM_DISPOSITIONS"] = "1";
  const db = createDb();
  const root = fixtureRoot();
  try {
    registerClassified(db, "legacy-source:com.acme:UsesJoda");
    writeSource(root, "legacy-source:com.acme:UsesJoda", ["org.joda.time.DateTime"]);
    writePom(root, [{ group: "joda-time", artifact: "joda-time", version: "2.10" }]);

    assert.equal(dispositions(db).length, 0, "no pre-seeded disposition rows");

    let rowsAtPlannerSpawn = -1;
    await runPlan(db, planDeps(root, (agent, planDb) => {
      if (agent === "planner-agent") {
        rowsAtPlannerSpawn = (planDb.prepare("SELECT COUNT(*) AS n FROM dependency_dispositions").get() as { n: number }).n;
      }
    }, db));

    assert.ok(rowsAtPlannerSpawn >= 1,
      "disposition rows exist BEFORE the Planner phase spawns — the T015 collector ran at its documented point");
  } finally {
    delete process.env["GUILDCTL_AUTO_CONFIRM_DISPOSITIONS"];
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
