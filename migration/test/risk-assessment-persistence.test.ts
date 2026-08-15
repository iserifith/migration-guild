import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { applySchema } from "../registry/db/schema";
import { registerArtifact } from "../registry/commands/artifacts";
import { applyRiskAssessment, applyBatchRiskAssessment, type RiskAssessmentRecord } from "../guildctl/risk";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function registerFirstClass(db: Database.Database, name: string): string {
  const id = `legacy-source:com.acme:${name}`;
  registerArtifact(db, { id, kind: "legacy-source", tier: "first-class", path: `legacy/${name}.java` });
  return id;
}

interface Row { artifact_id: string; risk_score: number; high_risk: number; reason_codes_json: string; signals_json: string }

function readRow(db: Database.Database, id: string): Row | undefined {
  return db.prepare("SELECT artifact_id, risk_score, high_risk, reason_codes_json, signals_json FROM artifact_risk_assessments WHERE artifact_id = ?").get(id) as Row | undefined;
}

test("applyRiskAssessment upserts via INSERT ... ON CONFLICT DO UPDATE — a second call replaces, never accumulates", () => {
  const db = createDb();
  try {
    const id = registerFirstClass(db, "A1");
    const first: RiskAssessmentRecord = {
      id,
      riskScore: 40,
      highRisk: false,
      reasonCodes: ["god-method:foo@L1 (100 lines > 80)"],
      signals: { godMethod: { worstLines: 100 } },
    };
    applyRiskAssessment(db, first);
    let row = readRow(db, id)!;
    assert.equal(row.risk_score, 40);
    assert.equal(row.high_risk, 0);
    assert.deepEqual(JSON.parse(row.reason_codes_json), ["god-method:foo@L1 (100 lines > 80)"]);

    const second: RiskAssessmentRecord = {
      id,
      riskScore: 90,
      highRisk: true,
      reasonCodes: ["reflection-usage:java-class-forName"],
      signals: { reflection: { hits: 1 } },
    };
    applyRiskAssessment(db, second);
    row = readRow(db, id)!;
    assert.equal(row.risk_score, 90);
    assert.equal(row.high_risk, 1);
    // Replaced, not accumulated — the first call's reason code must be gone.
    assert.deepEqual(JSON.parse(row.reason_codes_json), ["reflection-usage:java-class-forName"]);
    assert.deepEqual(JSON.parse(row.signals_json), { reflection: { hits: 1 } });

    // Exactly one row for this artifact, never many.
    const count = db.prepare("SELECT COUNT(*) AS c FROM artifact_risk_assessments WHERE artifact_id = ?").get(id) as { c: number };
    assert.equal(count.c, 1);
  } finally {
    db.close();
  }
});

test("applyBatchRiskAssessment writes multiple artifacts in one transaction", () => {
  const db = createDb();
  try {
    const idA = registerFirstClass(db, "A2");
    const idB = registerFirstClass(db, "A3");
    applyBatchRiskAssessment(db, [
      { id: idA, riskScore: 0, highRisk: false, reasonCodes: [], signals: {} },
      { id: idB, riskScore: 55, highRisk: true, reasonCodes: ["cyclomatic-complexity:bar@L1 (complexity 20 > 15)"], signals: { cyclomaticComplexity: { worstValue: 20 } } },
    ]);
    assert.equal(readRow(db, idA)!.risk_score, 0);
    assert.equal(readRow(db, idB)!.high_risk, 1);
  } finally {
    db.close();
  }
});

test("reason_codes_json and signals_json are always valid JSON (array / object respectively)", () => {
  const db = createDb();
  try {
    const id = registerFirstClass(db, "A4");
    // An empty reason-code list (plain artifact) must still be a valid JSON array, not null/empty-string.
    applyRiskAssessment(db, { id, riskScore: 0, highRisk: false, reasonCodes: [], signals: {} });
    const row = readRow(db, id)!;
    assert.doesNotThrow(() => JSON.parse(row.reason_codes_json));
    assert.doesNotThrow(() => JSON.parse(row.signals_json));
    assert.deepEqual(JSON.parse(row.reason_codes_json), []);
    assert.deepEqual(JSON.parse(row.signals_json), {});
    assert.ok(Array.isArray(JSON.parse(row.reason_codes_json)));
    assert.equal(typeof JSON.parse(row.signals_json), "object");
  } finally {
    db.close();
  }
});

test("high_risk is set correctly against the effective high_risk_score_cutoff", () => {
  const db = createDb();
  try {
    const idA = registerFirstClass(db, "A5");
    const idB = registerFirstClass(db, "A6");
    // Cutoff is applied by the caller (scoreArtifact); persistence just stores the flag verbatim.
    applyRiskAssessment(db, { id: idA, riskScore: 50, highRisk: false, reasonCodes: [], signals: {} });
    applyRiskAssessment(db, { id: idB, riskScore: 51, highRisk: true, reasonCodes: ["god-method:x@L1 (1 lines > 0)"], signals: {} });
    assert.equal(readRow(db, idA)!.high_risk, 0);
    assert.equal(readRow(db, idB)!.high_risk, 1);
  } finally {
    db.close();
  }
});

interface ConfirmationRow { artifact_id: string; decision: string; decided_by: string | null }

function readConfirmation(db: Database.Database, id: string): ConfirmationRow | undefined {
  return db.prepare("SELECT artifact_id, decision, decided_by FROM risk_confirmations WHERE artifact_id = ?").get(id) as ConfirmationRow | undefined;
}

test("high-risk assessment creates a pending risk_confirmations row; low-risk does not (US3)", () => {
  const db = createDb();
  try {
    const high = registerFirstClass(db, "R1");
    const low = registerFirstClass(db, "R2");
    applyRiskAssessment(db, { id: high, riskScore: 90, highRisk: true, reasonCodes: ["reflection-usage:x"], signals: {} });
    applyRiskAssessment(db, { id: low, riskScore: 10, highRisk: false, reasonCodes: [], signals: {} });
    assert.equal(readConfirmation(db, high)?.decision, "pending");
    assert.equal(readConfirmation(db, high)?.decided_by, null);
    assert.equal(readConfirmation(db, low), undefined, "low-risk artifact gets no confirmation row");
  } finally {
    db.close();
  }
});

test("recompute does NOT reset an existing confirmed/declined decision back to pending", () => {
  const db = createDb();
  try {
    const id = registerFirstClass(db, "R3");
    applyRiskAssessment(db, { id, riskScore: 90, highRisk: true, reasonCodes: ["reflection-usage:x"], signals: {} });
    db.prepare("UPDATE risk_confirmations SET decision = 'confirmed', decided_by = 'operator', decided_at = datetime('now') WHERE artifact_id = ?").run(id);
    // Re-score the same artifact, still high-risk (e.g. after a re-inventory).
    applyRiskAssessment(db, { id, riskScore: 95, highRisk: true, reasonCodes: ["reflection-usage:x"], signals: {} });
    const row = readConfirmation(db, id)!;
    assert.equal(row.decision, "confirmed", "existing confirmed decision is preserved");
    assert.equal(row.decided_by, "operator");
  } finally {
    db.close();
  }
});
