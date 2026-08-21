import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { appendEvent } from "../registry/commands/events";
import { RegistryError } from "../registry/types";
import {
  resolveGateScope,
  recordApprovalDecision,
} from "../registry/commands/approval";
import { applyRiskAssessment } from "../guildctl/risk";
import {
  APPROVAL_GATE_CUTOFF,
  HIGH_RISK_ARTIFACT_ID,
  LOW_RISK_ARTIFACT_ID,
  createApprovalGateDb,
  getRiskRow,
  seedApprovingArbitrationDecision,
  seedHighRiskArtifact,
  seedLowRiskArtifact,
  seedRun,
} from "./approval-fixtures";

// Regression suite for the US1 approval gate (spec 013, FR-001/002/003/006/007/008/011
// and contracts/registry-commands.md). Written tests-first against
// registry/commands/approval.ts, which does not exist yet — the suite MUST fail
// with a module-not-found error until the implementation lands.

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

function getEvents(db: Database.Database, artifactId: string, type?: string): Array<{ type: string; data: string | null }> {
  if (type) {
    return db.prepare(
      "SELECT type, event_data AS data FROM events WHERE artifact_id = ? AND type = ? ORDER BY rowid",
    ).all(artifactId, type) as Array<{ type: string; data: string | null }>;
  }
  return db.prepare(
    "SELECT type, event_data AS data FROM events WHERE artifact_id = ? ORDER BY rowid",
  ).all(artifactId) as Array<{ type: string; data: string | null }>;
}

// Applies the evidence.ts approval-path post-conditions documented in
// contracts/registry-commands.md §resolveGateScope: at the moment an approving
// arbiter verdict would otherwise transition migrated → reviewed, the approval
// path MUST consult resolveGateScope; in-scope artifacts go to pending-approval
// (emitting approval-gated) instead of reviewed, out-of-scope artifacts go to
// reviewed as before.
function applyApprovalPathOutcome(db: Database.Database, artifactId: string): void {
  const scope = resolveGateScope(db, artifactId);
  if (scope.inScope) {
    db.prepare("UPDATE artifacts SET status = 'pending-approval' WHERE id = ?").run(artifactId);
    appendEvent(db, {
      id: artifactId,
      type: "approval-gated",
      agent: "arbiter:test",
      summary: `Held for human approval: ${scope.reason}`,
      data: JSON.stringify({ role: "arbiter", target_status: "pending-approval", reason: scope.reason }),
    });
  } else {
    db.prepare("UPDATE artifacts SET status = 'reviewed' WHERE id = ?").run(artifactId);
  }
}

test("resolveGateScope: in scope for high-risk artifact, out of scope for low-risk (FR-001/002)", () => {
  const gate = createApprovalGateDb();
  try {
    seedHighRiskArtifact(gate);
    seedLowRiskArtifact(gate);

    const high = resolveGateScope(gate.db, HIGH_RISK_ARTIFACT_ID);
    assert.equal(high.inScope, true);
    assert.match(high.reason, new RegExp(`${APPROVAL_GATE_CUTOFF}`));

    const low = resolveGateScope(gate.db, LOW_RISK_ARTIFACT_ID);
    assert.equal(low.inScope, false);
    assert.match(low.reason, /below/i);
  } finally {
    gate.db.close();
  }
});

test("resolveGateScope: out of scope when the artifact has no risk row at all", () => {
  const gate = createApprovalGateDb();
  try {
    seedHighRiskArtifact(gate);
    gate.db.prepare("DELETE FROM artifact_risk_assessments WHERE artifact_id = ?").run(HIGH_RISK_ARTIFACT_ID);
    assert.equal(getRiskRow(gate.db, HIGH_RISK_ARTIFACT_ID), undefined);

    const scope = resolveGateScope(gate.db, HIGH_RISK_ARTIFACT_ID);
    assert.equal(scope.inScope, false);
  } finally {
    gate.db.close();
  }
});

test("resolveGateScope: pure read — repeated calls return the same result with no side effects", () => {
  const gate = createApprovalGateDb();
  try {
    seedHighRiskArtifact(gate);

    const first = resolveGateScope(gate.db, HIGH_RISK_ARTIFACT_ID);
    const second = resolveGateScope(gate.db, HIGH_RISK_ARTIFACT_ID);
    assert.deepEqual(first, second);
    assert.equal(first.inScope, true);
    assert.equal(getStatus(gate.db, HIGH_RISK_ARTIFACT_ID), "migrated");
    assert.notEqual(getRiskRow(gate.db, HIGH_RISK_ARTIFACT_ID), undefined);
  } finally {
    gate.db.close();
  }
});

