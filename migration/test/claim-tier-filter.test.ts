import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { claimNextTask } from "../registry/commands/claim";
import { registerArtifact, setArtifactStatus, setArtifactWave } from "../registry/commands/artifacts";
import { listReadyToMigrate } from "../registry/commands/queries";
import { linkArtifacts } from "../registry/commands/dependencies";
import { applySchema } from "../registry/db/schema";
import { getClaimabilityStats } from "../guildctl/monitoring";

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

    assert.deepEqual(firstClassReady, [
      "legacy-source:com.acme:ReadyService",
      "legacy-source:com.acme:BlockedService",
    ]);
    assert.deepEqual(secondClassReady, ["config:com.acme:data.sql"]);
  } finally {
    db.close();
  }
});

test("first-class artifact with only second-class dependency is ready and claimable", () => {
  const db = createDb();

  try {
    registerArtifact(db, {
      id: "legacy-source:com.acme:BillingService",
      kind: "legacy-source",
      tier: "first-class",
      path: "legacy/src/main/java/com/acme/BillingService.java",
    });
    setArtifactStatus(db, "legacy-source:com.acme:BillingService", "planned");
    setArtifactWave(db, "legacy-source:com.acme:BillingService", 1);

    registerArtifact(db, {
      id: "config:com.acme:billing.yml",
      kind: "properties",
      tier: "second-class",
      path: "legacy/src/main/resources/billing.yml",
    });
    setArtifactStatus(db, "config:com.acme:billing.yml", "analyzed");

    linkArtifacts(db, "legacy-source:com.acme:BillingService", "config:com.acme:billing.yml", "related-issue");

    const ready = listReadyToMigrate(db, undefined, "first-class").map((artifact) => artifact.id);
    assert.deepEqual(ready, ["legacy-source:com.acme:BillingService"]);

    const statsBeforeClaim = getClaimabilityStats(db, "planned");
    assert.equal(statsBeforeClaim.ready, 1);
    assert.equal(statsBeforeClaim.blocked, 0);

    const claimed = claimNextTask(
      db,
      "migration-agent",
      undefined,
      "planned",
      "gpt-5.4-mini",
      "first-class",
    );
    assert.equal(claimed.id, "legacy-source:com.acme:BillingService");
  } finally {
    db.close();
  }
});

test("first-class readiness is blocked only by non-terminal first-class dependencies", () => {
  const db = createDb();

  try {
    registerArtifact(db, {
      id: "legacy-source:com.acme:MainService",
      kind: "legacy-source",
      tier: "first-class",
      path: "legacy/src/main/java/com/acme/MainService.java",
    });
    setArtifactStatus(db, "legacy-source:com.acme:MainService", "planned");
    setArtifactWave(db, "legacy-source:com.acme:MainService", 1);

    registerArtifact(db, {
      id: "legacy-source:com.acme:CoreDependency",
      kind: "legacy-source",
      tier: "first-class",
      path: "legacy/src/main/java/com/acme/CoreDependency.java",
    });
    setArtifactStatus(db, "legacy-source:com.acme:CoreDependency", "analyzed");

    registerArtifact(db, {
      id: "config:com.acme:app.yml",
      kind: "properties",
      tier: "second-class",
      path: "legacy/src/main/resources/app.yml",
    });
    setArtifactStatus(db, "config:com.acme:app.yml", "planned");

    linkArtifacts(db, "legacy-source:com.acme:MainService", "legacy-source:com.acme:CoreDependency", "source-of");
    linkArtifacts(db, "legacy-source:com.acme:MainService", "config:com.acme:app.yml", "related-issue");

    const readyBefore = listReadyToMigrate(db, undefined, "first-class").map((artifact) => artifact.id);
    assert.equal(readyBefore.includes("legacy-source:com.acme:MainService"), false);

    const statsBlocked = getClaimabilityStats(db, "planned");
    assert.equal(statsBlocked.ready, 0);
    assert.equal(statsBlocked.blocked, 1);

    setArtifactStatus(db, "legacy-source:com.acme:CoreDependency", "completed");

    const readyAfter = listReadyToMigrate(db, undefined, "first-class").map((artifact) => artifact.id);
    assert.equal(readyAfter.includes("legacy-source:com.acme:MainService"), true);

    const statsReady = getClaimabilityStats(db, "planned");
    assert.equal(statsReady.ready, 1);
    assert.equal(statsReady.blocked, 0);

    const claimed = claimNextTask(
      db,
      "migration-agent",
      undefined,
      "planned",
      "gpt-5.4-mini",
      "first-class",
    );
    assert.equal(claimed.id, "legacy-source:com.acme:MainService");

    const stats = getClaimabilityStats(db, "planned");
    assert.equal(stats.ready, 0);
    assert.equal(stats.blocked, 0);
  } finally {
    db.close();
  }
});
