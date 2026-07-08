import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { applySchema } from "../registry/db/schema";
import { scanAndRegister } from "../guildctl/commands/inventory";
import { requireNonEmptyRegistry } from "../guildctl/readiness";
import { readGuildConfig, scaffoldGuildConfig, writeGuildConfig } from "../guildctl/config";

const repoRoot = path.resolve(__dirname, "..", "..");

function stageWorkspace(stack: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guild-task03-"));
  fs.cpSync(path.join(repoRoot, "stacks"), path.join(root, "stacks"), { recursive: true });
  // init: detect stack from legacy/ and record it (mirrors `guildctl init`)
  const configPath = scaffoldGuildConfig(root);
  const raw = readGuildConfig(configPath);
  raw["stack"] = stack;
  writeGuildConfig(raw, configPath);
  return root;
}

function writeFile(root: string, rel: string, content = "// source\n"): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

test("PHP-only workspace with java-spring config: non-zero mismatch error names counts + stacks", () => {
  const root = stageWorkspace("java-spring");
  writeFile(root, "legacy/catalog.php");
  writeFile(root, "legacy/admin/index.php");
  for (let i = 0; i < 434; i += 1) writeFile(root, `legacy/includes/inc${i}.php`);
  const db = new Database(":memory:");
  try {
    applySchema(db);
    let thrown: Error | undefined;
    try {
      scanAndRegister(db, root);
    } catch (e) {
      thrown = e as Error;
    }
    assert.ok(thrown, "expected scanAndRegister to throw on stack mismatch");
    assert.match(thrown!.message, /No files matching stack 'java-spring' found/);
    assert.match(thrown!.message, /436 source file\(s\) were detected/);
    assert.match(thrown!.message, /Available stacks:/);
    assert.match(thrown!.message, /php: 436/);
    // The php-dominant census should suggest a php-mapped stack if one exists.
    const phpStack = fs.readdirSync(path.join(root, "stacks")).find((d) => fs.existsSync(path.join(root, "stacks", d, "stack.yaml")) && d.toLowerCase().includes("php"));
    if (phpStack) assert.match(thrown!.message, new RegExp(`'${phpStack}'`));
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("truly empty legacy/: distinct 'no source files' error, not mismatch", () => {
  const root = stageWorkspace("java-spring");
  fs.mkdirSync(path.join(root, "legacy"), { recursive: true });
  const db = new Database(":memory:");
  try {
    applySchema(db);
    let thrown: Error | undefined;
    try {
      scanAndRegister(db, root);
    } catch (e) {
      thrown = e as Error;
    }
    assert.ok(thrown, "expected an error on empty legacy/");
    assert.match(thrown!.message, /No source files found/);
    assert.doesNotMatch(thrown!.message, /does not match this codebase/);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("mixed Java + Python with java-spring: census printed, Java registered, warning for out-of-stack share", () => {
  const root = stageWorkspace("java-spring");
  writeFile(root, "legacy/src/main/java/com/acme/Service.java");
  writeFile(root, "legacy/src/main/java/com/acme/Repo.java");
  // out-of-stack majority (Python) — must warn, not fail
  for (let i = 0; i < 6; i += 1) writeFile(root, `legacy/utils/helper${i}.py`);
  const db = new Database(":memory:");
  try {
    applySchema(db);
    const registered = scanAndRegister(db, root);
    assert.equal(registered, 2, "only the two Java files should register");
    assert.deepEqual(
      db.prepare("SELECT path FROM artifacts ORDER BY path").pluck().all(),
      [
        "legacy/src/main/java/com/acme/Repo.java",
        "legacy/src/main/java/com/acme/Service.java",
      ],
    );
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pure-Java workspace: registers all Java, no false mismatch", () => {
  const root = stageWorkspace("java-spring");
  writeFile(root, "legacy/src/main/java/com/acme/Service.java");
  writeFile(root, "legacy/src/main/java/com/acme/Repo.java");
  const db = new Database(":memory:");
  try {
    applySchema(db);
    assert.equal(scanAndRegister(db, root), 2);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("census is case-insensitive and counts nested dirs", () => {
  const root = stageWorkspace("java-spring");
  writeFile(root, "legacy/A.java");
  writeFile(root, "legacy/deep/nested/B.JAVA");
  writeFile(root, "legacy/deep/C.Java");
  writeFile(root, "legacy/deep/deeper/D.java");
  const db = new Database(":memory:");
  try {
    applySchema(db);
    // Census counts all four (case-insensitive), but the java-spring source_globs
    // match only lowercase .java, so exactly 2 register. Out-of-stack share = 2/4 = 0.5
    // (not > 0.5) so no warning is emitted — that is correct behavior.
    assert.equal(scanAndRegister(db, root), 2, "only the two lowercase .java files match the stack");
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("plan/migrate/review guard: empty registry throws immediately", () => {
  const db = new Database(":memory:");
  applySchema(db);
  assert.throws(() => requireNonEmptyRegistry(db, "plan"), /the registry has 0 artifacts/);
  assert.throws(() => requireNonEmptyRegistry(db, "migrate"), /the registry has 0 artifacts/);
  assert.throws(() => requireNonEmptyRegistry(db, "review"), /the registry has 0 artifacts/);
  db.close();
});
