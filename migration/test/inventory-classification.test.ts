import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import type { AgentRunResult } from "../guildctl/runner";
import { applyBatchClassification, classifyArtifactSource, deriveArtifactModule, loadClassificationSpec, validateInventoryQuality } from "../guildctl/classification";
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

function writeJava(root: string, relFromLegacy: string, content: string): string {
  const file = path.join(root, "legacy", ...relFromLegacy.split("/"));
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
  const spec = loadClassificationSpec(loadStackPack("java-spring", root));

  for (const [name, source, framework, role] of javaCases) {
    const filePath = writeJava(root, `app/src/main/java/com/acme/${name}.java`, `package com.acme;\n${source}\n`);
    const result = classifyArtifactSource(spec, { id: `legacy-source:app:${name}`, path: filePath }, root);
    assert.equal(result.framework, framework, name);
    assert.equal(result.role, role, name);
    assert.equal(result.module, framework === "junit" ? "app" : "app");
    assert.notEqual(result.framework, "Java-EE");
    assert.ok(result.evidence.length > 0);
  }
});

test("module semantics use build/source-set ownership instead of Java package", () => {
  const root = fixtureRoot();
  const spec = loadClassificationSpec(loadStackPack("java-spring", root));

  assert.equal(deriveArtifactModule(spec, "legacy/app/src/main/java/org/apache/Widget.java"), "app");
  assert.equal(deriveArtifactModule(spec, "legacy/app/src/test/java/org/apache/WidgetTest.java"), "app-test");
  assert.equal(deriveArtifactModule(spec, "legacy/it-selenium/src/test/java/org/apache/SeleniumTest.java"), "it-selenium-test");
  assert.equal(deriveArtifactModule(spec, "legacy/db-utils/src/main/java/org/apache/DbUtil.java"), "db-utils");

  const filePath = writeJava(root, "app/src/main/java/org/apache/PlainUtil.java", "package org.apache; class PlainUtil {}");
  const result = classifyArtifactSource(spec, { id: "legacy-source:app:PlainUtil", path: filePath }, root);
  assert.equal(result.module, "app");
});

test("framework aliases normalize and unsupported frameworks are rejected atomically", () => {
  const root = fixtureRoot();
  const spec = loadClassificationSpec(loadStackPack("java-spring", root));
  const db = createDb();
  try {
    const pathA = writeJava(root, "app/src/main/java/com/acme/A.java", "class A {}");
    const pathB = writeJava(root, "app/src/main/java/com/acme/B.java", "class B {}");
    register(db, "legacy-source:app:A", pathA);
    register(db, "legacy-source:app:B", pathB);

    const dryRun = applyBatchClassification(db, spec, [
      { id: "legacy-source:app:A", module: "app", role: "utility", framework: "plain Java", confidence: 0.8, evidence: ["negative-evidence: no configured framework signal matched"] },
    ], { dryRun: true });
    assert.equal(dryRun.accepted, 1);
    assert.equal(db.prepare("SELECT framework FROM artifacts WHERE id = ?").pluck().get("legacy-source:app:A"), null);

    assert.throws(() => applyBatchClassification(db, spec, [
      { id: "legacy-source:app:A", module: "app", role: "utility", framework: "plain Java", confidence: 0.8, evidence: ["negative-evidence: no configured framework signal matched"] },
      { id: "legacy-source:app:B", module: "app", role: "utility", framework: "Java-EE", confidence: 0.2, evidence: ["generic guess"] },
    ]), /unsupported framework/i);

    assert.deepEqual(db.prepare("SELECT id, framework FROM artifacts ORDER BY id").all(), [
      { id: "legacy-source:app:A", framework: null },
      { id: "legacy-source:app:B", framework: null },
    ]);
  } finally {
    db.close();
  }
});