test("recordApprovalDecision: approved inserts one approval_decisions row, transitions to reviewed, writes approval-approved (FR-003/007)", () => {
  const gate = createApprovalGateDb();
  try {
    seedHighRiskArtifact(gate, { status: "pending-approval" });

    const decision = recordApprovalDecision(gate.db, {
      artifactId: HIGH_RISK_ARTIFACT_ID,
      operator: OPERATOR,
      decision: "approved",
      runId: gate.runId,
      operatorToken: gate.operatorToken,
    });
    assert.equal(decision.artifactId, HIGH_RISK_ARTIFACT_ID);
    assert.equal(decision.operator, OPERATOR);
    assert.equal(decision.decision, "approved");

    const rows = getApprovalDecisions(gate.db, HIGH_RISK_ARTIFACT_ID);
    assert.equal(rows.length, 1);
    const row = rows[0] as {
      artifact_id: string;
      run_id: string | null;
      operator: string;
      decision: string;
      reason: string | null;
      operator_token_hash: string | null;
      decided_at: string;
    };
    assert.equal(row.artifact_id, HIGH_RISK_ARTIFACT_ID);
    assert.equal(row.run_id, gate.runId);
    assert.equal(row.operator, OPERATOR);
    assert.equal(row.decision, "approved");
    assert.ok(row.decided_at);
    if (row.operator_token_hash != null) {
      assert.notEqual(row.operator_token_hash, gate.operatorToken);
    }

    assert.equal(getStatus(gate.db, HIGH_RISK_ARTIFACT_ID), "reviewed");

    const events = getEvents(gate.db, HIGH_RISK_ARTIFACT_ID, "approval-approved");
    assert.equal(events.length, 1);
    const data = events[0].data ? JSON.parse(events[0].data) as Record<string, unknown> : {};
    assert.equal(data.target_status, "reviewed");
  } finally {
    gate.db.close();
  }
});

test("recordApprovalDecision: rejected with reason transitions to needs-rework, writes approval-rejected, row carries reason (FR-003/007)", () => {
  const gate = createApprovalGateDb();
  try {
    seedHighRiskArtifact(gate, { status: "pending-approval" });

    const reason = "God-method still present in migrated output; split before promoting.";
    const decision = recordApprovalDecision(gate.db, {
      artifactId: HIGH_RISK_ARTIFACT_ID,
      operator: OPERATOR,
      decision: "rejected",
      reason,
      runId: gate.runId,
      operatorToken: gate.operatorToken,
    });
    assert.equal(decision.decision, "rejected");

    const rows = getApprovalDecisions(gate.db, HIGH_RISK_ARTIFACT_ID);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].decision, "rejected");
    assert.equal(rows[0].reason, reason);

    assert.equal(getStatus(gate.db, HIGH_RISK_ARTIFACT_ID), "needs-rework");

    const events = getEvents(gate.db, HIGH_RISK_ARTIFACT_ID, "approval-rejected");
    assert.equal(events.length, 1);
    const data = events[0].data ? JSON.parse(events[0].data) as Record<string, unknown> : {};
    assert.equal(data.target_status, "needs-rework");
  } finally {
    gate.db.close();
  }
});

test("recordApprovalDecision: throws RegistryError when the artifact is not in pending-approval", () => {
  const gate = createApprovalGateDb();
  try {
    seedHighRiskArtifact(gate, { status: "migrated" });

    assert.throws(
      () => recordApprovalDecision(gate.db, {
        artifactId: HIGH_RISK_ARTIFACT_ID,
        operator: OPERATOR,
        decision: "approved",
        runId: gate.runId,
        operatorToken: gate.operatorToken,
      }),
      (error: unknown) => {
        assert.ok(error instanceof RegistryError);
        assert.match(error.message, /not awaiting approval/i);
        return true;
      },
    );
    assert.equal(getStatus(gate.db, HIGH_RISK_ARTIFACT_ID), "migrated");
    assert.equal(getApprovalDecisions(gate.db, HIGH_RISK_ARTIFACT_ID).length, 0);
  } finally {
    gate.db.close();
  }
});

