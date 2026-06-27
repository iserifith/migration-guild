import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_GUILD_CONFIG } from "../guildctl/config";
import { checkHarness, resolveHarness } from "../guildctl/harness";

test("codex is the default bundled harness and AGENT_CMD overrides it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-selection-"));
  fs.mkdirSync(path.join(root, "package", "harness"), { recursive: true });
  fs.writeFileSync(path.join(root, "package", "harness", "codex.mjs"), "");
  const selected = resolveHarness(DEFAULT_GUILD_CONFIG, root, {});
  assert.equal(selected.name, "codex");
  assert.equal(selected.command, path.join(root, "package", "harness", "codex.mjs"));
  assert.equal(resolveHarness(DEFAULT_GUILD_CONFIG, root, { AGENT_CMD: "/tmp/custom-agent" }).command, "/tmp/custom-agent");
});

test("doctor harness check flags a missing selected command", () => {
  const resolution = { name: "custom", command: path.join(os.tmpdir(), "missing-harness-command"), targetCommand: "", source: "environment" as const };
  const result = checkHarness(resolution);
  assert.equal(result.ok, false);
  assert.match(result.message, /active harness: custom.*missing or unreachable/);
});
