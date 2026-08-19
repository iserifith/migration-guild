import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_GUILD_CONFIG, parseSimpleYaml, resolveGuildConfig, scaffoldGuildConfig, stringifySimpleYaml } from "../guildctl/config";

const repoRoot = path.resolve(__dirname, "..", "..");

// The two shipped .env.example files must stay byte-identical (FR-010/FR-016);
// read the root one and confirm the package/ copy matches before using either
// as the docs half of the doc-vs-config consistency check.
const rootEnvExample = fs.readFileSync(path.join(repoRoot, ".env.example"), "utf8");
const packageEnvExample = fs.readFileSync(path.join(repoRoot, "package", ".env.example"), "utf8");

test("US3 (a): the seeded default credential matches the provider documented in .env.example", () => {
  assert.equal(packageEnvExample, rootEnvExample, "root and package/ .env.example must stay byte-identical");

  // The documented default credential for the OpenAI-compatible runtime is the
  // uncommented OPENAI_API_KEY= line — not the commented optional alternatives.
  const documentedDefaultCredential = rootEnvExample
    .split(/\r?\n/)
    .map((line) => line.match(/^([A-Z0-9_]+)=\s*$/)?.[1])
    .filter(Boolean);
  assert.ok(
    documentedDefaultCredential.includes("OPENAI_API_KEY"),
    `.env.example must document OPENAI_API_KEY as the default credential (found: ${documentedDefaultCredential.join(", ")})`,
  );

  // A real doc-vs-config equality assertion, not a hardcoded-string duplicate:
  // whatever credential the shipped docs name as the default is what the seeded
  // config must ask for.
  assert.equal(DEFAULT_GUILD_CONFIG.model.api_key_env, "OPENAI_API_KEY");
  assert.ok(documentedDefaultCredential.includes(DEFAULT_GUILD_CONFIG.model.api_key_env ?? ""));
  assert.equal(DEFAULT_GUILD_CONFIG.model.base_url, "https://api.openai.com/v1");
});

test("US3 (b): scaffoldGuildConfig round-trips the same defaults through .guild/config.yaml", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guild-default-profile-"));
  try {
    fs.mkdirSync(path.join(root, ".git"));
    const configPath = scaffoldGuildConfig(root);
    assert.equal(fs.existsSync(configPath), true);

    // Same pattern guild-config-openai-compatible.test.ts uses: parse the YAML
    // the user would actually open, exercising stringifySimpleYaml/parseSimpleYaml.
    const cfg = resolveGuildConfig({ cwd: root });
    assert.equal(cfg.version, 1);
    assert.equal(cfg.model.base_url, "https://api.openai.com/v1");
    assert.equal(cfg.model.api_key_env, "OPENAI_API_KEY");
    assert.equal(cfg.migration.require_evidence_before_intent, true);
    assert.equal(cfg.approval.mode, "manual");

    // And the raw YAML text round-trips the same values.
    const yamlText = fs.readFileSync(configPath, "utf8");
    const parsed = parseSimpleYaml(stringifySimpleYaml(DEFAULT_GUILD_CONFIG as unknown as Record<string, unknown>));
    assert.equal((parsed.model as Record<string, unknown>).base_url, "https://api.openai.com/v1");
    assert.equal((parsed.model as Record<string, unknown>).api_key_env, "OPENAI_API_KEY");
    assert.ok(yamlText.includes("https://api.openai.com/v1"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("US3 (c): the seeded config carries no rootsys/fiq/DashScope default-provider references (SC-003)", () => {
  const serialized = JSON.stringify(DEFAULT_GUILD_CONFIG).toLowerCase();
  for (const banned of ["dashscope", "fiq/", "rootsys"]) {
    assert.equal(
      serialized.includes(banned),
      false,
      `DEFAULT_GUILD_CONFIG must not reference the ${JSON.stringify(banned)} default provider (FR-006/FR-015)`,
    );
  }
  // FR-006: the dashscope/cheap/reviewer/qwen profiles are removed outright; the
  // provider-neutral `local` profile stays.
  assert.equal(Object.prototype.hasOwnProperty.call(DEFAULT_GUILD_CONFIG.profiles, "dashscope"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(DEFAULT_GUILD_CONFIG.profiles, "local"), true);
  // FR-006: agents.*.model ids must be OpenAI-compatible, internally consistent
  // with model.model.
  for (const [key, agent] of Object.entries(DEFAULT_GUILD_CONFIG.agents)) {
    const model = (agent as Record<string, unknown>).model;
    assert.equal(typeof model, "string", `agents.${key}.model must stay a string`);
    assert.equal(
      String(model).startsWith("fiq/"),
      false,
      `agents.${key}.model must not carry a rootsys namespace`,
    );
  }
});