test("recordApprovalDecision: throws RegistryError when operator is the approving arbiter (FR-008)", () => {
  const gate = createApprovalGateDb();
  try {
    seedHighRiskArtifact(gate, { status: "pending-approval" });
    const arbiter = "arbiter:auto";
    seedApprovingArbitrationDecision(gate.db, HIGH_RISK_ARTIFACT_ID, { arbiter });

    assert.throws(
      () => recordApprovalDecision(gate.db, {
        artifactId: HIGH_RISK_ARTIFACT_ID,
        operator: arbiter,
        decision: "approved",
        runId: gate.runId,
        operatorToken: gate.operatorToken,
      }),
      (error: unknown) => {
        assert.ok(error instanceof RegistryError);
        assert.match(error.message, /arbiter/i);
        return true;
      },
    );
    assert.equal(getStatus(gate.db, HIGH_RISK_ARTIFACT_ID), "pending-approval");
    assert.equal(getApprovalDecisions(gate.db, HIGH_RISK_ARTIFACT_ID).length, 0);

    // A different operator identity is not blocked by the independence floor.
    const decision = recordApprovalDecision(gate.db, {
      artifactId: HIGH_RISK_ARTIFACT_ID,
      operator: OPERATOR,
      decision: "approved",
      runId: gate.runId,
      operatorToken: gate.operatorToken,
    });
    assert.equal(decision.decision, "approved");
    assert.equal(getStatus(gate.db, HIGH_RISK_ARTIFACT_ID), "reviewed");
  } finally {
    gate.db.close();
  }
});

test("recordApprovalDecision: throws RegistryError when rejected without a reason", () => {
  const gate = createApprovalGateDb();
  try {
    seedHighRiskArtifact(gate, { status: "pending-approval" });

    assert.throws(
      () => recordApprovalDecision(gate.db, {
        artifactId: HIGH_RISK_ARTIFACT_ID,
        operator: OPERATOR,
        decision: "rejected",
        runId: gate.runId,
        operatorToken: gate.operatorToken,
      }),
      (error: unknown) => {
        assert.ok(error instanceof RegistryError);
        assert.match(error.message, /reason/i);
        return true;
      },
    );
    assert.equal(getStatus(gate.db, HIGH_RISK_ARTIFACT_ID), "pending-approval");
    assert.equal(getApprovalDecisions(gate.db, HIGH_RISK_ARTIFACT_ID).length, 0);
  } finally {
    gate.db.close();
  }
});

test("recordApprovalDecision: throws RegistryError on stale evidence — repair event after latest runtime evidence (FR-006)", () => {
  const gate = createApprovalGateDb();
  try {
    seedHighRiskArtifact(gate, { status: "pending-approval" });

    // Bind the artifact's runtime evidence to an earlier run, then log a repair
    // event afterwards: checkEvidenceFreshness must report it stale, and the
    // human decision must be refused with the same RegistryError shape operators
    // already see from evidence.ts.
    seedRun(gate.db, "run-earlier");
    gate.db.prepare("UPDATE acceptance_evidence SET run_id = ? WHERE artifact_id = ?").run("run-earlier", HIGH_RISK_ARTIFACT_ID);
    // Backdate the runtime evidence so the repair event (logged now, second-resolution
    // timestamps) is strictly newer — mirrors test/drift-gate.test.ts stale-evidence setup.
    gate.db.prepare("UPDATE acceptance_evidence SET created_at = datetime('now', '-2 seconds') WHERE artifact_id = ?").run(HIGH_RISK_ARTIFACT_ID);
    appendEvent(gate.db, {
      id: HIGH_RISK_ARTIFACT_ID,
      type: "auto-rework",
      agent: "guildctl-auto",
      summary: "Repair scheduled",
      data: JSON.stringify({ failure: { kind: "test-failure" } }),
    });

    assert.throws(
      () => recordApprovalDecision(gate.db, {
        artifactId: HIGH_RISK_ARTIFACT_ID,
        operator: OPERATOR,
        decision: "approved",
        runId: gate.runId,
        operatorToken: gate.operatorToken,
      }),
      (error: unknown) => {
        assert.ok(error instanceof RegistryError);
        assert.match(error.message, /stale evidence/i);
        return true;
      },
    );
    assert.equal(getStatus(gate.db, HIGH_RISK_ARTIFACT_ID), "pending-approval");
    assert.equal(getApprovalDecisions(gate.db, HIGH_RISK_ARTIFACT_ID).length, 0);
  } finally {
    gate.db.close();
  }
});

