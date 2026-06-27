import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { applySchema } from "../registry/db/schema";
import { scanAndRegister } from "../guildctl/commands/inventory";
import { refreshCompatibilityAudits } from "../guildctl/audit";
import { bootstrapTargetModule } from "../guildctl/commands/bootstrap";
import { detectStack, interpolate, loadStackPack } from "../guildctl/stack";
import { scaffoldGuildConfig } from "../guildctl/config";

const repoRoot = path.resolve(__dirname, "..", "..");

test("Java pack drives detection, inventory, audit, and scaffold without executable pack logic", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guild-stack-pack-"));
  fs.cpSync(path.join(repoRoot, "stacks"), path.join(root, "stacks"), { recursive: true });
  const source = path.join(root, "legacy", "src", "main", "java", "com", "acme", "LegacyService.java");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, "package com.acme;\nimport org.apache.log4j.Logger;\nclass LegacyService { SecurityManager manager; }\n");
  fs.writeFileSync(path.join(root, "legacy", "build.gradle"), "implementation 'log4j:log4j:1.2.17'\n");
  scaffoldGuildConfig(root);

  assert.equal(detectStack(root), "java-spring");
  const pack = loadStackPack("java-spring", root);
  assert.equal(pack.rules.length, 8);

  const db = new Database(":memory:");
  applySchema(db);
  assert.equal(scanAndRegister(db, root), 1);
  assert.deepEqual(db.prepare("SELECT id, path FROM artifacts").get(), {
    id: "legacy-source:com.acme:LegacyService",
    path: "legacy/src/main/java/com/acme/LegacyService.java",
  });

  const audit = refreshCompatibilityAudits(db, root);
  assert.deepEqual(audit.jvm, { critical: 0, warnings: 1 });
  assert.deepEqual(audit.dependencies, { total: 1, unresolved: 1 });
  assert.equal(db.prepare("SELECT summary FROM dependency_findings").pluck().get(), "EOL Log4j 1.x API detected (1.2.17)");

  db.prepare("UPDATE artifacts SET tier = 'first-class', module = 'com.acme', role = 'service'").run();
  const result = bootstrapTargetModule(root, [{ path: "legacy/src/main/java/com/acme/LegacyService.java", module: "com.acme", role: "service", framework: null }]);
  assert.equal(result.projectType, "service");
  assert.equal(result.template, "build.gradle.service.template");
  assert.ok(fs.readFileSync(path.join(root, "modern", "build.gradle"), "utf8").includes("group = 'com.acme'"));
  assert.ok(fs.existsSync(path.join(root, "modern", "src", "main", "java", "com", "acme", "AcmeApplication.java")));
  db.close();
});

test("stack interpolation rejects vocabulary outside the locked set", () => {
  assert.equal(interpolate("{symbol} L{line}", { symbol: "x", line: 4 }), "x L4");
  assert.throws(() => interpolate("{project}", {}), /Unsupported stack-pack placeholder/);
});

test("Python pack selects the fixture and drives inventory, audit, and library scaffold as pure data", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guild-python-pack-"));
  fs.cpSync(path.join(repoRoot, "stacks"), path.join(root, "stacks"), { recursive: true });
  fs.cpSync(path.join(repoRoot, "package", "mock", "legacy-python-utils"), path.join(root, "legacy"), { recursive: true });

  assert.equal(detectStack(root), "python");
  const init = spawnSync(process.execPath, ["--import", path.join(repoRoot, "migration", "node_modules", "tsx", "dist", "loader.mjs"), path.join(repoRoot, "migration", "guildctl", "cli.ts"), "init"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(init.status, 0, init.stderr);
  const configPath = path.join(root, ".guild", "config.yaml");
  assert.match(fs.readFileSync(configPath, "utf8"), /^stack: python$/m);

  const pack = loadStackPack("python", root);
  assert.equal(pack.manifest.test_framework, "pytest");
  assert.deepEqual(pack.manifest.source_globs, ["**/*.py"]);
  assert.equal(pack.rules.length, 7);

  const previousCwd = process.cwd();
  process.chdir(root);
  const db = new Database(":memory:");
  try {
    applySchema(db);
    assert.equal(scanAndRegister(db, root), 3);
    assert.deepEqual(
      db.prepare("SELECT path FROM artifacts ORDER BY path").pluck().all(),
      [
        "legacy/src/legacy_python_utils/__init__.py",
        "legacy/src/legacy_python_utils/names.py",
        "legacy/tests/test_names.py",
      ],
    );

    const source = path.join(root, "legacy", "src", "legacy_python_utils", "names.py");
    fs.appendFileSync(source, "\nfor index in xrange(3):\n    print index\n");
    const audit = refreshCompatibilityAudits(db, root);
    assert.deepEqual(audit.jvm, { critical: 1, warnings: 1 });

    const artifacts = [{ path: "legacy/src/legacy_python_utils/names.py", module: "legacy_python_utils", role: "utility", framework: null }];
    const result = bootstrapTargetModule(root, artifacts);
    assert.equal(result.projectType, "library");
    assert.equal(result.template, "pyproject.library.toml.template");
    assert.ok(fs.existsSync(path.join(root, "modern", "pyproject.toml")));
    assert.ok(fs.existsSync(path.join(root, "modern", "src", "legacy_python_utils")));
    assert.ok(fs.existsSync(path.join(root, "modern", "tests", "legacy_python_utils")));
  } finally {
    db.close();
    process.chdir(previousCwd);
  }
});
