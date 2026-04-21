import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { phaseState, printNextSteps } from "../legmod/commands/status";
import { registerArtifact, setArtifactStatus, setArtifactWave } from "../registry/commands/artifacts";
import { applySchema } from "../registry/db/schema";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function registerFirstClassArtifact(
  db: Database.Database,
  id: string,
  status: "planned" | "skipped" | "reviewed",
  wave = 1,
): void {
  registerArtifact(db, {
    id,
    kind: "legacy-source",
    path: `legacy/src/main/java/${id.replaceAll(":", "/")}.java`,
    tier: "first-class",
  });
  setArtifactWave(db, id, wave);
  setArtifactStatus(db, id, status);
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

test("phaseState treats skipped artifacts as completed for migration and review gating", () => {
  const db = createDb();

  try {
    registerFirstClassArtifact(db, "legacy-source:com.acme:SkippedOne", "skipped");
    registerFirstClassArtifact(db, "legacy-source:com.acme:ReviewedOne", "reviewed");

    assert.deepEqual(phaseState(db), {
      total: 2,
      planned: 2,
      migrated: 2,
      reviewed: 2,
    });
  } finally {
    db.close();
  }
});

test("printNextSteps reports completion when all planned artifacts are skipped", () => {
  const db = createDb();

  try {
    registerFirstClassArtifact(db, "legacy-source:com.acme:SkippedOnly", "skipped");

    const output = captureStdout(() => {
      printNextSteps(db);
    });

    assert.match(output, /All phases complete!/);
    assert.doesNotMatch(output, /run migrate --parallel 3/);
    assert.doesNotMatch(output, /run review --parallel 2/);
  } finally {
    db.close();
  }
});
