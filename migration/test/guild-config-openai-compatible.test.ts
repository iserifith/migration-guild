import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_GUILD_CONFIG, parseSimpleYaml, resolveGuildConfig, scaffoldGuildConfig, setDottedPath, stringifySimpleYaml } from "../guildctl/config";
import { OpenAICompatibleClient, OpenAIConfigError } from "../guildctl/openai-compatible";

function tempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guild-config-"));
  fs.mkdirSync(path.join(dir, ".git"));
  return dir;
}

test("Guild config scaffolds and resolves OpenAI-compatible defaults", () => {
  const root = tempRepo();
  const configPath = scaffoldGuildConfig(root);
  assert.equal(fs.existsSync(configPath), true);
  const cfg = resolveGuildConfig({ cwd: root });
  assert.equal(cfg.version, 1);
  assert.equal(cfg.model.base_url, "https://rootsys.cloud/v1");
  assert.equal(cfg.migration.require_evidence_before_intent, true);
  assert.equal(cfg.approval.mode, "manual");
});

test("Guild profiles override OpenAI-compatible runtime settings", () => {
  const root = tempRepo();
  scaffoldGuildConfig(root);
  const cfg = resolveGuildConfig({ cwd: root, profile: "local" });
  assert.equal(cfg.selectedProfile, "local");
  assert.equal(cfg.model.base_url, "http://localhost:1234/v1");
  assert.equal(cfg.model.model, "qwen2.5-coder");
});

test("simple YAML parser and writer round-trip nested Guild config", () => {
  const yaml = stringifySimpleYaml(DEFAULT_GUILD_CONFIG as unknown as Record<string, unknown>);
  const parsed = parseSimpleYaml(yaml);
  assert.equal((parsed.model as any).base_url, "https://rootsys.cloud/v1");
  assert.equal((parsed.migration as any).max_autonomous_steps, 3);
});

test("dotted config setter creates nested keys", () => {
  const cfg: Record<string, unknown> = {};
  setDottedPath(cfg, "model.base_url", "https://api.openai.com/v1");
  assert.deepEqual(cfg, { model: { base_url: "https://api.openai.com/v1" } });
});

test("OpenAI-compatible client reports missing configured API key without leaking secrets", async () => {
  const root = tempRepo();
  scaffoldGuildConfig(root);
  const cfg = resolveGuildConfig({ cwd: root });
  delete process.env.ROOTSYS_API_KEY;
  const client = new OpenAICompatibleClient(cfg);
  await assert.rejects(
    () => client.complete({ messages: [{ role: "user", content: "hello" }] }),
    OpenAIConfigError,
  );
});
