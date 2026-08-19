import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { DEFAULT_GUILD_CONFIG, type GuildConfig, type ResolvedGuildConfig } from "../guildctl/config";
import { resolveAgentLaunch, resolveHarness, selectRouteModel, toResolvedRuntimeReport } from "../guildctl/harness";
import { harnessReviewer, REVIEW_MARKER } from "../guildctl/commands/auto";
import { spawnAgent } from "../guildctl/runner";
import { applySchema } from "../registry/db/schema";
import { makeTempDir } from "./truthful-run-state-fixtures";

/**
 * Foundational coverage for T012 (FR-011): one shared launch resolver.
 *
 * The point is not that `resolveAgentLaunch()` returns correct values — it is
 * that the runner reads *this* function, so preflight (US2) and the run-start
 * line (US3) cannot describe a runtime a run does not use.
 *
 * T031a extends that commitment to the two autonomous launch sites in
 * `commands/auto.ts` — the scripted worker (the `default` route) and the
 * independent reviewer (the `review` route) — so no third resolution path
 * exists for an autonomous run to drift through.
 */

const CREDENTIAL_VALUE = "sk-live-do-not-leak-0123456789";
// Hoisted redaction fixture for the same pre-commit secret-scanner reason.
const OTHER_SECRET_VALUE = "another-secret";

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
      env: { OPENAI_API_KEY: CREDENTIAL_VALUE },
    });

    assert.equal(resolved.harness.name, "opencode");
    assert.equal(resolved.harness.source, "config");
    assert.ok(resolved.harness.command.endsWith(path.join("harness", "opencode.mjs")));
    assert.equal(resolved.providerBaseUrl, "https://api.openai.com/v1");
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
      env: { OPENAI_API_KEY: CREDENTIAL_VALUE },
    });

    assert.equal(resolved.credentialEnv, "OPENAI_API_KEY");

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

