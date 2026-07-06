import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { registerArtifact } from "../registry/commands/artifacts";
import {
  addAcceptanceEvidence,
  getLatestArbitrationDecision,
  listAcceptanceEvidence,
  recordArbitrationDecision,
} from "../registry/commands/evidence";
import { applySchema } from "../registry/db/schema";
import { RegistryError } from "../registry/types";

const ARTIFACT_ID = "legacy-source:com.acme.customer:LegacyCustomerService";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function registerFixtureArtifact(db: Database.Database): void {
  registerArtifact(db, {
    id: ARTIFACT_ID,
    kind: "legacy-source",
    path: "legacy/src/main/java/com/acme/customer/LegacyCustomerService.java",
    tier: "first-class",
  });
}

test("schema creates acceptance evidence and arbitration tables", () => {
  const db = createDb();
  try {
    const tables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('acceptance_evidence', 'arbitration_decisions') ORDER BY name`,
    ).all() as Array<{ name: string }>;

    assert.deepEqual(tables.map((row) => row.name), ["acceptance_evidence", "arbitration_decisions"]);
  } finally {
    db.close();
  }
});

test("evidence rows require an existing artifact", () => {
  const db = createDb();
  try {
    assert.throws(
      () => addAcceptanceEvidence(db, {
        artifactId: ARTIFACT_ID,
        producedBy: "review-agent",
        evidenceType: "test-command",
        command: "npm test",
        exitCode: 0,
        pass: 1,
        summary: "tests passed",
      }),
      RegistryError,
    );
  } finally {
    db.close();
  }
});

test("evidence pass value must be 0 or 1", () => {
  const db = createDb();
  try {
    registerFixtureArtifact(db);

    assert.throws(() => addAcceptanceEvidence(db, {
      artifactId: ARTIFACT_ID,
      producedBy: "review-agent",
      evidenceType: "test-command",
      command: "npm test",
      exitCode: 0,
      pass: 2 as 0 | 1,
      summary: "invalid pass value",
    }));
  } finally {
    db.close();
  }
});

test("arbitration records JSON evidence IDs and returns latest decision", () => {
  const db = createDb();
  try {
    registerFixtureArtifact(db);
    const evidence = addAcceptanceEvidence(db, {
      artifactId: ARTIFACT_ID,
      producedBy: "review-agent",
      evidenceType: "test-command",
      command: "npm test --prefix migration -- evidence-gate.test.ts",
      exitCode: 0,
      pass: 1,
      summary: "evidence gate tests passed",
    });

    const rejected = recordArbitrationDecision(db, {
      artifactId: ARTIFACT_ID,
      arbiter: "arbiter-agent",
      decision: "rejected",
      reason: "needs clearer output proof",
      evidenceIds: [evidence.evidence_id],
    });
    const approved = recordArbitrationDecision(db, {
      artifactId: ARTIFACT_ID,
      arbiter: "arbiter-agent",
      decision: "approved",
      reason: "independent passing evidence supplied",
      evidenceIds: [evidence.evidence_id],
    });

    assert.deepEqual(JSON.parse(rejected.evidence_ids), [evidence.evidence_id]);
    assert.deepEqual(JSON.parse(approved.evidence_ids), [evidence.evidence_id]);
    assert.equal(getLatestArbitrationDecision(db, ARTIFACT_ID)?.decision_id, approved.decision_id);
  } finally {
    db.close();
  }
});

test("helpers list newest evidence records first", () => {
  const db = createDb();
  try {
    registerFixtureArtifact(db);
    const first = addAcceptanceEvidence(db, {
      artifactId: ARTIFACT_ID,
      producedBy: "review-agent",
      evidenceType: "static-check",
      command: "npm run lint",
      exitCode: 0,
      pass: 1,
      summary: "static check passed",
    });
    const second = addAcceptanceEvidence(db, {
      artifactId: ARTIFACT_ID,
      producedBy: "review-agent",
      evidenceType: "test-command",
      command: "npm test",
      exitCode: 0,
      pass: 1,
      summary: "tests passed",
      outputExcerpt: "ok 1 - evidence gate",
    });

    const rows = listAcceptanceEvidence(db, ARTIFACT_ID);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].evidence_id, second.evidence_id);
    assert.equal(rows[1].evidence_id, first.evidence_id);
    assert.equal(rows[0].output_excerpt, "ok 1 - evidence gate");
  } finally {
    db.close();
  }
});
