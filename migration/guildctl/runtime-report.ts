import type { GuildConfig } from "./config";
import {
  envDivergences as recordedDivergences,
  envOriginMap,
  lastEnvLoad,
  type EnvDivergence,
  type EnvLoadResult,
} from "./env";
import {
  resolveAgentLaunch,
  toResolvedRuntimeReport,
  type ResolvedRuntimeConfig,
  type ResolvedRuntimeReport,
} from "./harness";

/**
 * The run-start line and the divergence block (FR-024, FR-025), per
 * `specs/001-truthful-run-state/contracts/guildctl-cli.md` §G.
 *
 * One helper renders both, and it takes the **secret-free** projection
 * (`toResolvedRuntimeReport()`) plus the environment loader's `EnvDivergence[]`
 * as two separate inputs. It never sees `agentEnv`, so no reporting path can
 * serialize the launch environment or a credential value even by accident, and
 * a configuration divergence can never be mistaken for an environment one.
 *
 * At a manual phase entry, `resolveAndReportRuntime()` resolves once, renders
 * that resolution, and returns it so the phase can hand the *same*
 * `ResolvedRuntimeConfig` to `spawnAgent`. That is what keeps the line and the
 * launch from describing different runtimes.
 */

export const RUNTIME_LINE_PREFIX = "[guildctl]";

/** Continuation indent, aligning under the text after the prefix. */
const CONTINUATION = " ".repeat(RUNTIME_LINE_PREFIX.length + 1);

function orUnset(value: string): string {
  return value || "(unset)";
}

function renderConfigDivergences(resolved: ResolvedRuntimeReport): string[] {
  return resolved.divergences.map((divergence) =>
    `${CONTINUATION}config divergence: ${divergence.setting} declared ${orUnset(divergence.declaredValue)}, `
    + `resolved ${orUnset(divergence.resolvedValue)} (source: ${divergence.source})`);
}

function renderEnvDivergences(divergences: EnvDivergence[]): string[] {
  if (divergences.length === 0) return [];
  const projectCells = divergences.map((d) => `.env=${d.projectValue}`);
  const ambientCells = divergences.map((d) => `ambient=${d.ambientValue}`);
  const nameWidth = Math.max(...divergences.map((d) => d.variable.length));
  const projectWidth = Math.max(...projectCells.map((cell) => cell.length));
  const ambientWidth = Math.max(...ambientCells.map((cell) => cell.length));

  return [
    `${RUNTIME_LINE_PREFIX} environment: ${divergences.length} divergence(s) between .env and the inherited environment`,
    ...divergences.map((divergence, index) =>
      `  ${divergence.variable.padEnd(nameWidth)}  ${projectCells[index].padEnd(projectWidth)}  `
      + `${ambientCells[index].padEnd(ambientWidth)}  → ${divergence.winner === "ambient" ? "ambient" : ".env"} wins`),
  ];
}

/**
 * The run-start block: one unconditional runtime line, the configuration
 * divergences that line is about, then the bounded environment block when the
 * workspace `.env` and the inherited environment disagree.
 */
export function renderRuntimeReport(
  resolved: ResolvedRuntimeReport,
  envDivergences: EnvDivergence[] = [],
): string {
  const lines = [
    `${RUNTIME_LINE_PREFIX} runtime: harness=${resolved.harness.name} `
    + `provider=${orUnset(resolved.providerBaseUrl)} model=${orUnset(resolved.model)}`,
    ...renderConfigDivergences(resolved),
    ...renderEnvDivergences(envDivergences),
  ];
  return `${lines.join("\n")}\n`;
}

export interface EmitRuntimeReportOptions {
  envDivergences?: EnvDivergence[];
  write?: (text: string) => void;
}

/** Emit the block exactly once, for callers that already hold a resolution. */
export function emitRuntimeReport(
  resolved: ResolvedRuntimeReport,
  options: EmitRuntimeReportOptions = {},
): void {
  const write = options.write ?? ((text: string) => { process.stdout.write(text); });
  write(renderRuntimeReport(resolved, options.envDivergences ?? recordedDivergences()));
}

export interface PhaseRuntimeOptions {
  config: GuildConfig;
  root: string;
  /** The model this phase will use; reported as the resolved model. */
  model?: string;
  route?: string;
  attempt?: number;
  env?: NodeJS.ProcessEnv;
  /** Load result to report from. Defaults to this process's recorded load. */
  envLoad?: EnvLoadResult;
  write?: (text: string) => void;
}

/**
 * Resolve the launch once at phase entry, report it, and return it. The caller
 * passes the returned object into `SpawnAgentOpts.resolution`; `spawnAgent`
 * then merges only run-scoped variables onto it and never resolves again.
 */
export function resolveAndReportRuntime(options: PhaseRuntimeOptions): ResolvedRuntimeConfig {
  const load = options.envLoad ?? lastEnvLoad();
  const resolution = resolveAgentLaunch({
    config: options.config,
    root: options.root,
    env: options.env,
    model: options.model,
    route: options.route,
    attempt: options.attempt,
    envOrigin: load?.origin ?? envOriginMap(),
  });
  emitRuntimeReport(toResolvedRuntimeReport(resolution), {
    envDivergences: load?.divergences ?? recordedDivergences(),
    write: options.write,
  });
  return resolution;
}
