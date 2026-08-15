import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { applySchema } from "../registry/db/schema";
import { registerArtifact } from "../registry/commands/artifacts";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

interface ColumnInfo { name: string; notnull: number; pk: number }

function columns(db: Database.Database, table: string): ColumnInfo[] {
  return db.prepare(`SELECT name, "notnull", pk FROM pragma_table_info(?)`).all(table) as ColumnInfo[];
}

function names(db: Database.Database, type: "table" | "index"): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .pluck()
    .all(type) as string[];
}

test("applySchema creates artifact_risk_assessments with the documented columns", () => {
  const db = createDb();
  try {
    assert.ok(names(db, "table").includes("artifact_risk_assessments"));
    const cols = columns(db, "artifact_risk_assessments");
    assert.deepEqual(
      cols.map((c) => c.name),
      ["artifact_id", "risk_score", "high_risk", "reason_codes_json", "signals_json", "updated_at"],
    );
    assert.equal(cols.find((c) => c.name === "artifact_id")?.pk, 1);
    assert.equal(cols.find((c) => c.name === "risk_score")?.notnull, 1);
    assert.equal(cols.find((c) => c.name === "high_risk")?.notnull, 1);
    assert.equal(cols.find((c) => c.name === "reason_codes_json")?.notnull, 1);
    assert.equal(cols.find((c) => c.name === "signals_json")?.notnull, 1);
  } finally {
    db.close();
  }
});

test("applySchema creates risk_confirmations with the documented columns, decision defaulting to pending", () => {
  const db = createDb();
  try {
    assert.ok(names(db, "table").includes("risk_confirmations"));
    const cols = columns(db, "risk_confirmations");
    assert.deepEqual(
      cols.map((c) => c.name),
      ["artifact_id", "decision", "decided_by", "decided_at", "created_at"],
    );
    assert.equal(cols.find((c) => c.name === "artifact_id")?.pk, 1);
  } finally {
    db.close();
  }
});

test("applySchema creates idx_artifact_risk_assessments_high_risk and idx_risk_confirmations_decision", () => {
  const db = createDb();
  try {
    const indexes = names(db, "index");
    assert.ok(indexes.includes("idx_artifact_risk_assessments_high_risk"));
    assert.ok(indexes.includes("idx_risk_confirmations_decision"));
  } finally {
    db.close();
  }
});

test("artifact_risk_assessments CHECK constraints reject risk_score < 0 and high_risk outside (0,1)", () => {
  const db = createDb();
  try {
    registerArtifact(db, { id: "legacy-source:com.acme:Foo", kind: "legacy-source", tier: "first-class", path: "legacy/Foo.java" });

    assert.throws(() => {
      db.prepare(`
        INSERT INTO artifact_risk_assessments (artifact_id, risk_score, high_risk, reason_codes_json, signals_json)
        VALUES ('legacy-source:com.acme:Foo', -1, 0, '[]', '{}')
      `).run();
    }, /CHECK constraint failed/);

    assert.throws(() => {
      db.prepare(`
        INSERT INTO artifact_risk_assessments (artifact_id, risk_score, high_risk, reason_codes_json, signals_json)
        VALUES ('legacy-source:com.acme:Foo', 10, 2, '[]', '{}')
      `).run();
    }, /CHECK constraint failed/);

    // A valid row must still succeed.
    db.prepare(`
      INSERT INTO artifact_risk_assessments (artifact_id, risk_score, high_risk, reason_codes_json, signals_json)
      VALUES ('legacy-source:com.acme:Foo', 10, 0, '[]', '{}')
    `).run();
    const row = db.prepare("SELECT risk_score, high_risk FROM artifact_risk_assessments WHERE artifact_id = ?").get("legacy-source:com.acme:Foo") as { risk_score: number; high_risk: number };
    assert.equal(row.risk_score, 10);
    assert.equal(row.high_risk, 0);
  } finally {
    db.close();
  }
});

test("risk_confirmations CHECK constraint rejects decision outside pending/confirmed/declined, defaults to pending", () => {
  const db = createDb();
  try {
    registerArtifact(db, { id: "legacy-source:com.acme:Bar", kind: "legacy-source", tier: "first-class", path: "legacy/Bar.java" });

    assert.throws(() => {
      db.prepare(`
        INSERT INTO risk_confirmations (artifact_id, decision) VALUES ('legacy-source:com.acme:Bar', 'maybe')
      `).run();
    }, /CHECK constraint failed/);

    db.prepare(`INSERT INTO risk_confirmations (artifact_id) VALUES ('legacy-source:com.acme:Bar')`).run();
    const row = db.prepare("SELECT decision FROM risk_confirmations WHERE artifact_id = ?").get("legacy-source:com.acme:Bar") as { decision: string };
    assert.equal(row.decision, "pending");
  } finally {
    db.close();
  }
});