test("ambiguous evidence is surfaced instead of silently defaulting", () => {
  const root = fixtureRoot();
  const spec = loadClassificationSpec(loadStackPack("java-spring", root));
  const filePath = writeJava(root, "app/src/main/java/com/acme/AmbiguousEndpoint.java", "import javax.ws.rs.Path; import org.springframework.web.bind.annotation.RestController; @Path(\"/x\") @RestController class AmbiguousEndpoint {}");
  const result = classifyArtifactSource(spec, { id: "legacy-source:app:AmbiguousEndpoint", path: filePath }, root);
  assert.equal(result.framework, "ambiguous");
  assert.equal(result.ambiguous, true);
  assert.match(result.evidence.join("\n"), /jax-rs/);
  assert.match(result.evidence.join("\n"), /spring-mvc/);
});

test("inventory quality rejects missing fields, generic-only tags, unexpected registrations, and observed Java-EE distribution", () => {
  const root = fixtureRoot();
  const spec = loadClassificationSpec(loadStackPack("java-spring", root));
  const db = createDb();
  try {
    for (let i = 0; i < 623; i++) {
      const id = `legacy-source:app:C${i}`;
      register(db, id, `legacy/app/src/main/java/com/acme/C${i}.java`);
      db.prepare("UPDATE artifacts SET module = 'app', role = 'utility', framework = ? WHERE id = ?").run(i < 368 ? "Java-EE" : "plain-java", id);
      db.prepare("INSERT INTO artifact_tags (artifact_id, tag) VALUES (?, 'analyzed')").run(id);
    }
    register(db, "legacy-source:app:Extra", "legacy/app/src/main/java/com/acme/Extra.java");
    const expected = Array.from({ length: 623 }, (_, i) => `legacy-source:app:C${i}`);
    const report = validateInventoryQuality(db, spec, { expectedArtifactIds: expected, completionStatus: "completed" });
    assert.equal(report.valid, false);
    assert.equal(report.expectedCount, 623);
    assert.equal(report.classifiedCount, 623);
    assert.ok(report.invalidFrameworkValues["Java-EE"] >= 368);
    assert.ok(report.frameworkDistribution["Java-EE"] >= 368);
    assert.ok(report.fallbackPercentage > 50);
    assert.ok(report.genericOnlyTagCount >= 623);
    assert.deepEqual(report.unexpectedRegistrations, ["legacy-source:app:Extra"]);
  } finally {
    db.close();
  }
});

test("fallback-heavy inventory passes with high-confidence negative evidence", () => {
  const root = fixtureRoot();
  const spec = loadClassificationSpec(loadStackPack("java-spring", root));
  const db = createDb();
  try {
    const records = [];
    for (let i = 0; i < 100; i++) {
      const id = `legacy-source:app:Plain${i}`;
      const p = writeJava(root, `app/src/main/java/com/acme/Plain${i}.java`, `package com.acme; class Plain${i} {}`);
      register(db, id, p);
      records.push({ id, module: "app", role: "utility" as const, framework: "plain-java", confidence: 0.85, evidence: ["negative-evidence: no configured framework signal matched"] });
    }
    applyBatchClassification(db, spec, records);
    const report = validateInventoryQuality(db, spec, { completionStatus: "completed", workspaceRoot: root });
    assert.equal(report.valid, true, report.errors.join("\n"));
    assert.equal(report.fallbackPercentage, 100);
  } finally {
    db.close();
  }
});

test("fallback rejects missed known framework signals and low-confidence negative evidence", () => {
  const root = fixtureRoot();
  const spec = loadClassificationSpec(loadStackPack("java-spring", root));
  const db = createDb();
  try {
    const springPath = writeJava(root, "app/src/main/java/com/acme/MissedController.java", "import org.springframework.web.bind.annotation.RestController; @RestController class MissedController {}");
    const lowPath = writeJava(root, "app/src/main/java/com/acme/PlainLow.java", "class PlainLow {}");
    register(db, "legacy-source:app:MissedController", springPath);
    register(db, "legacy-source:app:PlainLow", lowPath);
    applyBatchClassification(db, spec, [
      { id: "legacy-source:app:MissedController", module: "app", role: "utility", framework: "plain-java", confidence: 0.9, evidence: ["negative-evidence: no configured framework signal matched"] },
      { id: "legacy-source:app:PlainLow", module: "app", role: "utility", framework: "plain-java", confidence: 0.4, evidence: ["negative-evidence: no configured framework signal matched"] },
    ]);
    const report = validateInventoryQuality(db, spec, { completionStatus: "completed", workspaceRoot: root });
    assert.equal(report.valid, false);
    assert.match(report.errors.join("\n"), /missed configured framework signal/);
    assert.match(report.errors.join("\n"), /low-confidence fallback/);
  } finally {
    db.close();
  }
});

