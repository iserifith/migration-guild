import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "path";
import test from "node:test";
import Database from "better-sqlite3";
import { applySchema } from "../registry/db/schema";
import { registerArtifact } from "../registry/commands/artifacts";
import { listJvmAuditFindings, replaceJvmAuditFindings } from "../registry/commands/modernization";
import { refreshCompatibilityAudits } from "../guildctl/audit";
import { loadStackPack } from "../guildctl/stack";
import { scaffoldGuildConfig } from "../guildctl/config";
import { recordScopeDecision } from "../registry/commands/scope";

const repoRoot = path.resolve(__dirname, "..", "..");

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function freshWorkspace(stack = "java-spring"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guild-view-regen-"));
  fs.cpSync(path.join(repoRoot, "stacks"), path.join(root, "stacks"), { recursive: true });
  fs.cpSync(path.join(repoRoot, "package", "stacks"), path.join(root, "package", "stacks"), { recursive: true });
  fs.mkdirSync(path.join(root, ".guild"), { recursive: true });
  fs.writeFileSync(path.join(root, ".guild", "config.yaml"), `version: 1\nstack: ${stack}\n`);
  // Drop a build.gradle so detectStack / scaffoldGuildConfig are happy.
  fs.mkdirSync(path.join(root, "legacy"), { recursive: true });
  fs.writeFileSync(path.join(root, "legacy", "build.gradle"), "");
  fs.mkdirSync(path.join(root, "legacy", "src", "main", "java", "com", "acme"), { recursive: true });
  scaffoldGuildConfig(root);
  return root;
}

function registerFirstClassArtifact(db: Database.Database, id: string, filePath: string): void {
  const moduleName = id.split(":")[1] ?? "com.acme";
  registerArtifact(db, {
    id,
    kind: "legacy-source",
    path: filePath,
    tier: "first-class",
    module: moduleName,
    role: "service",
    framework: "plain-java",
  });
  recordScopeDecision(db, { module: moduleName, decision: "keep", reason: "test fixture", decidedBy: "test" });
}

