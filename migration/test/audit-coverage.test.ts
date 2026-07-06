import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { registerArtifact } from "../registry/commands/artifacts";
import { applySchema } from "../registry/db/schema";
import { runAuditCoverage } from "../guildctl/commands/audit";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function setupWorkspace(javaFiles: string[]): { tmp: string; fileMap: Map<string, string> } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "guild-audit-"));
  fs.mkdirSync(path.join(tmp, ".guild"), { recursive: true });
  fs.writeFileSync(path.join(tmp, ".guild", "config.yaml"), "stack: java-spring");
  const fileMap = new Map<string, string>();
  for (const name of javaFiles) {
    const filePath = path.join(tmp, "legacy", "src", "main", "java", "com", "acme", name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `package com.acme; public class ${name.replace(".java", "")} {}`);
    fileMap.set(name, path.relative(tmp, filePath));
  }
  return { tmp, fileMap };
}

function cleanup(tmp: string) {
  fs.rmSync(tmp, { recursive: true, force: true });
}

test("coverage audit passes when all files registered and terminal", () => {
  const { tmp, fileMap } = setupWorkspace(["Service.java", "Controller.java"]);
  const db = createDb();
  try {
    registerArtifact(db, {
      id: "legacy-source:com.acme:Service",
      kind: "legacy-source",
      path: fileMap.get("Service.java")!,
      tier: "first-class",
    });
    db.prepare("UPDATE artifacts SET status = 'completed' WHERE id = ?").run("legacy-source:com.acme:Service");

    registerArtifact(db, {
      id: "legacy-source:com.acme:Controller",
      kind: "legacy-source",
      path: fileMap.get("Controller.java")!,
      tier: "first-class",
    });
    db.prepare("UPDATE artifacts SET status = 'skipped' WHERE id = ?").run("legacy-source:com.acme:Controller");

    registerArtifact(db, {
      id: "target-source:com.acme:Controller",
      kind: "target-source",
      path: path.join("target", "src", "main", "java", "com", "acme", "Controller.java"),
      tier: "second-class",
    });
    fs.mkdirSync(path.join(tmp, "target", "src", "main", "java", "com", "acme"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "target", "src", "main", "java", "com", "acme", "Controller.java"), "package com.acme;");
    db.prepare("UPDATE artifacts SET status = 'reviewed' WHERE id = ?").run("target-source:com.acme:Controller");

    const result = runAuditCoverage(db, tmp);
    assert.deepEqual(result.onDiskNotRegistered, []);
    assert.deepEqual(result.registeredMissingOnDisk, []);
    assert.deepEqual(result.registeredNonTerminal, []);
  } finally {
    db.close();
    cleanup(tmp);
  }
});

test("coverage audit detects files on disk not registered", () => {
  const { tmp, fileMap } = setupWorkspace(["Service.java", "Controller.java"]);
  const db = createDb();
  try {
    registerArtifact(db, {
      id: "legacy-source:com.acme:Service",
      kind: "legacy-source",
      path: fileMap.get("Service.java")!,
      tier: "first-class",
    });
    db.prepare("UPDATE artifacts SET status = 'completed' WHERE id = ?").run("legacy-source:com.acme:Service");

    const result = runAuditCoverage(db, tmp);
    assert.equal(result.onDiskNotRegistered.length, 1);
    assert.ok(result.onDiskNotRegistered[0].includes("Controller.java"));
  } finally {
    db.close();
    cleanup(tmp);
  }
});

test("coverage audit detects registered artifacts missing on disk", () => {
  const { tmp, fileMap } = setupWorkspace(["Service.java"]);
  const db = createDb();
  try {
    registerArtifact(db, {
      id: "legacy-source:com.acme:Service",
      kind: "legacy-source",
      path: fileMap.get("Service.java")!,
      tier: "first-class",
    });
    db.prepare("UPDATE artifacts SET status = 'completed' WHERE id = ?").run("legacy-source:com.acme:Service");

    registerArtifact(db, {
      id: "legacy-source:com.acme:Deleted",
      kind: "legacy-source",
      path: "legacy/src/main/java/com/acme/Deleted.java",
      tier: "first-class",
    });
    db.prepare("UPDATE artifacts SET status = 'completed' WHERE id = ?").run("legacy-source:com.acme:Deleted");

    const result = runAuditCoverage(db, tmp);
    assert.equal(result.registeredMissingOnDisk.length, 1);
    assert.ok(result.registeredMissingOnDisk[0].includes("Deleted.java"));
  } finally {
    db.close();
    cleanup(tmp);
  }
});

test("coverage audit detects non-terminal artifacts", () => {
  const { tmp, fileMap } = setupWorkspace(["Service.java"]);
  const db = createDb();
  try {
    registerArtifact(db, {
      id: "legacy-source:com.acme:Service",
      kind: "legacy-source",
      path: fileMap.get("Service.java")!,
      tier: "first-class",
    });
    // Default status is 'pending' — non-terminal

    const result = runAuditCoverage(db, tmp);
    assert.equal(result.registeredNonTerminal.length, 1);
    assert.ok(result.registeredNonTerminal[0].includes("Service.java"));
  } finally {
    db.close();
    cleanup(tmp);
  }
});
