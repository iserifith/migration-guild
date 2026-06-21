import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_GUILD_CONFIG, parseSimpleYaml, resolveGuildConfig, scaffoldGuildConfig, setDottedPath, stringifySimpleYaml } from "../guildctl/config";
import { createModelProvider, ProviderConfigError } from "../guildctl/provider";

function tempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guild-config-"));
  fs.mkdirSync(path.join(dir, ".git"));
  return dir;
}

test("Guild config scaffolds and resolves provider-neutral defaults", () => {
  const root = tempRepo();
  const configPath = scaffoldGuildConfig(root);
  assert.equal(fs.existsSync(configPath), true);
  const cfg = resolveGuildConfig({ cwd: root });
  assert.equal(cfg.version, 1);
  assert.equal(cfg.model.provider, "openai-compatible");
  assert.equal(cfg.migration.require_evidence_before_intent, true);
  assert.equal(cfg.approval.mode, "manual");
});

test("Guild profiles override model provider settings", () => {
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
  assert.equal((parsed.model as any).provider, "openai-compatible");
  assert.equal((parsed.migration as any).max_autonomous_steps, 3);
});

test("dotted config setter creates nested keys", () => {
  const cfg: Record<string, unknown> = {};
  setDottedPath(cfg, "model.provider", "openrouter");
  assert.deepEqual(cfg, { model: { provider: "openrouter" } });
});

test("provider reports missing configured API key without leaking secrets", async () => {
  const root = tempRepo();
  scaffoldGuildConfig(root);
  const cfg = resolveGuildConfig({ cwd: root });
  delete process.env.OPENROUTER_API_KEY;
  const provider = createModelProvider(cfg);
  await assert.rejects(
    () => provider.complete({ messages: [{ role: "user", content: "hello" }] }),
    ProviderConfigError,
  );
});
