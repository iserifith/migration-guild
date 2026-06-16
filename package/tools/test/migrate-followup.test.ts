import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { getMigrationFollowUp } from "../guildctl/commands/migrate";
import { registerArtifact, setArtifactStatus, setArtifactWave } from "../registry/commands/artifacts";
import { applySchema } from "../registry/db/schema";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

test("getMigrationFollowUp points to run history when ready work remains after failures", () => {
  const db = createDb();

  try {
    registerArtifact(db, {
      id: "legacy-source:com.acme:WidgetService",
      kind: "legacy-source",
      tier: "first-class",
      path: "legacy/src/main/java/com/acme/WidgetService.java",
    });
    setArtifactStatus(db, "legacy-source:com.acme:WidgetService", "planned");
    setArtifactWave(db, "legacy-source:com.acme:WidgetService", 1);

    assert.deepEqual(getMigrationFollowUp(db, undefined, true), {
      summary: "One or more migration sessions failed before work could advance.",
      command: "node migration/registry/dist/cli.js list-runs --limit 20",
    });
  } finally {
    db.close();
  }
});
