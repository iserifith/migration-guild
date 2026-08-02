import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { DEFAULT_GUILD_CONFIG, type GuildConfig } from "../guildctl/config";
import { resolveAgentLaunch, resolveHarness } from "../guildctl/harness";
import { spawnAgent } from "../guildctl/runner";
import { applySchema } from "../registry/db/schema";
import { makeTempDir } from "./truthful-run-state-fixtures";

/**
 * Foundational coverage for T012 (FR-011): one shared launch resolver.
 *
 * The point is not that `resolveAgentLaunch()` returns correct values — it is
 * that the runner reads *this* function, so preflight (US2) and the run-start
 * line (US3) cannot describe a runtime a run does not use.
 */

const CREDENTIAL_VALUE = "sk-live-do-not-leak-0123456789";

function config(overrides: Partial<GuildConfig> = {}): GuildConfig {
  return { ...structuredClone(DEFAULT_GUILD_CONFIG), ...overrides } as GuildConfig;
}

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

test("resolveAgentLaunch reports the harness, provider, and model a run will actually use", () => {
  const root = makeTempDir("guild-runtime-resolution-");
  try {
    const resolved = resolveAgentLaunch({
      config: config(),
      root,
      env: { ROOTSYS_API_KEY: CREDENTIAL_VALUE },
    });

    assert.equal(resolved.harness.name, "opencode");
    assert.equal(resolved.harness.source, "config");
    assert.ok(resolved.harness.command.endsWith(path.join("harness", "opencode.mjs")));
    assert.equal(resolved.providerBaseUrl, "https://rootsys.cloud/v1");
    assert.equal(resolved.model, DEFAULT_GUILD_CONFIG.model.model);
    assert.deepEqual(resolved.divergences, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("credentialEnv carries the variable name only — the value never enters the resolved object", () => {
  const root = makeTempDir("guild-runtime-credential-");
  try {
    const resolved = resolveAgentLaunch({
      config: config(),
      root,
      env: { ROOTSYS_API_KEY: CREDENTIAL_VALUE },
    });

    assert.equal(resolved.credentialEnv, "ROOTSYS_API_KEY");

    // FR-019: the credential value must not be reachable from the object at
    // all, so it cannot leak into a log line or a JSON dump.
    const dumped = JSON.stringify({
      harness: resolved.harness,
      providerBaseUrl: resolved.providerBaseUrl,
      model: resolved.model,
      credentialEnv: resolved.credentialEnv,
      divergences: resolved.divergences,
    });
    assert.equal(dumped.includes(CREDENTIAL_VALUE), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("AGENT_CMD resolves as a custom harness and is reported as an environment-sourced divergence", () => {
  const root = makeTempDir("guild-runtime-agentcmd-");
  try {
    const resolved = resolveAgentLaunch({
      config: config(),
      root,
      env: { AGENT_CMD: "/opt/custom/agent", ROOTSYS_API_KEY: CREDENTIAL_VALUE },
    });

    assert.equal(resolved.harness.name, "custom");
    assert.equal(resolved.harness.command, "/opt/custom/agent");
    assert.equal(resolved.harness.source, "environment");

    const divergence = resolved.divergences.find((d) => d.setting === "harness");
    assert.ok(divergence, "an AGENT_CMD override diverges from the declared harness");
    assert.equal(divergence.declaredValue, "opencode");
    assert.equal(divergence.resolvedValue, "custom");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a model or base URL differing from project configuration is reported as a divergence", () => {
  const root = makeTempDir("guild-runtime-divergence-");
  try {
    const resolved = resolveAgentLaunch({
      config: config(),
      root,
      env: { AGENT_PROVIDER_BASE_URL: "https://ambient.example/v1", ROOTSYS_API_KEY: CREDENTIAL_VALUE },
      model: "fiq/grok-4.5",
    });

    const modelDivergence = resolved.divergences.find((d) => d.setting === "model.model");
    assert.ok(modelDivergence);
    assert.equal(modelDivergence.declaredValue, DEFAULT_GUILD_CONFIG.model.model);
    assert.equal(modelDivergence.resolvedValue, "fiq/grok-4.5");

    const urlDivergence = resolved.divergences.find((d) => d.setting === "model.base_url");
    assert.ok(urlDivergence);
    assert.equal(urlDivergence.declaredValue, "https://rootsys.cloud/v1");
    assert.equal(urlDivergence.resolvedValue, "https://ambient.example/v1");
    assert.equal(resolved.providerBaseUrl, "https://ambient.example/v1");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("agentEnv is the environment the agent process receives, including caller-supplied run variables", () => {
  const root = makeTempDir("guild-runtime-env-");
  try {
    const resolved = resolveAgentLaunch({
      config: config(),
      root,
      env: { PATH: "/usr/bin", ROOTSYS_API_KEY: CREDENTIAL_VALUE },
      extraEnv: { GUILDCTL_RUN_ID: "run-1234" },
    });

    assert.equal(resolved.agentEnv["AGENT_PROVIDER_BASE_URL"], "https://rootsys.cloud/v1");
    assert.equal(resolved.agentEnv["AGENT_PROVIDER_API_KEY_ENV"], "ROOTSYS_API_KEY");
    assert.equal(resolved.agentEnv["GUILDCTL_RUN_ID"], "run-1234");
    // The ambient environment is inherited, credential included — the agent
    // needs it. What must not happen is the *resolved config* carrying it.
    assert.equal(resolved.agentEnv["PATH"], "/usr/bin");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveHarness keeps its existing contract so current callers are unaffected", () => {
  const root = makeTempDir("guild-runtime-legacy-");
  try {
    const legacy = resolveHarness(config(), root, { AGENT_CMD: "/opt/custom/agent" });
    assert.deepEqual(legacy, {
      name: "custom",
      command: "/opt/custom/agent",
      targetCommand: "/opt/custom/agent",
      source: "environment",
    });
    assert.throws(
      () => resolveHarness(config({ harness: "nope" }), root, {}),
      /Unknown harness/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the runner launches through resolveAgentLaunch, so its env matches the resolved one", async () => {
  const db = createDb();
  const workDir = makeTempDir("guild-runtime-runner-");
  const envDump = path.join(workDir, "agent-env.json");
  const stub = path.join(workDir, "fake-agent.cjs");
  const originalAgentCmd = process.env["AGENT_CMD"];
  const originalWorkspace = process.env["GUILD_WORKSPACE"];
  const originalKey = process.env["ROOTSYS_API_KEY"];

  try {
    fs.mkdirSync(path.join(workDir, ".guild"), { recursive: true });
    fs.writeFileSync(stub, `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(envDump)}, JSON.stringify(process.env));
process.exit(0);
`, "utf8");
    process.env["AGENT_CMD"] = stub;
    process.env["GUILD_WORKSPACE"] = workDir;
    process.env["ROOTSYS_API_KEY"] = CREDENTIAL_VALUE;

    await spawnAgent({
      agent: "review-agent",
      model: "test-model",
      prompt: "resolve check",
      db,
      logDir: workDir,
    });

    const agentEnv = JSON.parse(fs.readFileSync(envDump, "utf8")) as Record<string, string>;
    const resolved = resolveAgentLaunch({
      config: config(),
      root: workDir,
      env: process.env,
      model: "test-model",
    });

    assert.equal(resolved.harness.command, stub, "the runner and the resolver must agree on the command");
    assert.equal(agentEnv["AGENT_PROVIDER_BASE_URL"], resolved.agentEnv["AGENT_PROVIDER_BASE_URL"]);
    assert.equal(agentEnv["AGENT_PROVIDER_API_KEY_ENV"], resolved.agentEnv["AGENT_PROVIDER_API_KEY_ENV"]);
    assert.equal(agentEnv["AGENT_PROVIDER_BASE_URL"], "https://rootsys.cloud/v1");
  } finally {
    if (originalAgentCmd === undefined) delete process.env["AGENT_CMD"];
    else process.env["AGENT_CMD"] = originalAgentCmd;
    if (originalWorkspace === undefined) delete process.env["GUILD_WORKSPACE"];
    else process.env["GUILD_WORKSPACE"] = originalWorkspace;
    if (originalKey === undefined) delete process.env["ROOTSYS_API_KEY"];
    else process.env["ROOTSYS_API_KEY"] = originalKey;
    db.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});
