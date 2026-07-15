import assert from "node:assert/strict";
import test from "node:test";
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
