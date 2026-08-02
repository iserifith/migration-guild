import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { DEFAULT_GUILD_CONFIG, type GuildConfig } from "../guildctl/config";
import {
  envOriginMap,
  lastEnvLoad,
  loadGuildEnvironment,
  hasAmbientEnvFlag,
  resolveEnvPrecedenceMode,
  type EnvDivergence,
} from "../guildctl/env";
import { resolveAgentLaunch, toResolvedRuntimeReport } from "../guildctl/harness";
import { emitRuntimeReport, renderRuntimeReport, resolveAndReportRuntime, RUNTIME_LINE_PREFIX } from "../guildctl/runtime-report";
import { spawnAgent, type SpawnAgentOpts } from "../guildctl/runner";
import { runRemediate } from "../guildctl/commands/remediate";
import { runAutoRunCommand } from "../guildctl/commands/auto-run";
import { isSensitiveEnvName } from "../guildctl/verify";
import type { PreflightResult } from "../guildctl/preflight";
import { applySchema } from "../registry/db/schema";
import { makeTempDir, tsxLoaderUrl, repoMigrationRoot } from "./truthful-run-state-fixtures";

/**
 * US3 (FR-020–FR-026): the workspace `.env` describes the runtime, and the run
 * says so out loud.
 *
 * Two commitments are under test. First, precedence: absent an explicit opt-in
 * a value in the workspace `.env` beats the same value inherited from the
 * ambient environment, and the divergence between them is computed *before*
 * either side is applied so it can be reported no matter which side won.
 * Second, visibility: one run-start line per entry point, rendered from the
 * same resolution the run launches with, never carrying a credential value.
 */

const CREDENTIAL_VALUE = "sk-live-do-not-leak-0123456789";
const AMBIENT_CREDENTIAL = "sk-live-ambient-9876543210";

function config(overrides: Partial<GuildConfig> = {}): GuildConfig {
  return { ...structuredClone(DEFAULT_GUILD_CONFIG), ...overrides } as GuildConfig;
}

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

/** A workspace whose `.env` holds `contents`, plus its path. */
function workspaceWithEnv(prefix: string, contents: string | null): string {
  const root = makeTempDir(prefix);
  if (contents != null) fs.writeFileSync(path.join(root, ".env"), contents, "utf8");
  return root;
}

/** An install-relative compatibility candidate file, outside the workspace. */
function installCandidate(dir: string, name: string, contents: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, contents, "utf8");
  return file;
}

function divergenceFor(divergences: EnvDivergence[], variable: string): EnvDivergence | undefined {
  return divergences.find((d) => d.variable === variable);
}

function captureStdout<T>(fn: () => T): { output: string; value: T } {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout.write as unknown) = (chunk: string | Uint8Array): boolean => {
    chunks.push(chunk.toString());
    return true;
  };
  const originalLog = console.log;
  console.log = (...args: unknown[]) => { chunks.push(args.map(String).join(" ") + "\n"); };
  try {
    const value = fn();
    return { output: chunks.join(""), value };
  } finally {
    (process.stdout.write as unknown) = original;
    console.log = originalLog;
  }
}

async function captureStdoutAsync(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout.write as unknown) = (chunk: string | Uint8Array): boolean => {
    chunks.push(chunk.toString());
    return true;
  };
  const originalLog = console.log;
  console.log = (...args: unknown[]) => { chunks.push(args.map(String).join(" ") + "\n"); };
  try {
    await fn();
    return chunks.join("");
  } finally {
    (process.stdout.write as unknown) = original;
    console.log = originalLog;
  }
}

function countRuntimeLines(output: string): number {
  return output.split("\n").filter((line) => line.startsWith(`${RUNTIME_LINE_PREFIX} runtime:`)).length;
}

// ─── A. Precedence ───────────────────────────────────────────────────────────

