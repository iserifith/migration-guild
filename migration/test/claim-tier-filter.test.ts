import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { claimNextTask } from "../registry/commands/claim";
import { registerArtifact, setArtifactStatus, setArtifactWave } from "../registry/commands/artifacts";
import { listReadyToMigrate } from "../registry/commands/queries";
import { linkArtifacts } from "../registry/commands/dependencies";
import { applySchema } from "../registry/db/schema";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

test("claimNextTask skips second-class artifacts when tier is first-class", () => {
  const db = createDb();

  try {
    registerArtifact(db, {
      id: "config:com.acme:application.yml",
      kind: "properties",
      tier: "second-class",
      path: "legacy/src/main/resources/application.yml",
    });
    setArtifactStatus(db, "config:com.acme:application.yml", "planned");

    registerArtifact(db, {
      id: "legacy-source:com.acme:WidgetService",
      kind: "legacy-source",
      tier: "first-class",
      path: "legacy/src/main/java/com/acme/WidgetService.java",
    });
    setArtifactStatus(db, "legacy-source:com.acme:WidgetService", "planned");
    setArtifactWave(db, "legacy-source:com.acme:WidgetService", 1);

    const claimed = claimNextTask(db, "test-writer-agent", undefined, "planned", "gpt-5.4-mini", "first-class");

    assert.equal(claimed.id, "legacy-source:com.acme:WidgetService");
    const untouched = db.prepare("SELECT status FROM artifacts WHERE id = ?").get("config:com.acme:application.yml") as { status: string };
    assert.equal(untouched.status, "planned");
  } finally {
    db.close();
  }
});

test("listReadyToMigrate returns only artifacts from the requested tier", () => {
  const db = createDb();

  try {
    registerArtifact(db, {
      id: "legacy-source:com.acme:ReadyService",
      kind: "legacy-source",
      tier: "first-class",
      path: "legacy/src/main/java/com/acme/ReadyService.java",
    });
    setArtifactStatus(db, "legacy-source:com.acme:ReadyService", "planned");
    setArtifactWave(db, "legacy-source:com.acme:ReadyService", 1);

    registerArtifact(db, {
      id: "legacy-source:com.acme:BlockedService",
      kind: "legacy-source",
      tier: "first-class",
      path: "legacy/src/main/java/com/acme/BlockedService.java",
    });
    setArtifactStatus(db, "legacy-source:com.acme:BlockedService", "planned");
    setArtifactWave(db, "legacy-source:com.acme:BlockedService", 2);

    registerArtifact(db, {
      id: "config:com.acme:data.sql",
      kind: "sql-schema",
      tier: "second-class",
      path: "legacy/src/main/resources/data.sql",
    });
    setArtifactStatus(db, "config:com.acme:data.sql", "planned");

    linkArtifacts(db, "legacy-source:com.acme:BlockedService", "config:com.acme:data.sql", "related-issue");

    const firstClassReady = listReadyToMigrate(db, undefined, "first-class").map((artifact) => artifact.id);
    const secondClassReady = listReadyToMigrate(db, undefined, "second-class").map((artifact) => artifact.id);

    assert.deepEqual(firstClassReady, ["legacy-source:com.acme:ReadyService"]);
    assert.deepEqual(secondClassReady, ["config:com.acme:data.sql"]);
  } finally {
    db.close();
  }
});
