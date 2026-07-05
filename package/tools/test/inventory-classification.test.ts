import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import type { AgentRunResult } from "../guildctl/runner";
import { applyBatchClassification, classifyArtifactSource, loadClassificationSpec, validateInventoryQuality } from "../guildctl/classification";
import { runInventory } from "../guildctl/commands/inventory";
import { runPlan } from "../guildctl/commands/plan";
import { loadStackPack } from "../guildctl/stack";
import { registerArtifact } from "../registry/commands/artifacts";
import { applySchema } from "../registry/db/schema";

const repoRoot = path.resolve(__dirname, "..", "..");

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function fixtureRoot(stack = "java-spring"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guild-inventory-quality-"));
  fs.cpSync(path.join(repoRoot, "stacks"), path.join(root, "stacks"), { recursive: true });
  fs.mkdirSync(path.join(root, ".guild"), { recursive: true });
  fs.writeFileSync(path.join(root, ".guild", "config.yaml"), `version: 1\nstack: ${stack}\n`);
  return root;
}

function writeJava(root: string, rel: string, content: string): string {
  const file = path.join(root, "legacy", "src", "main", "java", ...rel.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
  return path.relative(root, file).split(path.sep).join("/");
}

function register(db: Database.Database, id: string, filePath: string): void {
  registerArtifact(db, { id, kind: "legacy-source", tier: "first-class", path: filePath });
}

const javaCases: Array<[string, string, string, string]> = [
  ["ServletController", "import javax.servlet.http.HttpServlet; class ServletController extends HttpServlet {}", "servlet", "rest-endpoint"],
  ["AuthFilter", "import jakarta.servlet.Filter; class AuthFilter implements Filter {}", "servlet", "filter"],
  ["SaveAction", "import org.apache.struts.action.Action; class SaveAction extends Action {}", "struts", "rest-endpoint"],
  ["Resource", "import javax.ws.rs.Path; @Path(\"/x\") class Resource {}", "jax-rs", "rest-endpoint"],
  ["Controller", "import org.springframework.web.bind.annotation.RestController; @RestController class Controller {}", "spring-mvc", "rest-endpoint"],
  ["Account", "import jakarta.persistence.Entity; @Entity class Account {}", "jpa", "model"],
  ["AccountRepository", "import org.springframework.data.jpa.repository.JpaRepository; interface AccountRepository extends JpaRepository<Account, Long> {}", "jpa", "interface"],
  ["BillingBean", "import javax.ejb.Stateless; @Stateless class BillingBean {}", "ejb", "service"],
  ["GuiceModule", "import com.google.inject.AbstractModule; class GuiceModule extends AbstractModule {}", "guice", "module"],
  ["WidgetTest", "import org.junit.Test; class WidgetTest { @Test void ok() {} }", "junit", "test"],
  ["PlainUtil", "class PlainUtil { int add(int a, int b) { return a + b; } }", "plain-java", "utility"],
];

test("Java stack classification detects common frameworks and roles without Java-EE fallback", () => {
  const root = fixtureRoot();
  const pack = loadStackPack("java-spring", root);
  const spec = loadClassificationSpec(pack);

  for (const [name, source, framework, role] of javaCases) {
    const filePath = writeJava(root, `com/acme/${name}.java`, `package com.acme;\n${source}\n`);
    const result = classifyArtifactSource(spec, { id: `legacy-source:com.acme:${name}`, path: filePath }, root);
    assert.equal(result.framework, framework, name);
    assert.equal(result.role, role, name);
    assert.notEqual(result.framework, "Java-EE");
    assert.ok(result.evidence.length > 0);
  }
});

test("framework aliases normalize and unsupported frameworks are rejected atomically", () => {
  const root = fixtureRoot();
  const spec = loadClassificationSpec(loadStackPack("java-spring", root));
  const db = createDb();
  try {
    const pathA = writeJava(root, "com/acme/A.java", "class A {}");
    const pathB = writeJava(root, "com/acme/B.java", "class B {}");
    register(db, "legacy-source:com.acme:A", pathA);
    register(db, "legacy-source:com.acme:B", pathB);

    const dryRun = applyBatchClassification(db, spec, [
      { id: "legacy-source:com.acme:A", module: "com.acme", role: "utility", framework: "plain Java", confidence: 0.7, evidence: ["no framework imports"] },
    ], { dryRun: true });
    assert.equal(dryRun.accepted, 1);
    assert.equal(db.prepare("SELECT framework FROM artifacts WHERE id = ?").pluck().get("legacy-source:com.acme:A"), null);

    assert.throws(() => applyBatchClassification(db, spec, [
      { id: "legacy-source:com.acme:A", module: "com.acme", role: "utility", framework: "plain Java", confidence: 0.7, evidence: ["no framework imports"] },
      { id: "legacy-source:com.acme:B", module: "com.acme", role: "utility", framework: "Java-EE", confidence: 0.2, evidence: ["generic guess"] },
    ]), /unsupported framework/i);

    assert.deepEqual(db.prepare("SELECT id, framework FROM artifacts ORDER BY id").all(), [
      { id: "legacy-source:com.acme:A", framework: null },
      { id: "legacy-source:com.acme:B", framework: null },
    ]);
  } finally {
    db.close();
  }
});

test("ambiguous evidence is surfaced instead of silently defaulting", () => {
  const root = fixtureRoot();
  const spec = loadClassificationSpec(loadStackPack("java-spring", root));
  const filePath = writeJava(root, "com/acme/AmbiguousEndpoint.java", "import javax.ws.rs.Path; import org.springframework.web.bind.annotation.RestController; @Path(\"/x\") @RestController class AmbiguousEndpoint {}");
  const result = classifyArtifactSource(spec, { id: "legacy-source:com.acme:AmbiguousEndpoint", path: filePath }, root);
  assert.equal(result.framework, "ambiguous");
  assert.equal(result.ambiguous, true);
  assert.match(result.evidence.join("\n"), /jax-rs/);
  assert.match(result.evidence.join("\n"), /spring-mvc/);
});

test("inventory quality rejects missing fields, generic-only tags, unexpected registrations, high fallback concentration, and observed Java-EE distribution", () => {
  const root = fixtureRoot();
  const spec = loadClassificationSpec(loadStackPack("java-spring", root));
  const db = createDb();
  try {
    for (let i = 0; i < 623; i++) {
      const id = `legacy-source:com.acme:C${i}`;
      register(db, id, `legacy/src/main/java/com/acme/C${i}.java`);
      db.prepare("UPDATE artifacts SET module = 'com.acme', role = 'utility', framework = ? WHERE id = ?").run(i < 368 ? "Java-EE" : "plain-java", id);
      db.prepare("INSERT INTO artifact_tags (artifact_id, tag) VALUES (?, 'analyzed')").run(id);
    }
    register(db, "legacy-source:com.acme:Extra", "legacy/src/main/java/com/acme/Extra.java");
    const expected = Array.from({ length: 623 }, (_, i) => `legacy-source:com.acme:C${i}`);
    const report = validateInventoryQuality(db, spec, { expectedArtifactIds: expected, completionStatus: "completed" });
    assert.equal(report.valid, false);
    assert.equal(report.expectedCount, 623);
    assert.equal(report.classifiedCount, 623);
    assert.ok(report.invalidFrameworkValues["Java-EE"] >= 368);
    assert.ok(report.frameworkDistribution["Java-EE"] >= 368);
    assert.ok(report.fallbackPercentage > 50);
    assert.ok(report.genericOnlyTagCount >= 623);
    assert.deepEqual(report.unexpectedRegistrations, ["legacy-source:com.acme:Extra"]);
  } finally {
    db.close();
  }
});

test("exit zero without completion evidence and timeout/abnormal termination fail inventory", async () => {
  const root = fixtureRoot();
  const db = createDb();
  try {
    const filePath = writeJava(root, "com/acme/PlainUtil.java", "class PlainUtil {}");
    register(db, "legacy-source:com.acme:PlainUtil", filePath);

    await assert.rejects(() => runInventory(db, root, {
      scanAndRegister: () => 0,
      startPolling: () => () => undefined,
      refreshCompatibilityAudits: () => ({ artifact_count: 1, jvm: { critical: 0, warnings: 0 }, dependencies: { total: 0, unresolved: 0 }, tools: [] }),
      spawnAgent: async ({ agent, model, prompt }): Promise<AgentRunResult> => ({ runId: "r1", agent, model, prompt, exitCode: 0 }),
    }), /completion evidence/i);

    db.prepare("INSERT OR REPLACE INTO operator_state (key, value) VALUES ('inventory_completion', ?)").run(JSON.stringify({ status: "completed" }));
    await assert.rejects(() => runInventory(db, root, {
      scanAndRegister: () => 0,
      startPolling: () => () => undefined,
      refreshCompatibilityAudits: () => ({ artifact_count: 1, jvm: { critical: 0, warnings: 0 }, dependencies: { total: 0, unresolved: 0 }, tools: [] }),
      spawnAgent: async ({ agent, model, prompt }): Promise<AgentRunResult> => ({ runId: "r2", agent, model, prompt, exitCode: 124 }),
    }), /exited with code 124/);
  } finally {
    db.close();
  }
});

test("runPlan refuses invalid inventory and valid Java and Python inventories can proceed", async () => {
  const javaRoot = fixtureRoot("java-spring");
  const javaSpec = loadClassificationSpec(loadStackPack("java-spring", javaRoot));
  const db = createDb();
  try {
    const p = writeJava(javaRoot, "com/acme/PlainUtil.java", "class PlainUtil {}");
    register(db, "legacy-source:com.acme:PlainUtil", p);
    db.prepare("UPDATE artifacts SET module='com.acme', role='utility', framework='Java-EE'").run();
    assert.equal(validateInventoryQuality(db, javaSpec).valid, false);
    await assert.rejects(() => runPlan(db, {
      workspaceRoot: javaRoot,
      refreshCompatibilityAudits: () => ({ artifact_count: 1, jvm: { critical: 0, warnings: 0 }, dependencies: { total: 0, unresolved: 0 }, tools: [] }),
      startPolling: () => () => undefined,
      spawnAgent: async ({ agent, model, prompt }) => ({ runId: agent, agent, model, prompt, exitCode: 0 }),
      getLogDir: () => "/tmp",
    }), /Inventory quality gate blocked planning/);

    applyBatchClassification(db, javaSpec, [{ id: "legacy-source:com.acme:PlainUtil", module: "com.acme", role: "utility", framework: "plain-java", confidence: 0.7, evidence: ["no framework imports"] }]);
    await runPlan(db, {
      workspaceRoot: javaRoot,
      refreshCompatibilityAudits: () => ({ artifact_count: 1, jvm: { critical: 0, warnings: 0 }, dependencies: { total: 0, unresolved: 0 }, tools: [] }),
      startPolling: () => () => undefined,
      spawnAgent: async ({ agent, model, prompt }) => ({ runId: agent, agent, model, prompt, exitCode: 0 }),
      getLogDir: () => "/tmp",
    });

    const pyRoot = fixtureRoot("python");
    const pySpec = loadClassificationSpec(loadStackPack("python", pyRoot));
    const pyDb = createDb();
    try {
      register(pyDb, "legacy-source:pkg:util", "legacy/src/pkg/util.py");
      applyBatchClassification(pyDb, pySpec, [{ id: "legacy-source:pkg:util", module: "pkg", role: "utility", framework: "plain-python", confidence: 0.8, evidence: ["no framework imports"] }]);
      assert.equal(validateInventoryQuality(pyDb, pySpec).valid, true);
    } finally {
      pyDb.close();
    }
  } finally {
    db.close();
  }
});
