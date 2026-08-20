import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { runAuto } from "../guildctl/supervisor/loop";
import { registerArtifact, setArtifactStatus, setArtifactWave } from "../registry/commands/artifacts";
import { appendEvent } from "../registry/commands/events";
import { applySchema } from "../registry/db/schema";
import {
  FailureBudget,
  classifyFailure,
  normalizeFailureSignature,
} from "../guildctl/supervisor/failures";

test("classifyFailure deterministically covers bounded supervisor categories", () => {
  assert.equal(classifyFailure({ phase: "verify", exitCode: 1, stderr: "BUILD FAILED" }).kind, "build-failure");
  assert.equal(classifyFailure({ phase: "verify", exitCode: 1, stderr: "1 test failed" }).kind, "test-failure");
  assert.equal(classifyFailure({ phase: "migrate", exitCode: 124, stderr: "killed: INACTIVITY" }).kind, "agent-timeout");
  assert.equal(classifyFailure({ phase: "review", stderr: "independent review rejected missing type annotations" }).kind, "review-rejection");
  assert.equal(classifyFailure({ phase: "migrate", stderr: "filesystem warden restored 2 unauthorized changes" }).kind, "filesystem-violation");
  assert.equal(classifyFailure({ phase: "migrate", stderr: "Claim token mismatch" }).kind, "claim-violation");
  assert.equal(classifyFailure({ phase: "inventory", stderr: "stack mismatch: PHP-only workspace" }).kind, "stack-mismatch");
  assert.equal(classifyFailure({ phase: "bootstrap", stderr: "pack defect missing scaffold template" }).kind, "pack-defect");
  assert.equal(classifyFailure({ phase: "migrate", stderr: "provider error 429 rate limit" }).kind, "provider-error");
  assert.equal(classifyFailure({ phase: "migrate", stderr: "surprising problem" }).kind, "unknown");
});

test("normalizeFailureSignature removes volatile paths ids and numbers", () => {
  assert.equal(
    normalizeFailureSignature("Error in /tmp/guild-abc123/file.java at line 42 run deadbeefcafebabe"),
    "error in <path> at line <n> run <id>",
  );
});

test("FailureBudget bounds attempts and repeated playbooks by signature", () => {
  const budget = new FailureBudget();
  const failure = classifyFailure({ phase: "verify", stderr: "BUILD FAILED in /tmp/a line 12" });
  assert.equal(budget.canAttemptArtifact("artifact-a"), true);
  budget.recordAttempt("artifact-a");
  budget.recordAttempt("artifact-a");
  budget.recordAttempt("artifact-a");
  assert.equal(budget.canAttemptArtifact("artifact-a"), false);

  assert.equal(budget.canRunPlaybook("artifact-a", failure, "repair-build"), true);
  budget.recordPlaybook("artifact-a", failure, "repair-build");
  assert.equal(budget.canRunPlaybook("artifact-a", failure, "repair-build"), true);
  budget.recordPlaybook("artifact-a", failure, "repair-build");
  assert.equal(budget.canRunPlaybook("artifact-a", failure, "repair-build"), false);
});

// US2 (#154) / T010: once a remediation pass has appended
// `remediation-confirmed-no-defect` for an artifact, the supervisor MUST NOT
// dispatch another verify/repair loop for the same unresolved cause. A
// subsequent `auto --resume` surfaces the artifact in a terminal,
// operator-visible state instead of re-invoking verify.
test("US2: remediation-confirmed-no-defect stops the blocked-verify re-loop; verify is not re-invoked", async () => {
  const db = new Database(":memory:");
  applySchema(db);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "guild-us2-remed-confirmed-"));
  try {
    fs.mkdirSync(path.join(workspace, "legacy"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "legacy", "ConfirmedClean.java"), "class ConfirmedClean {}\\n");
    const id = "legacy-source:com.acme:ConfirmedClean";
    registerArtifact(db, { id, kind: "legacy-source", tier: "first-class", path: "legacy/ConfirmedClean.java" });
    setArtifactWave(db, id, 1);
    // The state a blocked artifact is left in once remediation has run and
    // confirmed there is no defect to repair.
    setArtifactStatus(db, id, "blocked");
    appendEvent(db, {
      id,
      type: "remediation-confirmed-no-defect",
      agent: "remediation-agent",
      summary: "Remediation pass found no defect; root cause was environmental.",
    });

    let verifyCalls = 0;
    let workerCalls = 0;
    let reviewCalls = 0;
    const result = await runAuto(db, {
      artifactId: id,
      workspaceRoot: workspace,
      commands: ["node --check modern/ConfirmedClean.js"],
      resume: true,
      verify: async () => {
        verifyCalls += 1;
        return { pass: true, evidence: [] };
      },
      worker: async () => {
        workerCalls += 1;
      },
      review: async () => {
        reviewCalls += 1;
        return { approved: true, reason: "ok", reviewerAgent: "review-agent", reviewerModel: "review-model" };
      },
    });

    assert.equal(result.status, "blocked");
    assert.equal(verifyCalls, 0, "verify must not be re-invoked after remediation confirmed no defect");
    assert.equal(workerCalls, 0, "no migrate/repair worker may be dispatched");
    assert.equal(reviewCalls, 0, "no review may be dispatched");
    const blockedEvents = db
      .prepare("SELECT summary FROM events WHERE artifact_id = ? AND type = 'blocked' ORDER BY rowid")
      .all(id) as Array<{ summary: string }>;
    assert.ok(
      blockedEvents.some((event) => /remediation confirmed no defect/i.test(event.summary)),
      "an operator-visible blocked event must explain why the supervisor stopped",
    );
    const run = db.prepare("SELECT exit_code FROM runs WHERE run_id = ?").get(result.runId) as { exit_code: number };
    assert.equal(run.exit_code, 1);
  } finally {
    db.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
