import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { GuildConfig } from "./config";

export interface HarnessResolution {
  name: string;
  command: string;
  targetCommand: string;
  source: "environment" | "config";
}

function bundledFile(root: string, relativePath: string): string {
  const installed = path.join(root, relativePath);
  if (fs.existsSync(installed)) return installed;
  return path.join(root, "package", relativePath);
}

export function resolveHarness(config: GuildConfig, root: string, env: NodeJS.ProcessEnv = process.env): HarnessResolution {
  if (env.AGENT_CMD) {
    return { name: "custom", command: env.AGENT_CMD, targetCommand: env.AGENT_CMD, source: "environment" };
  }

  const name = config.harness || "opencode";
  if (name === "opencode") {
    return { name, command: bundledFile(root, path.join("harness", "opencode.mjs")), targetCommand: "opencode", source: "config" };
  }
  if (name === "codex") {
    return { name, command: bundledFile(root, path.join("harness", "codex.mjs")), targetCommand: "codex", source: "config" };
  }
  if (name === "copilot") {
    return { name, command: bundledFile(root, "agent-shim.mjs"), targetCommand: "copilot", source: "config" };
  }
  throw new Error(`Unknown harness "${name}". Supported bundled harnesses: opencode, codex, copilot. Use AGENT_CMD for a custom harness.`);
}

/** One variable whose resolved value differs from the project declaration. */
export interface ConfigDivergence {
  setting: string;
  declaredValue: string;
  resolvedValue: string;
}

/** The secret-free projection safe for reports, logs, and JSON output. */
export interface ResolvedRuntimeReport {
  harness: HarnessResolution;
  providerBaseUrl: string;
  model: string;
  /** Variable NAME only. */
  credentialEnv: string;
  divergences: ConfigDivergence[];
}

/**
 * What a run will actually use, as opposed to what project configuration
 * declares (FR-011). `agentEnv` is private process-launch input and may contain
 * credentials; reporting code must call `toResolvedRuntimeReport()` instead.
 */
export interface ResolvedRuntimeConfig extends ResolvedRuntimeReport {
  /** Exactly the environment the agent process receives; never report or serialize it. */
  agentEnv: Record<string, string>;
}

export function toResolvedRuntimeReport(resolution: ResolvedRuntimeConfig): ResolvedRuntimeReport {
  const { agentEnv: _privateLaunchEnv, ...report } = resolution;
  return report;
}

export interface ResolveAgentLaunchOptions {
  config: GuildConfig;
  root: string;
  env?: NodeJS.ProcessEnv;
  /** The model this run will use; defaults to the project-configured model. */
  model?: string;
  /** Per-run variables the caller layers on top (run id, claim token, …). */
  extraEnv?: Record<string, string>;
}

/**
 * The single launch resolver. Both the runner and preflight read this, so
 * preflight cannot report a runtime a run would not use, and the run-start line
 * cannot drift from behaviour. A duplicate resolution path anywhere else breaks
 * FR-011 even if it produced the same answer today.
 */
export function resolveAgentLaunch(opts: ResolveAgentLaunchOptions): ResolvedRuntimeConfig {
  const env = opts.env ?? process.env;
  const config = opts.config;
  const harness = resolveHarness(config, opts.root, env);

  const declaredHarness = config.harness || "opencode";
  const declaredModel = config.model.model;
  const declaredBaseUrl = config.model.base_url ?? "";

  const model = opts.model ?? declaredModel;
  const providerBaseUrl = env.AGENT_PROVIDER_BASE_URL || declaredBaseUrl;
  const credentialEnv = config.model.api_key_env ?? "";

  const divergences: ConfigDivergence[] = [];
  if (harness.name !== declaredHarness) {
    divergences.push({ setting: "harness", declaredValue: declaredHarness, resolvedValue: harness.name });
  }
  if (model !== declaredModel) {
    divergences.push({ setting: "model.model", declaredValue: declaredModel, resolvedValue: model });
  }
  if (providerBaseUrl !== declaredBaseUrl) {
    divergences.push({ setting: "model.base_url", declaredValue: declaredBaseUrl, resolvedValue: providerBaseUrl });
  }

  const agentEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value != null) agentEnv[key] = value;
  }
  if (providerBaseUrl) agentEnv["AGENT_PROVIDER_BASE_URL"] = providerBaseUrl;
  if (credentialEnv) agentEnv["AGENT_PROVIDER_API_KEY_ENV"] = credentialEnv;
  Object.assign(agentEnv, opts.extraEnv ?? {});

  return { harness, providerBaseUrl, model, credentialEnv, agentEnv, divergences };
}

export function checkHarness(resolution: HarnessResolution): { ok: boolean; message: string } {
  if (resolution.source === "config" && !fs.existsSync(resolution.command)) {
    return { ok: false, message: `active harness: ${resolution.name} (missing adapter: ${resolution.command})` };
  }
  const command = resolution.name === "custom" ? resolution.command : resolution.targetCommand;
  const nodeShim = /\.(mjs|cjs|js)$/i.test(command);
  const result = spawnSync(nodeShim ? process.execPath : command, nodeShim ? [command, "--version"] : ["--version"], {
    encoding: "utf8",
    shell: process.platform === "win32" && !nodeShim,
  });
  if (result.error || result.status !== 0) {
    return { ok: false, message: `active harness: ${resolution.name} (${command} is missing or unreachable)` };
  }
  return { ok: true, message: `active harness: ${resolution.name} (${resolution.source === "environment" ? "AGENT_CMD override" : resolution.command})` };
}