test("without the opt-in the workspace .env value wins over the ambient value", () => {
  const root = workspaceWithEnv("guild-env-project-wins-", "AGENT_CMD=/from/dot-env\nMODEL_TAG=file\n");
  try {
    const target: NodeJS.ProcessEnv = {};
    const result = loadGuildEnvironment({
      cwd: root,
      ambient: { AGENT_CMD: "/from/ambient", MODEL_TAG: "ambient" },
      target,
      argv: [],
    });

    assert.equal(result.mode, "project");
    assert.equal(target["AGENT_CMD"], "/from/dot-env");
    assert.equal(target["MODEL_TAG"], "file");
    assert.equal(result.origin["AGENT_CMD"], "project-file");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("GUILD_ENV_PRECEDENCE=ambient keeps the ambient value", () => {
  const root = workspaceWithEnv("guild-env-ambient-var-", "AGENT_CMD=/from/dot-env\n");
  try {
    const target: NodeJS.ProcessEnv = {};
    const result = loadGuildEnvironment({
      cwd: root,
      ambient: { AGENT_CMD: "/from/ambient", GUILD_ENV_PRECEDENCE: "ambient" },
      target,
      argv: [],
    });

    assert.equal(result.mode, "ambient");
    assert.equal(target["AGENT_CMD"], "/from/ambient");
    assert.equal(result.origin["AGENT_CMD"], "ambient");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the --ambient-env flag keeps the ambient value and is read from raw argv", () => {
  const root = workspaceWithEnv("guild-env-ambient-flag-", "AGENT_CMD=/from/dot-env\n");
  try {
    assert.equal(hasAmbientEnvFlag(["node", "guildctl", "migrate", "--ambient-env"]), true);
    assert.equal(hasAmbientEnvFlag(["node", "guildctl", "migrate"]), false);

    const target: NodeJS.ProcessEnv = {};
    const result = loadGuildEnvironment({
      cwd: root,
      ambient: { AGENT_CMD: "/from/ambient" },
      target,
      argv: ["node", "guildctl", "migrate", "--ambient-env"],
    });

    assert.equal(result.mode, "ambient");
    assert.equal(target["AGENT_CMD"], "/from/ambient");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ─── B. Divergence reporting ─────────────────────────────────────────────────

test("the divergence set is computed before either side is applied and reported in both modes", () => {
  const root = workspaceWithEnv(
    "guild-env-divergence-",
    "AGENT_PROVIDER_BASE_URL=https://example-private.invalid/v1\n",
  );
  try {
    const ambient = { AGENT_PROVIDER_BASE_URL: "https://api.openai.com/v1" };

    const projectMode = loadGuildEnvironment({ cwd: root, ambient, target: {}, argv: [] });
    const projectDivergence = divergenceFor(projectMode.divergences, "AGENT_PROVIDER_BASE_URL");
    assert.ok(projectDivergence, "the divergence is reported when the project file wins");
    assert.equal(projectDivergence.projectValue, "https://example-private.invalid/v1");
    assert.equal(projectDivergence.ambientValue, "https://api.openai.com/v1");
    assert.equal(projectDivergence.winner, "project-file");

    // The ambient opt-in changes the winner, not whether the divergence is
    // reported: both values are still known because neither was destroyed.
    const ambientMode = loadGuildEnvironment({
      cwd: root,
      ambient,
      target: {},
      argv: ["--ambient-env"],
    });
    const ambientDivergence = divergenceFor(ambientMode.divergences, "AGENT_PROVIDER_BASE_URL");
    assert.ok(ambientDivergence, "the divergence is reported when the ambient value wins");
    assert.equal(ambientDivergence.projectValue, "https://example-private.invalid/v1");
    assert.equal(ambientDivergence.ambientValue, "https://api.openai.com/v1");
    assert.equal(ambientDivergence.winner, "ambient");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a sensitive variable reports both values as <redacted> while the name and winner remain", () => {
  const root = workspaceWithEnv("guild-env-secret-", `EXAMPLE_PRIVATE_API_KEY=${CREDENTIAL_VALUE}\nPLAIN_SETTING=file\n`);
  try {
    // One definition of "secret" governs evidence logs, preflight, and this
    // report — the predicate is imported, not re-spelled.
    assert.equal(isSensitiveEnvName("EXAMPLE_PRIVATE_API_KEY"), true);
    assert.equal(isSensitiveEnvName("PLAIN_SETTING"), false);

    const result = loadGuildEnvironment({
      cwd: root,
      ambient: { EXAMPLE_PRIVATE_API_KEY: AMBIENT_CREDENTIAL, PLAIN_SETTING: "ambient" },
      target: {},
      argv: [],
    });

    const secret = divergenceFor(result.divergences, "EXAMPLE_PRIVATE_API_KEY");
    assert.ok(secret);
    assert.equal(secret.secret, true);
    assert.equal(secret.projectValue, "<redacted>");
    assert.equal(secret.ambientValue, "<redacted>");
    assert.equal(secret.winner, "project-file");

    const plain = divergenceFor(result.divergences, "PLAIN_SETTING");
    assert.ok(plain);
    assert.equal(plain.secret, false);
    assert.equal(plain.projectValue, "file");

    // Name-based redaction is authoritative, including for the losing ambient
    // value, so neither credential reaches any rendered output path.
    const rendered = renderRuntimeReport(
      toResolvedRuntimeReport(resolveAgentLaunch({ config: config(), root, env: {} })),
      result.divergences,
    );
    assert.equal(rendered.includes(CREDENTIAL_VALUE), false);
    assert.equal(rendered.includes(AMBIENT_CREDENTIAL), false);
    assert.equal(rendered.includes("EXAMPLE_PRIVATE_API_KEY"), true);
    assert.equal(JSON.stringify(result.divergences).includes(CREDENTIAL_VALUE), false);
    assert.equal(JSON.stringify(result.divergences).includes(AMBIENT_CREDENTIAL), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("single-source, identical, and install-relative-only values are not divergences", () => {
  const root = workspaceWithEnv(
    "guild-env-nondivergent-",
    "ONLY_IN_FILE=file\nSAME_IN_BOTH=identical\nREAL_DIVERGENCE=file\n",
  );
  const installDir = makeTempDir("guild-env-install-");
  try {
    const install = installCandidate(installDir, ".env", "INSTALL_ONLY=install\n");
    const result = loadGuildEnvironment({
      cwd: root,
      installCandidates: [install],
      ambient: {
        ONLY_IN_AMBIENT: "ambient",
        SAME_IN_BOTH: "identical",
        REAL_DIVERGENCE: "ambient",
        INSTALL_ONLY: "ambient",
      },
      target: {},
      argv: [],
    });

    assert.deepEqual(result.divergences.map((d) => d.variable), ["REAL_DIVERGENCE"]);
    assert.equal(divergenceFor(result.divergences, "ONLY_IN_FILE"), undefined);
    assert.equal(divergenceFor(result.divergences, "ONLY_IN_AMBIENT"), undefined);
    assert.equal(divergenceFor(result.divergences, "SAME_IN_BOTH"), undefined);
    // The install-relative candidate is a compatibility input only: it neither
    // enters the project-local divergence set nor overrides an ambient value.
    assert.equal(divergenceFor(result.divergences, "INSTALL_ONLY"), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(installDir, { recursive: true, force: true });
  }
});

test("an install-relative value never wins over ambient, and never over the workspace .env", () => {
  const root = workspaceWithEnv("guild-env-install-loses-", "SHARED=workspace\n");
  const installDir = makeTempDir("guild-env-install-order-");
  try {
    const install = installCandidate(installDir, ".env", "SHARED=install\nINSTALL_ONLY=install\nAMBIENT_HELD=install\n");
    const target: NodeJS.ProcessEnv = {};
    const result = loadGuildEnvironment({
      cwd: root,
      installCandidates: [install],
      ambient: { SHARED: "ambient", AMBIENT_HELD: "ambient" },
      target,
      argv: [],
    });

    assert.equal(target["SHARED"], "workspace");
    // Present in an install-relative file and in the ambient environment: the
    // ambient value stands, exactly as dotenv's non-overriding load did.
    assert.equal(target["AMBIENT_HELD"], "ambient");
    // Absent from the ambient environment: the compatibility candidate still
    // supplies it, so existing installs keep working.
    assert.equal(target["INSTALL_ONLY"], "install");
    assert.equal(result.origin["AMBIENT_HELD"], "ambient");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(installDir, { recursive: true, force: true });
  }
});

test("the existing inter-file candidate order is preserved: the first file defining a variable wins", () => {
  const root = workspaceWithEnv("guild-env-order-", "FIRST=workspace\n");
  const installDirA = makeTempDir("guild-env-order-a-");
  const installDirB = makeTempDir("guild-env-order-b-");
  try {
    const a = installCandidate(installDirA, ".env", "FIRST=install-a\nSECOND=install-a\n");
    const b = installCandidate(installDirB, ".env", "SECOND=install-b\nTHIRD=install-b\n");
    const target: NodeJS.ProcessEnv = {};
    loadGuildEnvironment({ cwd: root, installCandidates: [a, b], ambient: {}, target, argv: [] });

    assert.equal(target["FIRST"], "workspace");
    assert.equal(target["SECOND"], "install-a");
    assert.equal(target["THIRD"], "install-b");
  } finally {
    for (const dir of [root, installDirA, installDirB]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── C. Bootstrap rule ───────────────────────────────────────────────────────

test("the precedence mode is read only from the ambient snapshot and the flag, never from a .env", () => {
  const root = workspaceWithEnv(
    "guild-env-bootstrap-",
    "GUILD_ENV_PRECEDENCE=ambient\nAGENT_CMD=/from/dot-env\n",
  );
  try {
    const target: NodeJS.ProcessEnv = {};
    const result = loadGuildEnvironment({
      cwd: root,
      ambient: { AGENT_CMD: "/from/ambient" },
      target,
      argv: [],
    });

    // A project file cannot grant itself ambient precedence, so it cannot
    // switch the mode that decides its own precedence.
    assert.equal(result.mode, "project");
    assert.equal(target["AGENT_CMD"], "/from/dot-env");

    assert.equal(resolveEnvPrecedenceMode({ GUILD_ENV_PRECEDENCE: "ambient" }, false), "ambient");
    assert.equal(resolveEnvPrecedenceMode({}, true), "ambient");
    assert.equal(resolveEnvPrecedenceMode({ GUILD_ENV_PRECEDENCE: "project" }, false), "project");
    assert.equal(resolveEnvPrecedenceMode({}, false), "project");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ─── D. Run-start line ───────────────────────────────────────────────────────

test("an absent workspace .env still prints the run-start line", () => {
  const root = workspaceWithEnv("guild-env-absent-", null);
  try {
    const result = loadGuildEnvironment({ cwd: root, ambient: {}, target: {}, argv: [] });
    assert.deepEqual(result.divergences, []);
    assert.equal(fs.existsSync(path.join(root, ".env")), false);

    const lines: string[] = [];
    resolveAndReportRuntime({
      config: config(),
      root,
      envLoad: result,
      write: (text) => lines.push(text),
    });

    const output = lines.join("");
    assert.equal(countRuntimeLines(output), 1);
    assert.match(output, /runtime: harness=opencode provider=https:\/\/example-private.invalid\/v1 model=/);
    // No divergences means nothing beyond the resolved provider/model line.
    assert.equal(output.includes("environment:"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the run-start line and the launch handed to spawnAgent come from one resolution", () => {
  const root = workspaceWithEnv("guild-env-one-resolution-", null);
  try {
    const lines: string[] = [];
    const resolution = resolveAndReportRuntime({
      config: config(),
      root,
      env: { AGENT_CMD: "/opt/custom/agent", EXAMPLE_PRIVATE_API_KEY: CREDENTIAL_VALUE },
      envLoad: { mode: "project", divergences: [], origin: { AGENT_CMD: "project-file" }, workspaceEnvPath: path.join(root, ".env"), filesApplied: [] },
      write: (text) => lines.push(text),
    });

    // The helper renders the very object it returns; a second resolution for
    // reporting is what FR-024 exists to prevent.
    assert.equal(lines.join(""), renderRuntimeReport(toResolvedRuntimeReport(resolution), []));
    assert.equal(resolution.harness.command, "/opt/custom/agent");

    // FR-025: the divergence names the setting, both values, and the source the
    // resolved value actually came from.
    const divergence = resolution.divergences.find((d) => d.setting === "harness");
    assert.ok(divergence);
    assert.equal(divergence.declaredValue, "opencode");
    assert.equal(divergence.resolvedValue, "custom");
    assert.equal(divergence.source, "project-file");
    assert.match(lines.join(""), /config divergence: harness declared opencode, resolved custom \(source: project-file\)/);
    assert.equal(lines.join("").includes(CREDENTIAL_VALUE), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("spawnAgent consumes a supplied resolution instead of resolving a second time", async () => {
  const db = createDb();
  const workDir = makeTempDir("guild-env-spawn-resolution-");
  const suppliedStub = path.join(workDir, "supplied-agent.cjs");
  const rejectedStub = path.join(workDir, "rejected-agent.cjs");
  const envDump = path.join(workDir, "agent-env.json");
  const originalAgentCmd = process.env["AGENT_CMD"];
  const originalWorkspace = process.env["GUILD_WORKSPACE"];

  try {
    fs.writeFileSync(suppliedStub, `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(envDump)}, JSON.stringify(process.env));
process.exit(0);
`, "utf8");
    fs.writeFileSync(rejectedStub, `process.exit(9);\n`, "utf8");

    const resolution = resolveAgentLaunch({
      config: config(),
      root: workDir,
      env: { AGENT_CMD: suppliedStub, PHASE_ENTRY_MARKER: "resolved-at-phase-entry" },
      model: "entry-model",
    });

    // If spawnAgent re-resolved, it would read this ambient AGENT_CMD and run
    // the rejected stub with an environment the run-start line never described.
    process.env["AGENT_CMD"] = rejectedStub;
    process.env["GUILD_WORKSPACE"] = workDir;

    const output = await captureStdoutAsync(async () => {
      await spawnAgent({
        agent: "review-agent",
        model: "entry-model",
        prompt: "supplied resolution",
        db,
        logDir: workDir,
        resolution,
      } satisfies SpawnAgentOpts);
    });

    assert.equal(fs.existsSync(envDump), true, "the supplied resolution's harness command must be the one spawned");
    const agentEnv = JSON.parse(fs.readFileSync(envDump, "utf8")) as Record<string, string>;
    assert.equal(agentEnv["PHASE_ENTRY_MARKER"], "resolved-at-phase-entry");
    // Only run-scoped variables are merged on top of the supplied agentEnv.
    assert.equal(agentEnv["GUILDCTL_AGENT_KIND"], "review-agent");
    assert.ok(agentEnv["GUILDCTL_RUN_ID"]);
    // The shared spawn helper reports nothing; the phase seam owns the line.
    assert.equal(countRuntimeLines(output), 0);
  } finally {
    if (originalAgentCmd === undefined) delete process.env["AGENT_CMD"];
    else process.env["AGENT_CMD"] = originalAgentCmd;
    if (originalWorkspace === undefined) delete process.env["GUILD_WORKSPACE"];
    else process.env["GUILD_WORKSPACE"] = originalWorkspace;
    db.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test("a manual phase emits exactly one run-start line and launches with that resolution", async () => {
  const db = createDb();
  const root = makeTempDir("guild-env-phase-entry-");
  const stub = path.join(root, "phase-agent.cjs");
  const originalAgentCmd = process.env["AGENT_CMD"];
  const originalWorkspace = process.env["GUILD_WORKSPACE"];
  const originalKey = process.env["EXAMPLE_PRIVATE_API_KEY"];

  try {
    fs.writeFileSync(stub, "process.exit(0);\n", "utf8");
    // The workspace `.env` is the source of the harness, so the reported
    // divergence must attribute it to the project file rather than the ambient
    // environment it beat.
    fs.writeFileSync(path.join(root, ".env"), `AGENT_CMD=${stub}\n`, "utf8");
    process.env["AGENT_CMD"] = "/ambient/agent";
    process.env["EXAMPLE_PRIVATE_API_KEY"] = CREDENTIAL_VALUE;
    process.env["GUILD_WORKSPACE"] = root;

    const load = loadGuildEnvironment({ cwd: root, ambient: { ...process.env }, target: process.env, argv: [] });
    assert.equal(process.env["AGENT_CMD"], stub);
    assert.equal(envOriginMap()["AGENT_CMD"], "project-file");
    assert.equal(lastEnvLoad()?.mode, "project");
    assert.ok(divergenceFor(load.divergences, "AGENT_CMD"));

    const launches: SpawnAgentOpts[] = [];
    const output = await captureStdoutAsync(async () => {
      await runRemediate(db, {}, {
        getLogDir: () => root,
        startPolling: () => () => {},
        spawnAgent: async (opts) => {
          launches.push(opts);
          return { runId: "run-remediate", agent: opts.agent, model: opts.model, prompt: opts.prompt, exitCode: 0 };
        },
      });
    });

    assert.equal(countRuntimeLines(output), 1, "exactly one run-start line per manual entry point");
    assert.equal(launches.length, 1);
    const resolution = launches[0].resolution;
    assert.ok(resolution, "the phase passes its resolution through SpawnAgentOpts");
    assert.equal(resolution.harness.command, stub);

    // The emitted line is the rendering of the object the run launched with.
    const runtimeBlock = output
      .split("\n")
      .filter((line) => line.startsWith(RUNTIME_LINE_PREFIX) || line.startsWith("           ") || line.startsWith("  AGENT"))
      .join("\n") + "\n";
    assert.equal(
      runtimeBlock,
      renderRuntimeReport(toResolvedRuntimeReport(resolution), load.divergences),
    );
    const harnessDivergence = resolution.divergences.find((d) => d.setting === "harness");
    assert.ok(harnessDivergence);
    assert.equal(harnessDivergence.source, "project-file");
    assert.equal(output.includes(CREDENTIAL_VALUE), false);
  } finally {
    if (originalAgentCmd === undefined) delete process.env["AGENT_CMD"];
    else process.env["AGENT_CMD"] = originalAgentCmd;
    if (originalWorkspace === undefined) delete process.env["GUILD_WORKSPACE"];
    else process.env["GUILD_WORKSPACE"] = originalWorkspace;
    if (originalKey === undefined) delete process.env["EXAMPLE_PRIVATE_API_KEY"];
    else process.env["EXAMPLE_PRIVATE_API_KEY"] = originalKey;
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the autonomous queue emits exactly one run-start line before dispatch", async () => {
  const db = createDb();
  const root = makeTempDir("guild-env-auto-run-");
  try {
    const preflight: PreflightResult = {
      verdict: "pass",
      resolved: {
        harness: { name: "opencode", command: "/kit/harness/opencode.mjs", targetCommand: "opencode", source: "config" },
        providerBaseUrl: DEFAULT_GUILD_CONFIG.model.base_url ?? "",
        model: DEFAULT_GUILD_CONFIG.model.model,
        credentialEnv: DEFAULT_GUILD_CONFIG.model.api_key_env ?? "",
        divergences: [],
      },
      divergences: [],
      stages: [{ id: "resolution", status: "pass" }, { id: "response", status: "pass" }],
      elapsedMs: 1,
      budgetSeconds: 30,
    };

    let output = "";
    await runAutoRunCommand(db, {
      registryDbPath: path.join(root, "registry.db"),
      setExitCode: false,
      workspaceRoot: root,
    }, {
      preflight: async () => preflight,
      executeArtifact: async () => ({ status: "complete", runId: "run-1", attempts: 1 }),
      write: (text) => { output += text; },
    });

    assert.equal(countRuntimeLines(output), 1);
    assert.match(output, /\[guildctl\] runtime: harness=opencode/);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ─── E. Reproducibility (SC-003) ─────────────────────────────────────────────

test("identical checkouts with differing ambient environments resolve the same provider and model", () => {
  const envFile = "AGENT_PROVIDER_BASE_URL=https://example-private.invalid/v1\nAGENT_CMD=/checkout/agent\n";
  const machineA = workspaceWithEnv("guild-env-sc003-a-", envFile);
  const machineB = workspaceWithEnv("guild-env-sc003-b-", envFile);
  try {
    const targetA: NodeJS.ProcessEnv = {};
    const targetB: NodeJS.ProcessEnv = {};
    loadGuildEnvironment({
      cwd: machineA,
      ambient: { AGENT_PROVIDER_BASE_URL: "https://api.openai.com/v1", AGENT_CMD: "/machine-a/agent" },
      target: targetA,
      argv: [],
    });
    loadGuildEnvironment({
      cwd: machineB,
      ambient: { AGENT_PROVIDER_BASE_URL: "https://azure.example/v1", AGENT_CMD: "/machine-b/agent" },
      target: targetB,
      argv: [],
    });

    const resolvedA = resolveAgentLaunch({ config: config(), root: machineA, env: targetA });
    const resolvedB = resolveAgentLaunch({ config: config(), root: machineB, env: targetB });

    assert.equal(resolvedA.providerBaseUrl, resolvedB.providerBaseUrl);
    assert.equal(resolvedA.model, resolvedB.model);
    assert.equal(resolvedA.harness.command, resolvedB.harness.command);
    assert.equal(resolvedA.providerBaseUrl, "https://example-private.invalid/v1");
  } finally {
    fs.rmSync(machineA, { recursive: true, force: true });
    fs.rmSync(machineB, { recursive: true, force: true });
  }
});

// ─── F. Module-scope application ─────────────────────────────────────────────

test("a .env-set GUILDCTL_STALL_MINS is observed by a module-scope reader in the real CLI", async () => {
  const root = makeTempDir("guild-env-module-scope-");
  const migrationRoot = repoMigrationRoot();
  const cliPath = path.join(migrationRoot, "guildctl", "cli.ts");
  const dbFile = path.join(root, "registry.db");

  try {
    fs.writeFileSync(path.join(root, ".env"), "GUILDCTL_STALL_MINS=77\n", "utf8");
    const seed = new Database(dbFile);
    applySchema(seed);
    seed.close();

    const child = spawn(
      process.execPath,
      ["--import", tsxLoaderUrl(migrationRoot), cliPath, "--db", dbFile, "--workspace", root, "watch"],
      {
        cwd: root,
        env: {
          PATH: process.env["PATH"] ?? "",
          HOME: process.env["HOME"] ?? root,
          // The ambient value loses to the workspace `.env`, and the module-level
          // constant in commands/watch.ts is evaluated at import time — so the
          // loader must have applied the file before the first command import.
          GUILDCTL_STALL_MINS: "10",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const observed = await new Promise<string>((resolve) => {
      let buffer = "";
      const deadline = setTimeout(() => resolve(buffer), 20_000);
      const settle = (): void => {
        if (/stall threshold: \d+m/.test(buffer)) {
          clearTimeout(deadline);
          resolve(buffer);
        }
      };
      child.stdout.on("data", (chunk: Buffer) => { buffer += chunk.toString(); settle(); });
      child.stderr.on("data", (chunk: Buffer) => { buffer += chunk.toString(); settle(); });
      child.on("exit", () => { clearTimeout(deadline); resolve(buffer); });
    });
    child.kill("SIGKILL");

    assert.match(observed, /stall threshold: 77m/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ─── G. Rendering ────────────────────────────────────────────────────────────

test("the environment divergence block is bounded, names both values, and states the winner", () => {
  const divergences: EnvDivergence[] = [
    {
      variable: "AGENT_PROVIDER_BASE_URL",
      projectValue: "https://example-private.invalid/v1",
      ambientValue: "https://api.openai.com/v1",
      winner: "project-file",
      secret: false,
    },
    { variable: "EXAMPLE_PRIVATE_API_KEY", projectValue: "<redacted>", ambientValue: "<redacted>", winner: "project-file", secret: true },
  ];
  const root = makeTempDir("guild-env-render-");
  try {
    const { output } = captureStdout(() => emitRuntimeReport(
      toResolvedRuntimeReport(resolveAgentLaunch({ config: config(), root, env: {} })),
      { envDivergences: divergences },
    ));

    assert.match(output, /environment: 2 divergence\(s\) between \.env and the inherited environment/);
    assert.match(output, /AGENT_PROVIDER_BASE_URL\s+\.env=https:\/\/example-private.invalid\/v1\s+ambient=https:\/\/api\.openai\.com\/v1\s+→ \.env wins/);
    assert.match(output, /EXAMPLE_PRIVATE_API_KEY\s+\.env=<redacted>\s+ambient=<redacted>\s+→ \.env wins/);
    assert.equal(countRuntimeLines(output), 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
