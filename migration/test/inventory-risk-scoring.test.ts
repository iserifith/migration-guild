import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import type { AgentRunResult } from "../guildctl/runner";
import { runInventory } from "../guildctl/commands/inventory";
import { applySchema } from "../registry/db/schema";

// ISSUE-68 scope gate: auto-keep every module so the runInventory() call below
// isn't blocked on an unrelated scope decision (no stdin available in tests).
process.env["GUILDCTL_AUTO_KEEP_SCOPE"] = "1";

const repoRoot = path.resolve(__dirname, "..", "..");

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function fixtureRoot(stack = "java-spring"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guild-inventory-risk-"));
  fs.cpSync(path.join(repoRoot, "stacks"), path.join(root, "stacks"), { recursive: true });
  fs.mkdirSync(path.join(root, ".guild"), { recursive: true });
  fs.writeFileSync(path.join(root, ".guild", "config.yaml"), `version: 1\nstack: ${stack}\n`);
  return root;
}

function writeJava(root: string, relFromLegacy: string, content: string): string {
  const file = path.join(root, "legacy", ...relFromLegacy.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
  return path.relative(root, file).split(path.sep).join("/");
}

interface RiskRow {
  artifact_id: string;
  risk_score: number;
  high_risk: number;
  reason_codes_json: string;
}

function readRisk(db: Database.Database, id: string): RiskRow | undefined {
  return db
    .prepare("SELECT artifact_id, risk_score, high_risk, reason_codes_json FROM artifact_risk_assessments WHERE artifact_id = ?")
    .get(id) as RiskRow | undefined;
}

const auditsStub = () => ({ artifact_count: 1, jvm: { critical: 0, warnings: 0 }, dependencies: { total: 0, unresolved: 0 }, tools: [] });

// Fake agent: classification is irrelevant to risk scoring, but runInventory's
// quality gate requires every artifact to be classified and completion evidence
// recorded. Classify everything plainly and mark the phase complete.
function fakeClassifyAgent(db: Database.Database) {
  return async ({ agent, model, prompt }: { agent: string; model?: string; prompt: string }): Promise<AgentRunResult> => {
    const ids = db.prepare("SELECT id FROM artifacts").pluck().all() as string[];
    const evidence = JSON.stringify(["negative-evidence: no configured framework signal matched"]);
    const insert = db.prepare(
      `INSERT OR REPLACE INTO artifact_classifications (artifact_id, framework, role, confidence, ambiguous, evidence_json, signals_json, updated_at)
       VALUES (?, 'plain-java', 'utility', 0.9, 0, ?, '{}', datetime('now'))`,
    );
    const updateArtifactRow = db.prepare(
      "UPDATE artifacts SET module = 'app', role = 'utility', framework = 'plain-java' WHERE id = ?",
    );
    for (const id of ids) {
      insert.run(id, evidence);
      updateArtifactRow.run(id);
    }
    db.prepare("INSERT OR REPLACE INTO operator_state (key, value) VALUES ('inventory_completion', ?)").run(
      JSON.stringify({ status: "completed" }),
    );
    return { runId: "r-risk", agent, model, prompt, exitCode: 0 };
  };
}

function godMethodSource(lines: number): string {
  const body = Array.from({ length: lines }, (_, i) => `    int v${i} = ${i};`).join("\n");
  return `public class God {\n  public void huge() {\n${body}\n  }\n}\n`;
}

function complexSource(branches: number): string {
  const body = Array.from({ length: branches }, (_, i) => `    if (x > ${i}) { y += ${i}; }`).join("\n");
  return `public class Complex {\n  public int branchy(int x) {\n    int y = 0;\n${body}\n    return y;\n  }\n}\n`;
}

test("runInventory scores planted risky artifacts and leaves plain artifacts at zero (US1, AC 1.1-1.5)", async () => {
  const root = fixtureRoot();
  const db = createDb();
  try {
    writeJava(root, "app/src/main/java/com/acme/Reflecty.java",
      "public class Reflecty {\n  public Object load(String n) throws Exception {\n    return Class.forName(n).getDeclaredConstructor().newInstance();\n  }\n}\n");
    writeJava(root, "app/src/main/java/com/acme/God.java", godMethodSource(100));
    writeJava(root, "app/src/main/java/com/acme/Complex.java", complexSource(20));
    writeJava(root, "app/src/main/java/com/acme/PlainUtil.java",
      "public class PlainUtil {\n  public int add(int a, int b) { return a + b; }\n}\n");

    await runInventory(db, root, {
      scanAndRegister: undefined, // use the real scanner so fixtures register like production
      startPolling: () => () => undefined,
      refreshCompatibilityAudits: auditsStub,
      spawnAgent: fakeClassifyAgent(db),
    });

    const byId = (suffix: string) =>
      (db.prepare("SELECT id FROM artifacts WHERE id LIKE ?").pluck().all(`%${suffix}`) as string[]).find((id) => id.endsWith(suffix))!;

    const reflecty = readRisk(db, byId("Reflecty"))!;
    const god = readRisk(db, byId("God"))!;
    const complex = readRisk(db, byId("Complex"))!;
    const plain = readRisk(db, byId("PlainUtil"))!;

    assert.ok(reflecty, "reflection artifact has a stored risk row");
    assert.ok(god, "god-method artifact has a stored risk row");
    assert.ok(complex, "complexity artifact has a stored risk row");
    assert.ok(plain, "plain artifact has a stored risk row (FR-001: every artifact)");

    assert.ok(
      (JSON.parse(reflecty.reason_codes_json) as string[]).some((c) => c.startsWith("reflection-usage:")),
      `reflection reason code present: ${reflecty.reason_codes_json}`,
    );
    assert.ok(
      (JSON.parse(god.reason_codes_json) as string[]).some((c) => c.startsWith("god-method:")),
      `god-method reason code present: ${god.reason_codes_json}`,
    );
    assert.ok(
      (JSON.parse(complex.reason_codes_json) as string[]).some((c) => c.startsWith("cyclomatic-complexity:")),
      `complexity reason code present: ${complex.reason_codes_json}`,
    );

    assert.ok(reflecty.risk_score > plain.risk_score, "reflection scores above plain");
    assert.ok(god.risk_score > plain.risk_score, "god-method scores above plain");
    assert.ok(complex.risk_score > plain.risk_score, "complexity scores above plain");

    assert.equal(plain.risk_score, 0);
    assert.equal(plain.reason_codes_json, "[]");
  } finally {
    db.close();
  }
});

test("re-running inventory recomputes and replaces risk data — never accumulates (FR-015)", async () => {
  const root = fixtureRoot();
  const db = createDb();
  try {
    const godPath = writeJava(root, "app/src/main/java/com/acme/God.java", godMethodSource(100));

    await runInventory(db, root, {
      startPolling: () => () => undefined,
      refreshCompatibilityAudits: auditsStub,
      spawnAgent: fakeClassifyAgent(db),
    });

    const idRow = (db.prepare("SELECT id FROM artifacts WHERE id LIKE ?").pluck().all("%God") as string[])[0]!;
    const first = readRisk(db, idRow)!;
    assert.ok((JSON.parse(first.reason_codes_json) as string[]).some((c) => c.startsWith("god-method:")),
      "first run flags the God method");

    // Mutate the fixture so it's no longer a God method, then re-run inventory.
    fs.writeFileSync(path.join(root, godPath), "public class God {\n  public int tiny() { return 1; }\n}\n", "utf8");

    await runInventory(db, root, {
      startPolling: () => () => undefined,
      refreshCompatibilityAudits: auditsStub,
      spawnAgent: fakeClassifyAgent(db),
    });

    const second = readRisk(db, idRow)!;
    assert.deepEqual(JSON.parse(second.reason_codes_json), [],
      `stale god-method reason code must be gone: ${second.reason_codes_json}`);
    assert.equal(second.risk_score, 0);

    const count = db.prepare("SELECT COUNT(*) AS c FROM artifact_risk_assessments WHERE artifact_id = ?").get(idRow) as { c: number };
    assert.equal(count.c, 1, "row replaced in place, not accumulated");
  } finally {
    db.close();
  }
});