test("approval-gate path: approving verdict on a high-risk artifact yields pending-approval, not reviewed (FR-001/002/011)", () => {
  const gate = createApprovalGateDb();
  try {
    seedHighRiskArtifact(gate, { status: "migrated" });
    seedApprovingArbitrationDecision(gate.db, HIGH_RISK_ARTIFACT_ID, { arbiter: "arbiter:auto" });

    applyApprovalPathOutcome(gate.db, HIGH_RISK_ARTIFACT_ID);

    // The artifact is held for the human decision — NOT transitioned to reviewed.
    assert.equal(getStatus(gate.db, HIGH_RISK_ARTIFACT_ID), "pending-approval");
    const gated = getEvents(gate.db, HIGH_RISK_ARTIFACT_ID, "approval-gated");
    assert.equal(gated.length, 1);

    // The held artifact is releasable exactly once, by a non-arbiter operator.
    recordApprovalDecision(gate.db, {
      artifactId: HIGH_RISK_ARTIFACT_ID,
      operator: OPERATOR,
      decision: "approved",
      runId: gate.runId,
      operatorToken: gate.operatorToken,
    });
    assert.equal(getStatus(gate.db, HIGH_RISK_ARTIFACT_ID), "reviewed");
    assert.equal(getApprovalDecisions(gate.db, HIGH_RISK_ARTIFACT_ID).length, 1);
  } finally {
    gate.db.close();
  }
});

test("approval-gate path: approving verdict on a low-risk artifact still transitions straight to reviewed (FR-011)", () => {
  const gate = createApprovalGateDb();
  try {
    seedLowRiskArtifact(gate, { status: "migrated" });

    applyApprovalPathOutcome(gate.db, LOW_RISK_ARTIFACT_ID);

    assert.equal(getStatus(gate.db, LOW_RISK_ARTIFACT_ID), "reviewed");
    assert.equal(getEvents(gate.db, LOW_RISK_ARTIFACT_ID, "approval-gated").length, 0);
  } finally {
    gate.db.close();
  }
});

test("approval-gate path: gate scope follows the stored risk row — clearing high_risk releases the gate (FR-001/002)", () => {
  const gate = createApprovalGateDb();
  try {
    seedHighRiskArtifact(gate, { status: "migrated" });

    applyRiskAssessment(gate.db, {
      id: HIGH_RISK_ARTIFACT_ID,
      riskScore: 0.4,
      highRisk: false,
      reasonCodes: ["method_length"],
      signals: {},
    });
    assert.equal(Number(getRiskRow(gate.db, HIGH_RISK_ARTIFACT_ID)?.high_risk), 0);

    applyApprovalPathOutcome(gate.db, HIGH_RISK_ARTIFACT_ID);
    assert.equal(getStatus(gate.db, HIGH_RISK_ARTIFACT_ID), "reviewed");
    assert.equal(getEvents(gate.db, HIGH_RISK_ARTIFACT_ID, "approval-gated").length, 0);
  } finally {
    gate.db.close();
  }
});

// Confirmed code-review findings (spec 013 follow-up): recordApprovalDecision
// must validate a supplied run/operator-token pair against a real credential
// (mirrors claim.ts's validateRunOperatorCredential, already used by
// evidence.ts/artifacts.ts), and a human approval that promotes an artifact to
// `reviewed` must commit its outputs (mirrors evidence.ts's
// approveArtifactWithEvidence).

test("recordApprovalDecision: an operator token that does not hash to the run's stored credential is a clean RegistryError", () => {
  const gate = createApprovalGateDb();
  try {
    seedHighRiskArtifact(gate, { status: "pending-approval" });
    seedApprovingArbitrationDecision(gate.db, HIGH_RISK_ARTIFACT_ID, { arbiter: "arbiter:auto" });

    assert.throws(
      () => recordApprovalDecision(gate.db, {
        artifactId: HIGH_RISK_ARTIFACT_ID,
        operator: OPERATOR,
        decision: "approved",
        runId: gate.runId,
        operatorToken: "placeholder-wrong-operator-token",
      }),
      (error: unknown) => {
        assert.ok(error instanceof RegistryError, `expected RegistryError, got ${error}`);
        assert.match(error.message, /credential/i);
        return true;
      },
    );
    // Rejected before any decision row/status change lands.
    assert.equal(getStatus(gate.db, HIGH_RISK_ARTIFACT_ID), "pending-approval");
    assert.equal(getApprovalDecisions(gate.db, HIGH_RISK_ARTIFACT_ID).length, 0);
  } finally {
    gate.db.close();
  }
});

