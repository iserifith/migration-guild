import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { registerArtifact, setArtifactStatus, setArtifactWave } from "../registry/commands/artifacts";
import { getEventsQuery } from "../registry/commands/queries";
import { applySchema } from "../registry/db/schema";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function registerFirstClassArtifact(db: Database.Database, id: string): void {
  registerArtifact(db, {
    id,
    kind: "legacy-source",
    path: `legacy/src/main/java/${id.replaceAll(":", "/")}.java`,
    tier: "first-class",
  });
  setArtifactWave(db, id, 1);
}

test("setArtifactStatus records a reasoned status-changed event when metadata is provided", () => {
  const db = createDb();

  try {
    const id = "legacy-source:com.acme.customer:LegacyCustomerKeyServiceTest";
    registerFirstClassArtifact(db, id);
    setArtifactStatus(db, id, "planned");

    setArtifactStatus(db, id, "skipped", {
      agent: "test-writer-agent",
      model: "claude-sonnet-4.6",
      reason: "Legacy JUnit 4 coverage is superseded by target-side JUnit 5 tests.",
    });

    const events = getEventsQuery(db, id, "status-changed") as Array<{
      agent: string;
      model: string | null;
      summary: string;
      event_data: { previous_status: string; new_status: string; reason: string | null } | null;
    }>;
    const skipEvent = events.find((event) => event.event_data?.new_status === "skipped");

    assert.ok(skipEvent);

    assert.equal(skipEvent.agent, "test-writer-agent");
    assert.equal(skipEvent.model, "claude-sonnet-4.6");
    assert.match(skipEvent.summary, /planned -> skipped/);
    assert.deepEqual(skipEvent.event_data, {
      previous_status: "planned",
      new_status: "skipped",
      reason: "Legacy JUnit 4 coverage is superseded by target-side JUnit 5 tests.",
    });
  } finally {
    db.close();
  }
});
