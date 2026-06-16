import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { registerArtifact } from "../registry/commands/artifacts";
import { appendEvent, getEvents } from "../registry/commands/events";
import { applySchema } from "../registry/db/schema";
import type { EventType } from "../registry/types";

const ARTIFACT_ID = "legacy-source:com.acme.customer:LegacyCustomerService";

const DIALOGUE_EVENT_TYPES: EventType[] = [
  "proposal-submitted",
  "evidence-submitted",
  "critique-issued",
  "arbitration-approved",
  "arbitration-rejected",
  "conflict-opened",
  "conflict-resolved",
  "benchmark-recorded",
];

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  registerArtifact(db, {
    id: ARTIFACT_ID,
    kind: "legacy-source",
    path: "legacy/src/main/java/com/acme/customer/LegacyCustomerService.java",
    tier: "first-class",
  });
  return db;
}

test("appendEvent accepts Track 3 dialogue event types", () => {
  const db = createDb();
  try {
    for (const type of DIALOGUE_EVENT_TYPES) {
      appendEvent(db, {
        id: ARTIFACT_ID,
        type,
        agent: "migration-orchestrator",
        summary: `recorded ${type}`,
        data: JSON.stringify({ role: "critic", event_type: type }),
      });
    }

    const events = getEvents(db, ARTIFACT_ID, undefined, DIALOGUE_EVENT_TYPES.length);
    const seen = new Set(events.map((event) => event.type));
    for (const type of DIALOGUE_EVENT_TYPES) {
      assert.ok(seen.has(type), `${type} was not recorded`);
    }
  } finally {
    db.close();
  }
});

test("appendEvent still rejects invalid event types", () => {
  const db = createDb();
  try {
    assert.throws(() => appendEvent(db, {
      id: ARTIFACT_ID,
      type: "agent-gossip" as EventType,
      agent: "migration-orchestrator",
      summary: "invalid event",
    }), /Invalid event type/);
  } finally {
    db.close();
  }
});
