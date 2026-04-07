import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { printWavePlan } from "../legmod/dashboard";
import { registerArtifact, setArtifactStatus, setArtifactWave } from "../registry/commands/artifacts";
import { applySchema } from "../registry/db/schema";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    chunks.push(args.map(String).join(" "));
  };

  try {
    fn();
  } finally {
    console.log = originalLog;
  }

  return chunks.join("\n");
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

test("printWavePlan treats migrated artifacts as done, not active", () => {
  const db = createDb();

  try {
    registerArtifact(db, {
      id: "legacy-source:com.acme:WidgetService",
      kind: "legacy-source",
      tier: "first-class",
      path: "legacy/src/main/java/com/acme/WidgetService.java",
    });
    setArtifactWave(db, "legacy-source:com.acme:WidgetService", 1);
    setArtifactStatus(db, "legacy-source:com.acme:WidgetService", "migrated");

    const output = stripAnsi(captureStdout(() => {
      printWavePlan(db);
    }));

    assert.match(output, /1\/1/);
    assert.doesNotMatch(output, /active/);
  } finally {
    db.close();
  }
});
