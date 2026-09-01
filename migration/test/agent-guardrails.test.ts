import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

function findRepoRoot(startDir: string): string {
  let dir = startDir;
  while (true) {
    if (fs.existsSync(path.join(dir, "package", "agents", "migration-orchestrator.agent.md"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error("Could not locate repository root from test path");
    }
    dir = parent;
  }
}

function readRepoFile(...segments: string[]): string {
  const startDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = findRepoRoot(startDir);
  return fs.readFileSync(path.join(repoRoot, ...segments), "utf8");
}

test("migration orchestrator keeps remediation registry-first and legacy read-only", () => {
  const orchestrator = readRepoFile("package", "agents", "migration-orchestrator.agent.md");

  assert.match(orchestrator, /Never overwrite a file in `legacy\/`/);
  assert.match(orchestrator, /do not repair `needs-rework`, `blocked`, failed, or stalled items by editing source files during triage/i);
  assert.match(orchestrator, /If `legacy\/` was modified by any prior run, stop and tell the operator to restore it from version control or a fresh copy before continuing\./);
});

test("remediation agent stays registry-only", () => {
  const remediation = readRepoFile("package", "agents", "remediation-agent.agent.md");
  const instructions = readRepoFile("package", "agent-instructions.md");

  assert.match(remediation, /Remediation is \*\*registry-only\*\*/);
  assert.match(remediation, /Never edit files in `modern\/` as part of remediation/);
  assert.match(instructions, /Remediation is registry-only/);
  assert.match(instructions, /If `legacy\/` was edited accidentally, restore it from version control or a fresh copy before running more migration steps/);
});

// Issue #64: a missing JDK/Gradle toolchain must never trigger filesystem-search
// thrash. Agents probe once, record unverified, and move on.
test("build-tool agents forbid hunting for a missing toolchain", () => {
  const noHunt = /do not search the filesystem for one|Never run `find \/`/;

  for (const file of ["code-writer-agent.agent.md", "test-writer-agent.agent.md", "review-agent.agent.md"]) {
    const text = readRepoFile("package", "agents", file);
    assert.match(text, noHunt, `${file} must forbid filesystem searches for a missing toolchain`);
    assert.match(text, /agent-reported-unverifiable|note it in your verdict/, `${file} must state the fallback when no toolchain is present`);
  }

  const instructions = readRepoFile("package", "agent-instructions.md");
  assert.match(instructions, /Do not hunt for a missing toolchain/);
  assert.match(instructions, /agent-reported-unverifiable/);
});

// #217 (building on #216): remediation-agent must read BOTH the human
// rejection-envelope and the adversary-agent's adversary-envelope before
// requeueing a needs-rework artifact, fold both in distinguishably when both
// are present, and leave the reason/summary text unchanged when neither
// resolves — mirrors T020-T025's contract.
test("remediation agent reads both rejection-envelope and adversary-envelope, distinguishably, before requeueing", () => {
  const remediation = readRepoFile("package", "agents", "remediation-agent.agent.md");

  assert.match(remediation, /get-context --id "<id>" --agent rejection-envelope/);
  assert.match(remediation, /get-context --id "<id>" --agent adversary-envelope/);
  // The two origins must be distinguishably labeled when folded together.
  assert.match(remediation, /Human rejection:/);
  assert.match(remediation, /Adversary finding:/);
  // Neither envelope resolving leaves the reason/summary text unchanged.
  assert.match(remediation, /use the reason\/summary text unchanged/i);
});

test("adversary-agent procedure exists, is scoped to a single probe, and never routes artifacts itself", () => {
  const adversary = readRepoFile("package", "agents", "adversary-agent.agent.md");

  assert.match(adversary, /clean \| violation \| inconclusive/);
  assert.match(adversary, /does \*\*not\*\* call `set-artifact-status`, `arbitrate`, or any other status-mutating CLI command/);
  assert.match(adversary, /Never modify `legacy\/` or `modern\/`/);
});
