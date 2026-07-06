import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { registerArtifact, setArtifactStatus } from "../registry/commands/artifacts";
import { getEvents } from "../registry/commands/events";
import {
  addAcceptanceEvidence,
  approveArtifactWithEvidence,
  canApproveArtifact,
  getLatestArbitrationDecision,
  rejectArtifactWithEvidence,
} from "../registry/commands/evidence";
import { getArtifactById } from "../registry/commands/queries";
import { applySchema } from "../registry/db/schema";
import { RegistryError } from "../registry/types";

const ARTIFACT_ID = "legacy-source:com.acme.customer:LegacyCustomerService";

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

function markMigrated(db: Database.Database): void {
  setArtifactStatus(db, ARTIFACT_ID, "migrated", {
    agent: "builder-agent",
    reason: "builder submitted migration proposal",
  });
}

test("cannot approve a planned artifact", () => {
  const db = createDb();
  try {
    const result = canApproveArtifact(db, ARTIFACT_ID, "arbiter-agent");

    assert.equal(result.ok, false);
    assert.match(result.reason, /status.*migrated/i);
    assert.throws(
      () => approveArtifactWithEvidence(db, {
        artifactId: ARTIFACT_ID,
        arbiter: "arbiter-agent",
        reason: "accept proposal",
      }),
      RegistryError,
    );
    assert.equal(getArtifactById(db, ARTIFACT_ID).status, "pending");
  } finally {
    db.close();
  }
});

test("cannot approve a migrated artifact with no evidence", () => {
  const db = createDb();
  try {
    markMigrated(db);

    const result = canApproveArtifact(db, ARTIFACT_ID, "arbiter-agent");

    assert.equal(result.ok, false);
    assert.match(result.reason, /passing executable evidence/i);
  } finally {
    db.close();
  }
});

test("cannot approve when latest executable evidence fails", () => {
  const db = createDb();
  try {
    markMigrated(db);
    addAcceptanceEvidence(db, {
      artifactId: ARTIFACT_ID,
      producedBy: "critic-agent",
      evidenceType: "test-command",
      command: "npm test",
      exitCode: 0,
      pass: 1,
      summary: "tests passed",
    });
    const failing = addAcceptanceEvidence(db, {
      artifactId: ARTIFACT_ID,
      producedBy: "critic-agent",
      evidenceType: "test-command",
      command: "npm test",
      exitCode: 1,
      pass: 0,
      summary: "tests failed after retry",
    });

    const result = canApproveArtifact(db, ARTIFACT_ID, "arbiter-agent");

    assert.equal(result.ok, false);
    assert.deepEqual(result.evidenceIds, [failing.evidence_id]);
    assert.match(result.reason, /latest executable evidence failed/i);
  } finally {
    db.close();
  }
});

test("cannot approve when arbiter equals evidence producer", () => {
  const db = createDb();
  try {
    markMigrated(db);
    addAcceptanceEvidence(db, {
      artifactId: ARTIFACT_ID,
      producedBy: "arbiter-agent",
      evidenceType: "build-command",
      command: "npm run build",
      exitCode: 0,
      pass: 1,
      summary: "build passed",
    });

    const result = canApproveArtifact(db, ARTIFACT_ID, "arbiter-agent");

    assert.equal(result.ok, false);
    assert.match(result.reason, /arbiter.*evidence producer/i);
  } finally {
    db.close();
  }
});

test("can approve with independent passing test evidence", () => {
  const db = createDb();
  try {
    markMigrated(db);
    const evidence = addAcceptanceEvidence(db, {
      artifactId: ARTIFACT_ID,
      producedBy: "critic-agent",
      evidenceType: "test-command",
      command: "npm test --prefix migration",
      exitCode: 0,
      pass: 1,
      summary: "tool tests passed",
    });

    const decision = approveArtifactWithEvidence(db, {
      artifactId: ARTIFACT_ID,
      arbiter: "arbiter-agent",
      reason: "independent executable evidence passed",
    });

    assert.equal(decision.decision, "approved");
    assert.deepEqual(JSON.parse(decision.evidence_ids), [evidence.evidence_id]);
    assert.equal(getArtifactById(db, ARTIFACT_ID).status, "reviewed");
    assert.equal(getLatestArbitrationDecision(db, ARTIFACT_ID)?.decision_id, decision.decision_id);
    const events = getEvents(db, ARTIFACT_ID, "arbitration-approved", 1);
    assert.equal(events.length, 1);
    assert.match(events[0].summary, /approved/i);
  } finally {
    db.close();
  }
});

test("rejection sets needs-rework and records decision", () => {
  const db = createDb();
  try {
    markMigrated(db);
    const evidence = addAcceptanceEvidence(db, {
      artifactId: ARTIFACT_ID,
      producedBy: "critic-agent",
      evidenceType: "test-command",
      command: "npm test",
      exitCode: 1,
      pass: 0,
      summary: "tests failed",
    });

    const decision = rejectArtifactWithEvidence(db, {
      artifactId: ARTIFACT_ID,
      arbiter: "arbiter-agent",
      reason: "tests failed",
      evidenceIds: [evidence.evidence_id],
    });

    assert.equal(decision.decision, "rejected");
    assert.deepEqual(JSON.parse(decision.evidence_ids), [evidence.evidence_id]);
    assert.equal(getArtifactById(db, ARTIFACT_ID).status, "needs-rework");
    const events = getEvents(db, ARTIFACT_ID, "arbitration-rejected", 1);
    assert.equal(events.length, 1);
    assert.match(events[0].summary, /rejected/i);
  } finally {
    db.close();
  }
});
