/**
 * T025 (spec 013, US4) — server endpoint tests for the approvals API.
 *
 * Covers the two endpoints the Mission Control approvals panel consumes:
 *   GET  /api/approvals                  → 200 JSON array of pending approvals
 *   POST /api/approvals/<id>/decision    → record the human approve/reject
 *
 * Written tests-first (T025) before serve.ts gains the routes (T027/T028) —
 * the suite MUST fail until the implementation lands.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import type http from "node:http";
import Database from "better-sqlite3";
import { startServer } from "../registry/commands/serve";
import type { ApprovalDecision, PendingApproval } from "../registry/commands/approval";
import {
  createApprovalGateDb,
  seedApprovingArbitrationDecision,
  seedHighRiskArtifact,
  type ApprovalGateDb,
} from "./approval-fixtures";

function seedHeldArtifact(
  gate: ApprovalGateDb,
  artifactId: string,
  verdictReason: string,
): void {
  seedHighRiskArtifact(gate, { artifactId, status: "pending-approval" });
  seedApprovingArbitrationDecision(gate.db, artifactId, { reason: verdictReason });
}

function getStatus(db: Database.Database, artifactId: string): string {
  const row = db.prepare("SELECT status FROM artifacts WHERE id = ?").get(artifactId) as
    | { status: string }
    | undefined;
  return row?.status ?? "";
}

async function withServer(
  db: Database.Database,
  run: (port: number) => Promise<void>,
): Promise<void> {
  const server = startServer(db, 0);
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  try {
    await run(address.port);
  } finally {
    server.close();
  }
}

async function postJson(
  port: number,
  urlPath: string,
  payload: unknown,
): Promise<{ status: number; body: string }> {
  const body = JSON.stringify(payload);
  const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  return { status: response.status, body: await response.text() };
}

test("GET /api/approvals → 200 JSON array of pending approvals", async () => {
  const gate = createApprovalGateDb("run-serve-approvals-get");
  try {
    seedHeldArtifact(gate, "legacy-source:com.acme.get:HeldOne", "HeldOne passed automated review.");
    seedHeldArtifact(gate, "legacy-source:com.acme.get:HeldTwo", "HeldTwo passed automated review.");

    await withServer(gate.db, async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/approvals`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /application\/json/);
      const rows = (await response.json()) as PendingApproval[];
      assert(Array.isArray(rows));
      assert.deepEqual(
        rows.map((row) => row.artifactId).sort(),
        ["legacy-source:com.acme.get:HeldOne", "legacy-source:com.acme.get:HeldTwo"],
      );
      for (const row of rows) {
        assert(Array.isArray(row.riskReasonCodes));
        assert.equal(typeof row.arbitrationVerdictSummary, "string");
        assert.equal(typeof row.enteredPendingApprovalAt, "string");
      }
    });
  } finally {
    gate.db.close();
  }
});

test("GET /api/approvals → 200 empty array when nothing is held", async () => {
  const gate = createApprovalGateDb("run-serve-approvals-empty");
  try {
    await withServer(gate.db, async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/approvals`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), []);
    });
  } finally {
    gate.db.close();
  }
});

test("POST /api/approvals/<id>/decision { decision: approved } → 200, artifact reviewed, ApprovalDecision returned", async () => {
  const gate = createApprovalGateDb("run-serve-approvals-approve");
  const artifactId = "legacy-source:com.acme.post:ApproveMe";
  try {
    seedHeldArtifact(gate, artifactId, "ApproveMe passed automated review.");

    await withServer(gate.db, async (port) => {
      const result = await postJson(port, `/api/approvals/${encodeURIComponent(artifactId)}/decision`, {
        decision: "approved",
      });
      assert.equal(result.status, 200);
      const decision = JSON.parse(result.body) as ApprovalDecision;
      assert.equal(decision.artifactId, artifactId);
      assert.equal(decision.decision, "approved");
      assert.equal(typeof decision.decisionId, "string");
      assert.equal(decision.operator, "mission-control"); // dashboard default operator
      assert.equal(getStatus(gate.db, artifactId), "reviewed");
    });
  } finally {
    gate.db.close();
  }
});

test("POST /api/approvals/<id>/decision { decision: rejected, reason } → 200, artifact needs-rework", async () => {
  const gate = createApprovalGateDb("run-serve-approvals-reject");
  const artifactId = "legacy-source:com.acme.post:RejectMe";
  try {
    seedHeldArtifact(gate, artifactId, "RejectMe passed automated review.");

    await withServer(gate.db, async (port) => {
      const result = await postJson(port, `/api/approvals/${encodeURIComponent(artifactId)}/decision`, {
        decision: "rejected",
        reason: "Missing null-checks on the legacy parser path.",
      });
      assert.equal(result.status, 200);
      const decision = JSON.parse(result.body) as ApprovalDecision;
      assert.equal(decision.decision, "rejected");
      assert.equal(decision.reason, "Missing null-checks on the legacy parser path.");
      assert.equal(getStatus(gate.db, artifactId), "needs-rework");
    });
  } finally {
    gate.db.close();
  }
});

test("POST reject without reason → 4xx + clean error body", async () => {
  const gate = createApprovalGateDb("run-serve-approvals-reject-noreason");
  const artifactId = "legacy-source:com.acme.post:RejectNoReason";
  try {
    seedHeldArtifact(gate, artifactId, "RejectNoReason passed automated review.");

    await withServer(gate.db, async (port) => {
      const result = await postJson(port, `/api/approvals/${encodeURIComponent(artifactId)}/decision`, {
        decision: "rejected",
      });
      assert.equal(result.status, 400);
      assert.match(result.body, /A rejection reason is required\./);
      // Artifact must remain held — the failed decision changed nothing.
      assert.equal(getStatus(gate.db, artifactId), "pending-approval");
    });
  } finally {
    gate.db.close();
  }
});

test("POST on an artifact not in pending-approval → 4xx + 'Artifact is not awaiting approval.'", async () => {
  const gate = createApprovalGateDb("run-serve-approvals-notheld");
  const artifactId = "legacy-source:com.acme.post:NotHeld";
  try {
    // Seed at migrated (not pending-approval) so the decision is refused.
    seedHighRiskArtifact(gate, { artifactId, status: "migrated" });

    await withServer(gate.db, async (port) => {
      const result = await postJson(port, `/api/approvals/${encodeURIComponent(artifactId)}/decision`, {
        decision: "approved",
      });
      assert.equal(result.status, 400);
      assert.match(result.body, /Artifact is not awaiting approval\./);
      assert.equal(getStatus(gate.db, artifactId), "migrated");
    });
  } finally {
    gate.db.close();
  }
});

test("POST with malformed JSON body → 4xx + clean error body (no crash)", async () => {
  const gate = createApprovalGateDb("run-serve-approvals-badjson");
  const artifactId = "legacy-source:com.acme.post:BadJson";
  try {
    seedHeldArtifact(gate, artifactId, "BadJson passed automated review.");

    await withServer(gate.db, async (port) => {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/approvals/${encodeURIComponent(artifactId)}/decision`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{ not json" },
      );
      assert.equal(response.status, 400);
      const text = await response.text();
      assert.match(text, /invalid|malformed|json/i);
      assert.equal(getStatus(gate.db, artifactId), "pending-approval");
    });
  } finally {
    gate.db.close();
  }
});

test("POST with an invalid decision value → 4xx + clean error body", async () => {
  const gate = createApprovalGateDb("run-serve-approvals-baddecision");
  const artifactId = "legacy-source:com.acme.post:BadDecision";
  try {
    seedHeldArtifact(gate, artifactId, "BadDecision passed automated review.");

    await withServer(gate.db, async (port) => {
      const result = await postJson(port, `/api/approvals/${encodeURIComponent(artifactId)}/decision`, {
        decision: "maybe",
      });
      assert.equal(result.status, 400);
      assert.equal(getStatus(gate.db, artifactId), "pending-approval");
    });
  } finally {
    gate.db.close();
  }
});
