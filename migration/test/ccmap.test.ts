import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { applySchema } from "../registry/db/schema";
import { registerArtifact, setArtifactStatus, setArtifactWave } from "../registry/commands/artifacts";
import { appendEvent } from "../registry/commands/events";
import { buildCcMap } from "../guildctl/commands/ccmap";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function registerPlanned(db: Database.Database, id: string, wave = 1): void {
  registerArtifact(db, {
    id,
    kind: "legacy-source",
    tier: "first-class",
    path: `legacy/src/main/java/${id.replaceAll(":", "/")}.java`,
  });
  setArtifactWave(db, id, wave);
  setArtifactStatus(db, id, "planned");
}

test("buildCcMap projects the registry as wave/kind folders with status metrics", () => {
  const db = createDb();
  try {
    registerPlanned(db, "legacy-source:com.acme:Widget", 1);
    registerPlanned(db, "legacy-source:com.acme:Gadget", 2);
    setArtifactStatus(db, "legacy-source:com.acme:Gadget", "migrated");

    const map = buildCcMap(db, "test-project");

    // 2.0 envelope
    assert.equal(map.meta.apiVersion, "2.0");
    assert.equal(map.meta.projectName, "test-project");
    assert.ok(Array.isArray(map.files));
    assert.ok(map.lenses.metrics.attributes);
    assert.deepEqual(map.lenses.dependency.edges, []);

    // tree: guild / wave-01|02 / legacy-source / leaf
    const root = map.files[0];
    assert.equal(root.name, "guild");
    const waves = root.children!.map((c) => c.name).sort();
    assert.deepEqual(waves, ["wave-01", "wave-02"]);

    const wave1 = root.children!.find((c) => c.name === "wave-01")!;
    assert.equal(wave1.children!.length, 1);
    const kindFolder = wave1.children![0];
    assert.equal(kindFolder.name, "legacy-source");
    const leaf = kindFolder.children![0];
    assert.equal(leaf.type, "File");
    assert.equal(leaf.name, "legacy-source--com.acme--widget");
    assert.equal(leaf.link, "legacy/src/main/java/legacy-source/com.acme/Widget.java");

    // metrics keyed by node id; status_code matches STATUS_ORDER
    const attrs = map.lenses.metrics.attributes[leaf.id];
    assert.ok(attrs, "leaf has metric attributes");
    assert.equal(attrs.status_code, 1, "planned = index 1");
    assert.equal(attrs.wave, 1);

    const gadgetLeaf = Object.values(map.lenses.metrics.attributes).find((v) => v.status_code === 5);
    assert.ok(gadgetLeaf, "migrated artifact maps to status_code 5");
    assert.equal(gadgetLeaf!.wave, 2);
  } finally {
    db.close();
  }
});

test("buildCcMap counts events, evidence, verify slots, and claim age", () => {
  const db = createDb();
  try {
    registerPlanned(db, "legacy-source:com.acme:Chatty", 1);
    appendEvent(db, {
      id: "legacy-source:com.acme:Chatty",
      type: "status-changed",
      agent: "planner-agent",
      summary: "wave assigned",
    });
    db.prepare(
      `INSERT INTO acceptance_evidence (artifact_id, evidence_type, produced_by, pass, summary, output_path)
       VALUES ('legacy-source:com.acme:Chatty', 'runtime', 'test-agent', 1, 'char-fixture', 'x.txt')`,
    ).run();
    db.prepare(
      `INSERT INTO verify_slots (slot_id, artifact_id, lease_expires_at)
       VALUES ('slot-1', 'legacy-source:com.acme:Chatty', datetime('now', '+10 minutes'))`,
    ).run();

    const map = buildCcMap(db, "test-project");
    const leaf = map.files[0].children![0].children![0].children![0];
    const attrs = map.lenses.metrics.attributes[leaf.id];
    // ccmap must report exactly what the events table holds for this artifact —
    // the registry's status-change trigger adds events we don't count here.
    const dbEventCount = (
      db.prepare(`SELECT COUNT(*) AS n FROM events WHERE artifact_id = ?`).get("legacy-source:com.acme:Chatty") as {
        n: number;
      }
    ).n;
    assert.ok(dbEventCount >= 1);
    assert.equal(attrs.event_count, dbEventCount);
    assert.equal(attrs.evidence_count, 1);
    assert.equal(attrs.verify_slot_count, 1);
    assert.ok(attrs.claim_age_days >= 0);
  } finally {
    db.close();
  }
});

test("buildCcMap handles empty registry without crashing", () => {
  const db = createDb();
  try {
    const map = buildCcMap(db, "empty");
    assert.equal(map.files[0].name, "guild");
    assert.deepEqual(map.files[0].children, []);
    assert.equal(Object.keys(map.lenses.metrics.attributes).length, 0);
  } finally {
    db.close();
  }
});