test("view-regeneration rules fire on a JSP artifact", () => {
  const root = freshWorkspace();
  const jspPath = "legacy/src/main/webapp/pages/legacyPage.jsp";
  fs.mkdirSync(path.dirname(path.join(root, jspPath)), { recursive: true });
  fs.writeFileSync(
    path.join(root, jspPath),
    "<%@ page contentType=\"text/html\" %>\n<html><body><h1>Legacy</h1></body></html>\n",
  );

  const db = createDb();
  try {
    registerFirstClassArtifact(db, "legacy-source:com.acme:LegacyPage", jspPath);
    const summary = refreshCompatibilityAudits(db, root);
    // The JSP content hits view-regeneration-jsp; the count is > 0 to allow for
    // any cross-content regex matches that the engine reports per line.
    assert.ok(summary.jvm.critical >= 1, `expected at least one critical JVM finding, got ${JSON.stringify(summary.jvm)}`);

    const findings = listJvmAuditFindings(db, { artifactId: "legacy-source:com.acme:LegacyPage" });
    const viewRegen = findings.filter((f) => f.category === "view-regeneration");
    assert.ok(viewRegen.length >= 1, `expected at least one view-regeneration finding, got: ${JSON.stringify(findings)}`);
    assert.equal(viewRegen[0]!.severity, "critical");
    // Finding IDs are stable hashes, not rule ids; verify the JSP marker is in summary/symbol.
    assert.ok(
      viewRegen.some((f) => /<%@|<jsp:/.test(`${f.symbol ?? ""} ${f.summary ?? ""}`)),
      `expected JSP marker in view-regeneration finding summary/symbol, got: ${JSON.stringify(viewRegen)}`,
    );
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("view-regeneration rules fire on JSF imports in migrated code", () => {
  const root = freshWorkspace();
  const javaPath = "legacy/src/main/java/com/acme/FacesBacking.java";
  fs.writeFileSync(
    path.join(root, javaPath),
    "package com.acme;\nimport javax.faces.bean.ManagedBean;\n@ManagedBean(name = \"backing\")\npublic class FacesBacking {}\n",
  );

  const db = createDb();
  try {
    registerFirstClassArtifact(db, "legacy-source:com.acme:FacesBacking", javaPath);
    const summary = refreshCompatibilityAudits(db, root);
    assert.ok(summary.jvm.critical >= 1, `expected at least one critical JVM finding, got ${JSON.stringify(summary.jvm)}`);

    const findings = listJvmAuditFindings(db, { artifactId: "legacy-source:com.acme:FacesBacking" });
    const viewRegen = findings.filter((f) => f.category === "view-regeneration");
    assert.ok(viewRegen.length >= 1, `expected at least one view-regeneration finding, got: ${JSON.stringify(findings)}`);
    assert.ok(
      viewRegen.some((f) => /javax\.faces|jakarta\.faces/.test(`${f.symbol ?? ""} ${f.summary ?? ""}`)),
      `expected javax.faces/jakarta.faces marker in view-regeneration finding summary/symbol, got: ${JSON.stringify(viewRegen)}`,
    );
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("view-regeneration rules do NOT fire on a clean Spring REST controller", () => {
  const root = freshWorkspace();
  const javaPath = "legacy/src/main/java/com/acme/HelloController.java";
  fs.writeFileSync(
    path.join(root, javaPath),
    "package com.acme;\n" +
      "import org.springframework.web.bind.annotation.RestController;\n" +
      "import org.springframework.web.bind.annotation.GetMapping;\n" +
      "@RestController\npublic class HelloController {\n  @GetMapping(\"/hello\")\n  public String hello() { return \"hello\"; }\n}\n",
  );

  const db = createDb();
  try {
    registerFirstClassArtifact(db, "legacy-source:com.acme:HelloController", javaPath);
    refreshCompatibilityAudits(db, root);

    const findings = listJvmAuditFindings(db, { artifactId: "legacy-source:com.acme:HelloController" });
    const viewRegen = findings.filter((f) => f.category === "view-regeneration");
    assert.equal(
      viewRegen.length,
      0,
      `expected zero view-regeneration findings on a clean REST controller, got: ${JSON.stringify(viewRegen)}`,
    );
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("java-spring pack loads the four view-regeneration rules with view-regeneration category", () => {
  const root = freshWorkspace();
  try {
    const pack = loadStackPack("java-spring", root);
    const viewRegenRules = pack.rules.filter((rule) => rule.category === "view-regeneration");
    assert.equal(viewRegenRules.length, 4, `expected 4 view-regeneration rules, got ${viewRegenRules.length}`);
    const expectedIds = [
      "view-regeneration-jsp",
      "view-regeneration-jsf",
      "view-regeneration-legacy-view-imports",
      "view-regeneration-template-engine",
    ];
    for (const id of expectedIds) {
      assert.ok(
        viewRegenRules.some((rule) => rule.id === id),
        `java-spring pack must declare rule "${id}"`,
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("widened source_globs register .jsp and .xhtml artifacts as legacy-source", () => {
  const root = freshWorkspace();
  const jspPath = "legacy/src/main/webapp/pages/legacyPage.jsp";
  const xhtmlPath = "legacy/src/main/webapp/pages/legacyView.xhtml";
  fs.mkdirSync(path.dirname(path.join(root, jspPath)), { recursive: true });
  fs.writeFileSync(path.join(root, jspPath), "<%@ page contentType=\"text/html\" %>\n<html></html>\n");
  fs.writeFileSync(
    path.join(root, xhtmlPath),
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<html xmlns=\"http://www.w3.org/1999/xhtml\"\n      xmlns:h=\"http://java.sun.com/jsf/html\"><h:body /></html>\n",
  );

  const db = createDb();
  try {
    const { scanAndRegister } = require("../guildctl/commands/inventory");
    const registered = scanAndRegister(db, root);
    // At least the two view files must be discovered (others may exist too, e.g. auto-generated config).
    assert.ok(registered >= 2, `expected at least 2 artifacts registered, got ${registered}`);
    const rows = db.prepare("SELECT path FROM artifacts WHERE path LIKE '%.jsp' OR path LIKE '%.xhtml' ORDER BY path").all() as Array<{ path: string }>;
    const paths = rows.map((r) => r.path);
    assert.ok(paths.includes(jspPath), `expected ${jspPath} registered, got ${JSON.stringify(paths)}`);
    assert.ok(paths.includes(xhtmlPath), `expected ${xhtmlPath} registered, got ${JSON.stringify(paths)}`);
    for (const row of rows) {
      const kind = db.prepare("SELECT kind FROM artifacts WHERE path = ?").get(row.path) as { kind: string };
      assert.equal(kind.kind, "legacy-source", `${row.path} must register as legacy-source`);
    }
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("JvmAuditCategory union accepts view-regeneration (replaces failed runtime CHECK)", () => {
  const db = createDb();
  try {
    const id = "legacy-source:com.acme:RegegProbe";
    registerFirstClassArtifact(db, id, "legacy/src/main/java/com/acme/RegegProbe.java");
    // Inserting a finding with category=view-regeneration must succeed; if the
    // JvmAuditCategory union is missing the literal or the SQL CHECK has not
    // been widened, this insert throws.
    replaceJvmAuditFindings(db, id, [{
      tool: "source-scan",
      category: "view-regeneration",
      severity: "critical",
      symbol: "<%@",
      summary: "probe",
      evidence: "L1: probe",
      remediation: "probe",
    }]);
    const findings = listJvmAuditFindings(db, { artifactId: id });
    const regeg = findings.filter((f) => f.category === "view-regeneration");
    assert.equal(regeg.length, 1, `expected the probe finding to round-trip; got: ${JSON.stringify(findings)}`);
  } finally {
    db.close();
  }
});
