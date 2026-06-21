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
