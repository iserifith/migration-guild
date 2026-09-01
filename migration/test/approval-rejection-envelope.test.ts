import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { recordApprovalDecision } from "../registry/commands/approval";
import { getRejectionEnvelope } from "../registry/commands/context";
import {
  HIGH_RISK_ARTIFACT_ID,
  createApprovalGateDb,
  seedHighRiskArtifact,
} from "./approval-fixtures";
import { makeTempDir } from "./truthful-run-state-fixtures";

/**
 * Integration coverage for recordApprovalDecision's rejection-envelope side
 * effect (#216, contracts/registry-commands.md). writeRejectionEnvelope
 * resolves its write path relative to cwd (mirroring writeContext), and
 * getRejectionEnvelope resolves reads via GUILD_WORKSPACE, so every test runs
 * inside a throwaway workspace.
 */

const OPERATOR = "operator:reviewer";

function getStatus(db: Database.Database, artifactId: string): string {
  const row = db.prepare("SELECT status FROM artifacts WHERE id = ?").get(artifactId) as { status: string } | undefined;
  return row?.status ?? "";
}

function getApprovalDecisions(db: Database.Database, artifactId: string): Array<Record<string, unknown>> {
  return db.prepare(
    "SELECT * FROM approval_decisions WHERE artifact_id = ? ORDER BY rowid",
  ).all(artifactId) as Array<Record<string, unknown>>;
}

function withWorkspace<T>(fn: (workspaceRoot: string) => T): T {
  const workspaceRoot = makeTempDir("guild-approval-rejection-envelope-");
  const prevCwd = process.cwd();
  const prevEnv = process.env.GUILD_WORKSPACE;
  process.chdir(workspaceRoot);
  process.env.GUILD_WORKSPACE = workspaceRoot;
  try {
    return fn(workspaceRoot);
  } finally {
    process.chdir(prevCwd);
    if (prevEnv === undefined) {
      delete process.env.GUILD_WORKSPACE;
    } else {
      process.env.GUILD_WORKSPACE = prevEnv;
    }
  }
}

test("recordApprovalDecision: rejecting with a reason populates the rejection envelope (FR-001)", () => {
  withWorkspace(() => {
    const gate = createApprovalGateDb();
    try {
      seedHighRiskArtifact(gate, { status: "pending-approval" });
      const reason = "God-method still present in migrated output; split before promoting.";

      recordApprovalDecision(gate.db, {
        artifactId: HIGH_RISK_ARTIFACT_ID,
        operator: OPERATOR,
        decision: "rejected",
        reason,
        runId: gate.runId,
        operatorToken: gate.operatorToken,
      });

      const envelope = getRejectionEnvelope(gate.db, HIGH_RISK_ARTIFACT_ID);
      assert.ok(envelope);
      assert.equal(envelope!.reason, reason);
    } finally {
      gate.db.close();
    }
  });
});

test("recordApprovalDecision: approving never writes or alters a rejection-envelope entry (FR-001 scope boundary)", () => {
  withWorkspace(() => {
    const gate = createApprovalGateDb();
    try {
      seedHighRiskArtifact(gate, { status: "pending-approval" });

      recordApprovalDecision(gate.db, {
        artifactId: HIGH_RISK_ARTIFACT_ID,
        operator: OPERATOR,
        decision: "approved",
        runId: gate.runId,
        operatorToken: gate.operatorToken,
      });

      assert.equal(getRejectionEnvelope(gate.db, HIGH_RISK_ARTIFACT_ID), null);
    } finally {
      gate.db.close();
    }
  });
});

test("recordApprovalDecision: the envelope write is fail-open — a write failure still completes the rejection (FR-008)", () => {
  withWorkspace((workspaceRoot) => {
    const gate = createApprovalGateDb();
    try {
      seedHighRiskArtifact(gate, { status: "pending-approval" });

      // Force writeRejectionEnvelope's fs.mkdirSync("migration/artifacts/.../context")
      // to fail with a real filesystem error: "migration" already exists as a
      // plain file, not a directory, so mkdirSync(..., { recursive: true })
      // throws ENOTDIR.
      fs.writeFileSync(path.join(workspaceRoot, "migration"), "not a directory", "utf-8");

      const reason = "Reject despite the envelope write being unable to land.";
      const decision = recordApprovalDecision(gate.db, {
        artifactId: HIGH_RISK_ARTIFACT_ID,
        operator: OPERATOR,
        decision: "rejected",
        reason,
        runId: gate.runId,
        operatorToken: gate.operatorToken,
      });

      // The safety-critical, fail-closed part still completed.
      assert.equal(decision.decision, "rejected");
      const rows = getApprovalDecisions(gate.db, HIGH_RISK_ARTIFACT_ID);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].reason, reason);
      assert.equal(getStatus(gate.db, HIGH_RISK_ARTIFACT_ID), "needs-rework");

      // The best-effort relay simply didn't land — no error was raised out of
      // recordApprovalDecision, and no envelope is readable.
      assert.equal(getRejectionEnvelope(gate.db, HIGH_RISK_ARTIFACT_ID), null);
    } finally {
      gate.db.close();
    }
  });
});
