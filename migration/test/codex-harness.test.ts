import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

test("Codex adapter parses standard arguments and injects the selected persona", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-harness-"));
  fs.mkdirSync(path.join(root, ".github", "agents"), { recursive: true });
  fs.writeFileSync(path.join(root, ".github", "agents", "X.agent.md"), "---\nname: X\n---\nPersona X\n");
  const moduleUrl = pathToFileURL(path.resolve("..", "package", "harness", "codex.mjs")).href;
  const { buildCodexInvocation } = await import(moduleUrl);

  const invocation = buildCodexInvocation(["--agent", "X", "--model", "Y", "--yolo", "-p", "Z"], {
    cwd: root,
    env: { AGENT_PROVIDER_BASE_URL: "https://example.test/v1", AGENT_PROVIDER_API_KEY_ENV: "TEST_KEY" },
  });

  assert.equal(invocation.command, "codex");
  assert.equal(invocation.parsed.yolo, true);
  assert.equal(invocation.fullPrompt, "Persona X\n\n---\n\nZ");
  assert.deepEqual(invocation.args.slice(0, 6), ["--sandbox", "workspace-write", "--ask-for-approval", "never", "exec", "--skip-git-repo-check"]);
  assert.ok(invocation.args.includes('model="Y"'));
  assert.ok(invocation.args.includes('model_providers.migration_guild.base_url="https://example.test/v1"'));
  assert.ok(invocation.args.includes('model_providers.migration_guild.env_key="TEST_KEY"'));
  assert.equal(invocation.args.at(-1), "Persona X\n\n---\n\nZ");
});