test("toResolvedRuntimeReport excludes the private launch environment and credential values", () => {
  const root = makeTempDir("guild-runtime-report-");
  try {
    const resolved = resolveAgentLaunch({
      config: config(),
      root,
      // Value hoisted (OTHER_SECRET_VALUE) for the pre-commit secret scanner.
      env: { OPENAI_API_KEY: CREDENTIAL_VALUE, OTHER_SECRET: OTHER_SECRET_VALUE },
    });

    const report = toResolvedRuntimeReport(resolved);
    assert.equal("agentEnv" in report, false);
    assert.equal(JSON.stringify(report).includes(CREDENTIAL_VALUE), false);
    assert.equal(JSON.stringify(report).includes("another-secret"), false);
    assert.equal(resolved.agentEnv.OPENAI_API_KEY, CREDENTIAL_VALUE);
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
      env: { AGENT_CMD: "/opt/custom/agent", OPENAI_API_KEY: CREDENTIAL_VALUE },
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
      env: { AGENT_PROVIDER_BASE_URL: "https://ambient.example/v1", OPENAI_API_KEY: CREDENTIAL_VALUE },
      model: "gpt-4o",
    });

    const modelDivergence = resolved.divergences.find((d) => d.setting === "model.model");
    assert.ok(modelDivergence);
    assert.equal(modelDivergence.declaredValue, DEFAULT_GUILD_CONFIG.model.model);
    assert.equal(modelDivergence.resolvedValue, "gpt-4o");

    const urlDivergence = resolved.divergences.find((d) => d.setting === "model.base_url");
    assert.ok(urlDivergence);
    assert.equal(urlDivergence.declaredValue, "https://api.openai.com/v1");
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
      env: { PATH: "/usr/bin", OPENAI_API_KEY: CREDENTIAL_VALUE },
      extraEnv: { GUILDCTL_RUN_ID: "run-1234" },
    });

    assert.equal(resolved.agentEnv["AGENT_PROVIDER_BASE_URL"], "https://api.openai.com/v1");
    assert.equal(resolved.agentEnv["AGENT_PROVIDER_API_KEY_ENV"], "OPENAI_API_KEY");
    assert.equal(resolved.agentEnv["GUILDCTL_RUN_ID"], "run-1234");
    // The ambient environment is inherited, credential included — the agent
    // needs it. What must not happen is the *resolved config* carrying it.
    assert.equal(resolved.agentEnv["PATH"], "/usr/bin");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the autonomous worker route selects its model through resolveProviderRoute, clamping at the last attempt", () => {
  const root = makeTempDir("guild-runtime-worker-route-");
  const routed = config({
    provider: { routes: { default: ["worker-a", "worker-b"], review: ["review-a"] } },
  });
  try {
    // Attempt 0 and 1 walk the route; every later attempt clamps at the last
    // model rather than falling off the end of the route.
    assert.equal(selectRouteModel(routed, "default", 0), "worker-a");
    assert.equal(selectRouteModel(routed, "default", 1), "worker-b");
    assert.equal(selectRouteModel(routed, "default", 7), "worker-b");

    const first = resolveAgentLaunch({ config: routed, root, env: { OPENAI_API_KEY: CREDENTIAL_VALUE }, route: "default" });
    const retry = resolveAgentLaunch({ config: routed, root, env: { OPENAI_API_KEY: CREDENTIAL_VALUE }, route: "default", attempt: 1 });

    assert.equal(first.model, "worker-a");
    assert.equal(retry.model, "worker-b");
    // A route-selected model that differs from the declared one is still a
    // divergence — the report must not go quiet because a route picked it.
    assert.ok(retry.divergences.some((d) => d.setting === "model.model" && d.resolvedValue === "worker-b"));

    // An explicit model still wins over route selection (the reviewer needs it).
    const pinned = resolveAgentLaunch({ config: routed, root, env: {}, route: "default", attempt: 1, model: "pinned-model" });
    assert.equal(pinned.model, "pinned-model");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the autonomous review route resolves through the same resolver as the worker route", () => {
  const root = makeTempDir("guild-runtime-review-route-");
  const routed = config({
    provider: { routes: { default: ["worker-a"], review: ["review-a", "review-b"] } },
  });
  try {
    assert.equal(selectRouteModel(routed, "review", 0), "review-a");
    assert.equal(selectRouteModel(routed, "review", 1), "review-b");

    const worker = resolveAgentLaunch({ config: routed, root, env: { OPENAI_API_KEY: CREDENTIAL_VALUE }, route: "default" });
    const reviewer = resolveAgentLaunch({ config: routed, root, env: { OPENAI_API_KEY: CREDENTIAL_VALUE }, route: "review" });

    assert.equal(worker.model, "worker-a");
    assert.equal(reviewer.model, "review-a");
    // Same harness, same provider, same credential variable — only the model
    // differs, because only the route differs.
    assert.deepEqual(reviewer.harness, worker.harness);
    assert.equal(reviewer.providerBaseUrl, worker.providerBaseUrl);
    assert.equal(reviewer.credentialEnv, worker.credentialEnv);

    // An unknown route falls back to the default route rather than inventing a
    // model, so a typo cannot silently launch an unconfigured runtime.
    assert.equal(selectRouteModel(routed, "no-such-route", 0), "worker-a");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the autonomous reviewer launches through resolveAgentLaunch, so its env matches the resolved one", async () => {
  const workspace = makeTempDir("guild-runtime-reviewer-");
  const script = path.join(workspace, "reviewer.cjs");
  const originalAgentCmd = process.env["AGENT_CMD"];
  const originalBaseUrl = process.env["AGENT_PROVIDER_BASE_URL"];
  const originalKey = process.env["OPENAI_API_KEY"];

  try {
    // The reviewer's environment must come from the shared resolver, which
    // honours an ambient AGENT_PROVIDER_BASE_URL override. A hand-built env
    // read straight from project config would send the declared URL instead.
    fs.writeFileSync(script, `
if (process.env.AGENT_PROVIDER_BASE_URL !== "https://ambient.example/v1") process.exit(41);
if (process.env.AGENT_PROVIDER_API_KEY_ENV !== "OPENAI_API_KEY") process.exit(42);
if (process.env.GUILDCTL_AGENT_MODEL !== "review-a") process.exit(43);
if (process.env.GUILDCTL_CLAIM_TOKEN || process.env.GUILDCTL_OPERATOR_TOKEN) process.exit(44);
if (process.argv.join(" ").includes(${JSON.stringify(CREDENTIAL_VALUE)})) process.exit(45);
console.log('${REVIEW_MARKER}' + JSON.stringify({ approved: true, reason: "resolved reviewer runtime" }));
`, "utf8");
    process.env["AGENT_CMD"] = script;
    process.env["AGENT_PROVIDER_BASE_URL"] = "https://ambient.example/v1";
    process.env["OPENAI_API_KEY"] = CREDENTIAL_VALUE;

    const cfg: ResolvedGuildConfig = {
      ...config({ provider: { routes: { default: ["worker-a"], review: ["worker-a", "review-a"] } } }),
      guildRoot: workspace,
      configPath: path.join(workspace, ".guild", "config.yaml"),
      selectedProfile: "default",
    };

    const review = harnessReviewer(workspace, cfg, () => "worker-a");
    const decision = await review({
      artifactId: "legacy-source:com.acme:Runtime",
      runId: "run-reviewer-resolution",
      producerAgent: "code-writer-agent",
      producerModel: "worker-a",
      evidence: [],
    });

    assert.equal(decision.approved, true);
    // The producing model is skipped, so review stays independent while the
    // model still comes from the review route via the shared resolver.
    assert.equal(decision.reviewerModel, "review-a");
  } finally {
    if (originalAgentCmd === undefined) delete process.env["AGENT_CMD"];
    else process.env["AGENT_CMD"] = originalAgentCmd;
    if (originalBaseUrl === undefined) delete process.env["AGENT_PROVIDER_BASE_URL"];
    else process.env["AGENT_PROVIDER_BASE_URL"] = originalBaseUrl;
    if (originalKey === undefined) delete process.env["OPENAI_API_KEY"];
    else process.env["OPENAI_API_KEY"] = originalKey;
    fs.rmSync(workspace, { recursive: true, force: true });
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

// ─── US2 (FR-004..FR-006): GUILDCTL_HARNESS precedence ────────────────────────

test("GUILDCTL_HARNESS overrides config.harness without editing Guild configuration", () => {
  const root = makeTempDir("guild-runtime-guildctl-harness-");
  try {
    const resolved = resolveHarness(config({ harness: "codex" }), root, { GUILDCTL_HARNESS: "opencode" });
    assert.equal(resolved.name, "opencode");
    assert.equal(resolved.source, "config");
    assert.ok(resolved.command.endsWith(path.join("harness", "opencode.mjs")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("GUILDCTL_HARNESS beats the opencode default and leaves config.harness untouched", () => {
  const root = makeTempDir("guild-runtime-guildctl-default-");
  try {
    const resolved = resolveHarness(config(), root, { GUILDCTL_HARNESS: "goose" });
    assert.equal(resolved.name, "goose");
    assert.equal(resolved.source, "config");
    assert.ok(resolved.command.endsWith(path.join("harness", "goose.mjs")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an unset or empty GUILDCTL_HARNESS falls back to config.harness then the opencode default", () => {
  const root = makeTempDir("guild-runtime-guildctl-unset-");
  try {
    assert.equal(resolveHarness(config({ harness: "codex" }), root, {}).name, "codex");
    assert.equal(resolveHarness(config(), root, { GUILDCTL_HARNESS: "" }).name, "opencode");
    assert.equal(resolveHarness(config(), root, { GUILDCTL_HARNESS: "   " }).name, "opencode");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("GUILDCTL_HARNESS and AGENT_CMD are independent overrides; AGENT_CMD still wins as custom", () => {
  const root = makeTempDir("guild-runtime-guildctl-vs-agentcmd-");
  try {
    const both = resolveHarness(config(), root, { GUILDCTL_HARNESS: "goose", AGENT_CMD: "/opt/custom/agent" });
    assert.equal(both.name, "custom");
    assert.equal(both.source, "environment");
    // GUILDCTL_HARNESS alone (no AGENT_CMD) resolves the bundled harness.
    const onlyGuildctl = resolveHarness(config(), root, { GUILDCTL_HARNESS: "goose" });
    assert.equal(onlyGuildctl.name, "goose");
    assert.equal(onlyGuildctl.source, "config");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("GUILDCTL_HARNESS with an unknown value throws like any unknown harness", () => {
  const root = makeTempDir("guild-runtime-guildctl-unknown-");
  try {
    assert.throws(
      () => resolveHarness(config(), root, { GUILDCTL_HARNESS: "nope" }),
      /Unknown harness/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a GUILDCTL_HARNESS divergence is keyed via originOf, leaving the AGENT_CMD source intact", () => {
  const root = makeTempDir("guild-runtime-guildctl-divergence-");
  try {
    const resolved = resolveAgentLaunch({
      config: config(),
      root,
      env: { GUILDCTL_HARNESS: "goose", OPENAI_API_KEY: CREDENTIAL_VALUE },
      envOrigin: { GUILDCTL_HARNESS: "project-file" },
    });
    const divergence = resolved.divergences.find((d) => d.setting === "harness");
    assert.ok(divergence, "a GUILDCTL_HARNESS override diverges from the declared harness");
    assert.equal(divergence.declaredValue, "opencode");
    assert.equal(divergence.resolvedValue, "goose");
    assert.equal(divergence.source, "project-file");

    // The AGENT_CMD case still keys its divergence off AGENT_CMD, never GUILDCTL_HARNESS.
    const agentCmd = resolveAgentLaunch({
      config: config(),
      root,
      env: { AGENT_CMD: "/opt/custom/agent", OPENAI_API_KEY: CREDENTIAL_VALUE },
      envOrigin: { AGENT_CMD: "project-file" },
    });
    const agentDivergence = agentCmd.divergences.find((d) => d.setting === "harness");
    assert.ok(agentDivergence);
    assert.equal(agentDivergence.declaredValue, "opencode");
    assert.equal(agentDivergence.resolvedValue, "custom");
    assert.equal(agentDivergence.source, "project-file");
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
  const originalKey = process.env["OPENAI_API_KEY"];

  try {
    fs.mkdirSync(path.join(workDir, ".guild"), { recursive: true });
    fs.writeFileSync(stub, `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(envDump)}, JSON.stringify(process.env));
process.exit(0);
`, "utf8");
    process.env["AGENT_CMD"] = stub;
    process.env["GUILD_WORKSPACE"] = workDir;
    process.env["OPENAI_API_KEY"] = CREDENTIAL_VALUE;

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
    assert.equal(agentEnv["AGENT_PROVIDER_BASE_URL"], "https://api.openai.com/v1");
  } finally {
    if (originalAgentCmd === undefined) delete process.env["AGENT_CMD"];
    else process.env["AGENT_CMD"] = originalAgentCmd;
    if (originalWorkspace === undefined) delete process.env["GUILD_WORKSPACE"];
    else process.env["GUILD_WORKSPACE"] = originalWorkspace;
    if (originalKey === undefined) delete process.env["OPENAI_API_KEY"];
    else process.env["OPENAI_API_KEY"] = originalKey;
    db.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});