test("inventory rollback removes agent-registered first- and second-class artifacts but preserves pre-existing second-class artifacts", async () => {
  const root = fixtureRoot();
  const db = createDb();
  try {
    const p = writeJava(root, "app/src/main/java/com/acme/PlainUtil.java", "class PlainUtil {}");
    register(db, "legacy-source:app:PlainUtil", p);
    registerArtifact(db, { id: "descriptor:app:web", kind: "descriptor", tier: "second-class", path: "legacy/app/src/main/webapp/WEB-INF/web.xml" });

    await assert.rejects(() => runInventory(db, root, {
      scanAndRegister: () => 0,
      startPolling: () => () => undefined,
      refreshCompatibilityAudits: () => ({ artifact_count: 1, jvm: { critical: 0, warnings: 0 }, dependencies: { total: 0, unresolved: 0 }, tools: [] }),
      spawnAgent: async ({ agent, model, prompt }): Promise<AgentRunResult> => {
        registerArtifact(db, { id: "legacy-source:app:Unauthorized", kind: "legacy-source", tier: "first-class", path: "legacy/app/src/main/java/com/acme/Unauthorized.java" });
        registerArtifact(db, { id: "descriptor:app:struts", kind: "descriptor", tier: "second-class", path: "legacy/app/src/main/resources/struts.xml" });
        db.prepare("INSERT OR REPLACE INTO operator_state (key, value) VALUES ('inventory_completion', ?)").run(JSON.stringify({ status: "completed" }));
        return { runId: "r-pollute", agent, model, prompt, exitCode: 0 };
      },
    }), /unexpected registration/i);

    assert.deepEqual(db.prepare("SELECT id FROM artifacts ORDER BY id").pluck().all(), ["descriptor:app:web", "legacy-source:app:PlainUtil"]);
    assert.equal(JSON.parse(db.prepare("SELECT value FROM operator_state WHERE key = 'inventory_completion'").pluck().get() as string).status, "failed");
  } finally {
    db.close();
  }
});

test("exit zero without completion evidence and timeout/abnormal termination fail inventory", async () => {
  const root = fixtureRoot();
  const db = createDb();
  try {
    const filePath = writeJava(root, "app/src/main/java/com/acme/PlainUtil.java", "class PlainUtil {}");
    register(db, "legacy-source:app:PlainUtil", filePath);

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
    const p = writeJava(javaRoot, "app/src/main/java/com/acme/PlainUtil.java", "class PlainUtil {}");
    register(db, "legacy-source:app:PlainUtil", p);
    db.prepare("UPDATE artifacts SET module='app', role='utility', framework='Java-EE'").run();
    assert.equal(validateInventoryQuality(db, javaSpec).valid, false);
    await assert.rejects(() => runPlan(db, {
      workspaceRoot: javaRoot,
      refreshCompatibilityAudits: () => ({ artifact_count: 1, jvm: { critical: 0, warnings: 0 }, dependencies: { total: 0, unresolved: 0 }, tools: [] }),
      startPolling: () => () => undefined,
      spawnAgent: async ({ agent, model, prompt }) => ({ runId: agent, agent, model, prompt, exitCode: 0 }),
      getLogDir: () => "/tmp",
    }), /Inventory quality gate blocked planning/);

    applyBatchClassification(db, javaSpec, [{ id: "legacy-source:app:PlainUtil", module: "app", role: "utility", framework: "plain-java", confidence: 0.8, evidence: ["negative-evidence: no configured framework signal matched"] }]);
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
      applyBatchClassification(pyDb, pySpec, [{ id: "legacy-source:pkg:util", module: "pkg", role: "utility", framework: "plain-python", confidence: 0.8, evidence: ["negative-evidence: no configured framework signal matched"] }]);
      assert.equal(validateInventoryQuality(pyDb, pySpec).valid, true);
    } finally {
      pyDb.close();
    }
  } finally {
    db.close();
  }
});
