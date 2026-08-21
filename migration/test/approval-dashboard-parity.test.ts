/**
 * T024 (spec 013, US4) — dashboard↔CLI read parity.
 *
 * FR-004/FR-013: the Mission Control dashboard must read the SAME data the
 * `guildctl approve --list` CLI surfaces. The CLI delegates to
 * registry/commands/approval.ts's `listPendingApprovals(db)`; the dashboard's
 * HTTP layer serves `queryPendingApprovalsForUI(db)` from
 * registry/commands/queries.ts. This suite locks the contract that the query
 * helper returns exactly the set `listPendingApprovals` returns — same
 * artifactIds, same fields — so the two surfaces can never drift.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { listPendingApprovals, recordApprovalDecision } from "../registry/commands/approval";
import { queryPendingApprovalsForUI } from "../registry/commands/queries";
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

test("US4: queryPendingApprovalsForUI returns exactly the set listPendingApprovals returns", () => {
  const gate = createApprovalGateDb("run-approval-parity");
  try {
    const heldIds = [
      "legacy-source:com.acme.alpha:AlphaHeld",
      "legacy-source:com.acme.beta:BetaHeld",
      "legacy-source:com.acme.gamma:GammaHeld",
    ];
    heldIds.forEach((artifactId, index) =>
      seedHeldArtifact(gate, artifactId, `Verdict summary ${index}: automated review passed.`),
    );

    const cliRows = listPendingApprovals(gate.db);
    const dashboardRows = queryPendingApprovalsForUI(gate.db);

    // Same rows, same order, same field values — deep equality, not just ids.
    assert.deepEqual(dashboardRows, cliRows);
    assert.deepEqual(
      dashboardRows.map((row) => row.artifactId).sort(),
      [...heldIds].sort(),
    );

    // Every field of the dashboard row mirrors the CLI row exactly.
    for (const row of dashboardRows) {
      const cliRow = cliRows.find((candidate) => candidate.artifactId === row.artifactId);
      assert(cliRow, `dashboard row ${row.artifactId} missing from CLI listing`);
      assert.deepEqual(row.riskReasonCodes, cliRow.riskReasonCodes);
      assert.equal(row.arbitrationVerdictSummary, cliRow.arbitrationVerdictSummary);
      assert.equal(row.enteredPendingApprovalAt, cliRow.enteredPendingApprovalAt);
    }
  } finally {
    gate.db.close();
  }
});

test("US4: dashboard read stays empty exactly when the CLI read is empty", () => {
  const gate = createApprovalGateDb("run-approval-parity-empty");
  try {
    assert.deepEqual(queryPendingApprovalsForUI(gate.db), listPendingApprovals(gate.db));
    assert.deepEqual(queryPendingApprovalsForUI(gate.db), []);
  } finally {
    gate.db.close();
  }
});

test("US4: decided artifacts leave both reads together — pending list shrinks identically (FR-013)", () => {
  const gate = createApprovalGateDb("run-approval-parity-decided");
  try {
    const decidedId = "legacy-source:com.acme.delta:DeltaHeld";
    const stillHeldId = "legacy-source:com.acme.epsilon:EpsilonHeld";
    seedHeldArtifact(gate, decidedId, "Delta passed automated review.");
    seedHeldArtifact(gate, stillHeldId, "Epsilon passed automated review.");

    // Decide one artifact through the shared registry function (the same one
    // the CLI and the POST endpoint call); both reads must track the shrink.
    recordApprovalDecision(gate.db, {
      artifactId: decidedId,
      operator: "operator:parity-test",
      decision: "approved",
      runId: gate.runId,
      operatorToken: gate.operatorToken,
    });

    const cliRows = listPendingApprovals(gate.db);
    const dashboardRows = queryPendingApprovalsForUI(gate.db);
    assert.deepEqual(dashboardRows, cliRows);
    assert.deepEqual(
      dashboardRows.map((row) => row.artifactId),
      [stillHeldId],
    );
  } finally {
    gate.db.close();
  }
});