test("recordApprovalDecision: a run id with no matching run_operator_credentials row is a clean RegistryError", () => {
  const gate = createApprovalGateDb();
  try {
    seedHighRiskArtifact(gate, { status: "pending-approval" });
    seedApprovingArbitrationDecision(gate.db, HIGH_RISK_ARTIFACT_ID, { arbiter: "arbiter:auto" });

    assert.throws(
      () => recordApprovalDecision(gate.db, {
        artifactId: HIGH_RISK_ARTIFACT_ID,
        operator: OPERATOR,
        decision: "approved",
        runId: "run-that-does-not-exist",
        operatorToken: gate.operatorToken,
      }),
      (error: unknown) => {
        assert.ok(error instanceof RegistryError, `expected RegistryError, got ${error}`);
        assert.match(error.message, /credential/i);
        return true;
      },
    );
    assert.equal(getStatus(gate.db, HIGH_RISK_ARTIFACT_ID), "pending-approval");
  } finally {
    gate.db.close();
  }
});

test("recordApprovalDecision: an approval with no runId/operatorToken at all is unaffected by the credential check", () => {
  const gate = createApprovalGateDb();
  try {
    seedHighRiskArtifact(gate, { status: "pending-approval" });
    seedApprovingArbitrationDecision(gate.db, HIGH_RISK_ARTIFACT_ID, { arbiter: "arbiter:auto" });

    const decision = recordApprovalDecision(gate.db, {
      artifactId: HIGH_RISK_ARTIFACT_ID,
      operator: OPERATOR,
      decision: "approved",
    });
    assert.equal(decision.decision, "approved");
    assert.equal(getStatus(gate.db, HIGH_RISK_ARTIFACT_ID), "reviewed");
  } finally {
    gate.db.close();
  }
});

test("recordApprovalDecision: a human approval that promotes to reviewed commits the artifact's output like approveArtifactWithEvidence (FR-003)", () => {
  const gate = createApprovalGateDb();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "guild-approval-commit-"));
  try {
    // Git sets GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE while running a hook
    // (e.g. this project's own pre-commit test run) — inherited into a plain
    // spawnSync env, those vars would silently redirect our git commands at
    // the *outer* repo instead of `workspace`. Mirror evidence.ts's own
    // GIT_SCOPE_ENV scrubbing for these test-harness git calls too.
    const gitEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_CEILING_DIRECTORIES", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR"]) {
      delete gitEnv[key];
    }
    const runGitOrThrow = (args: string[]): void => {
      const result = spawnSync("git", args, { cwd: workspace, encoding: "utf8", env: gitEnv });
      assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
    };
    runGitOrThrow(["init"]);
    runGitOrThrow(["config", "user.email", "test@example.com"]);
    runGitOrThrow(["config", "user.name", "Test"]);

    seedHighRiskArtifact(gate, { status: "pending-approval" });
    seedApprovingArbitrationDecision(gate.db, HIGH_RISK_ARTIFACT_ID, { arbiter: "arbiter:auto" });

    // seedArtifact registers HIGH_RISK_ARTIFACT_ID at
    // legacy/src/main/java/HighRiskThing.java, so deriveExpectedOutputPaths
    // resolves its own output to modern/src/main/java/HighRiskThing.java.
    const modernPath = path.join(workspace, "modern", "src", "main", "java", "HighRiskThing.java");
    fs.mkdirSync(path.dirname(modernPath), { recursive: true });
    fs.writeFileSync(modernPath, "public class HighRiskThing {}\n");

    recordApprovalDecision(gate.db, {
      artifactId: HIGH_RISK_ARTIFACT_ID,
      operator: OPERATOR,
      decision: "approved",
      runId: gate.runId,
      operatorToken: gate.operatorToken,
      workspaceRoot: workspace,
    });
    assert.equal(getStatus(gate.db, HIGH_RISK_ARTIFACT_ID), "reviewed");

    const log = spawnSync("git", ["log", "--oneline"], { cwd: workspace, encoding: "utf8", env: gitEnv });
    assert.match(log.stdout, /promote:/, `expected a "promote:" commit, got log:\n${log.stdout}`);
    const show = spawnSync("git", ["show", "--stat", "HEAD"], { cwd: workspace, encoding: "utf8", env: gitEnv });
    assert.match(show.stdout, /HighRiskThing\.java/, `expected the promoted file in the commit, got:\n${show.stdout}`);
  } finally {
    gate.db.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
