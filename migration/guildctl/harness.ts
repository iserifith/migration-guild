import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { resolveProviderRoute, type GuildConfig } from "./config";

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

/**
 * Where a resolved value came from. `ambient` is the inherited environment,
 * `project-file` a value a candidate `.env` supplied, `config` the project
 * configuration itself (a per-phase model or a provider route selection).
 */
export type ConfigDivergenceSource = "ambient" | "project-file" | "config";

/** Which source supplied each environment variable, keyed by variable name. */
export type EnvOriginMap = Record<string, "ambient" | "project-file">;

/** One variable whose resolved value differs from the project declaration. */
export interface ConfigDivergence {
  setting: string;
  declaredValue: string;
  resolvedValue: string;
  source: ConfigDivergenceSource;
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

/**
 * The model an attempt on `route` uses. Selection delegates to
 * `resolveProviderRoute()` so the routes an operator configures are the only
 * place a model list lives; `attempt` walks that route and clamps at its last
 * entry, so a long retry chain keeps using the final fallback instead of
 * falling off the end.
 */
export function selectRouteModel(config: GuildConfig, route: string, attempt = 0): string {
  const models = resolveProviderRoute(config, route);
  if (models.length === 0) return config.model.model;
  return models[Math.min(Math.max(attempt, 0), models.length - 1)];
}

export interface ResolveAgentLaunchOptions {
  config: GuildConfig;
  root: string;
  env?: NodeJS.ProcessEnv;
  /** The model this run will use; wins over route selection when given. */
  model?: string;
  /** Provider route this launch belongs to — `default` for producing work, `review` for arbitration. */
  route?: string;
  /** Zero-based attempt index within `route`; clamps at the route's last model. */
  attempt?: number;
  /** Per-run variables the caller layers on top (run id, claim token, …). */
  extraEnv?: Record<string, string>;
  /**
   * Which source supplied each environment variable, as computed by the
   * environment loader in `env.ts`. Supplied explicitly rather than inferred:
   * this resolver reads values, it does not read `.env` files, so it cannot
   * know an origin nobody told it. A variable absent from the map is treated
   * as ambient, which is what it is when no project file defined it.
   */
  envOrigin?: EnvOriginMap;
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

  const model = opts.model ?? (opts.route ? selectRouteModel(config, opts.route, opts.attempt) : declaredModel);
  const providerBaseUrl = env.AGENT_PROVIDER_BASE_URL || declaredBaseUrl;
  const credentialEnv = config.model.api_key_env ?? "";

  // The variable that produced the value is what decides the reported source,
  // so an operator reading a divergence learns which file or shell to edit.
  const envOrigin = opts.envOrigin ?? {};
  const originOf = (variable: string): ConfigDivergenceSource => envOrigin[variable] ?? "ambient";

  const divergences: ConfigDivergence[] = [];
  if (harness.name !== declaredHarness) {
    divergences.push({ setting: "harness", declaredValue: declaredHarness, resolvedValue: harness.name, source: originOf("AGENT_CMD") });
  }
  if (model !== declaredModel) {
    // A per-phase model or a provider route selection is project configuration
    // reading itself, never an environment variable.
    divergences.push({ setting: "model.model", declaredValue: declaredModel, resolvedValue: model, source: "config" });
  }
  if (providerBaseUrl !== declaredBaseUrl) {
    divergences.push({ setting: "model.base_url", declaredValue: declaredBaseUrl, resolvedValue: providerBaseUrl, source: originOf("AGENT_PROVIDER_BASE_URL") });
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
