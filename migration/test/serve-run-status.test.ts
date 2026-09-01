/**
 * T005 (spec 016, #220) — server endpoint test for GET /api/run-status.
 *
 * Follows the same withServer/fetch pattern as serve-approvals.test.ts
 * (spec 013, US4). The endpoint is a thin dispatcher around
 * queryRunStatusForUI (migration/registry/commands/queries.ts, covered in
 * depth by test/run-status.test.ts) — this suite only proves the HTTP
 * plumbing: status code, content type, and that the JSON shape round-trips.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import Database from "better-sqlite3";
import { startServer } from "../registry/commands/serve";
import { registerArtifact } from "../registry/commands/artifacts";
import { applySchema } from "../registry/db/schema";
import type { RunStatusEntry } from "../registry/types";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
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

test("GET /api/run-status → 200 empty array on a fresh registry", async () => {
  const db = createDb();
  try {
    await withServer(db, async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/run-status`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /application\/json/);
      assert.deepEqual(await response.json(), []);
    });
  } finally {
    db.close();
  }
});

test("GET /api/run-status → 200 with one entry per non-terminal artifact, each with exactly one of the four labels", async () => {
  const db = createDb();
  try {
    registerArtifact(db, {
      id: "legacy-source:com.acme.status:Idle",
      kind: "legacy-source",
      tier: "first-class",
      path: "legacy/Idle.java",
    });
    db.exec(`
      INSERT INTO artifact_claims (
        claim_id, artifact_id, owner_id, agent, from_status,
        claim_token, state, attempt_no, claimed_at, heartbeat_at, lease_expires_at
      ) VALUES (
        'claim-run-status-working', 'legacy-source:com.acme.status:Idle', 'test-agent', 'test-agent', 'planned',
        'token', 'active', 1, datetime('now', '-1 minutes'), datetime('now', '-1 minutes'), datetime('now', '+29 minutes')
      );
    `);

    await withServer(db, async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/run-status`);
      assert.equal(response.status, 200);
      const rows = (await response.json()) as RunStatusEntry[];
      assert.equal(rows.length, 1);
      assert.equal(rows[0].artifact_id, "legacy-source:com.acme.status:Idle");
      assert.equal(rows[0].label, "working");
      assert.equal(typeof rows[0].heartbeat_age_ms, "number");
    });
  } finally {
    db.close();
  }
});
