import { DEFAULT_GUILD_CONFIG, type GuildConfig } from "./config";

/**
 * Effective Limit (data-model.md §8, research R13): per phase and limit kind,
 * the limit that will actually be enforced. Termination messages and the
 * `guildctl limits` command both read `knob`, `effectiveValueMs`, and `source`
 * from the same descriptor this resolver returns, so it is structurally
 * impossible for a message to name a knob that does not govern (FR-028).
 */
export type LimitKind = "ceiling" | "inactivity";

export type LimitSource =
  | "per-phase-setting"
  | "env-override"
  | "project-configuration"
  | "built-in-default";

export interface EffectiveLimit {
  phase: string;
  kind: LimitKind;
  /** The setting an operator changes to move `effectiveValueMs`. */
  knob: string;
  /** What is actually enforced. */
  effectiveValueMs: number;
  /** What was asked for, before any floor. */
  requestedValueMs: number;
  source: LimitSource;
  /** True when the phase's enforced minimum raised the requested value. */
  floorApplied: boolean;
  /** Same order for every phase, for display. */
  precedenceOrder: LimitSource[];
}

export const LIMIT_PRECEDENCE_ORDER: LimitSource[] = [
  "per-phase-setting",
  "env-override",
  "project-configuration",
  "built-in-default",
];

interface PhaseCeilingSpec {
  /** The per-phase environment variable, tier 1. */
  knob: string;
  /** Built-in default (minutes) when nothing else governs. */
  defaultMinutes: number;
  /** Enforced minimum (minutes): 5 for analyze/test/code-writing/remediation, 1 for review/inventory. */
  floorMinutes: number;
}

// Tier-1 knob/default/floor definitions, sourced from migrate.ts:24-26,
// remediate.ts:11, review.ts:11, and inventory.ts:255-257. This is the single
// copy; those call sites are repointed at resolveEffectiveLimit() (T047).
const CEILING_SPECS: Record<string, PhaseCeilingSpec> = {
  inventory: { knob: "GUILDCTL_INVENTORY_TIMEOUT_MINUTES", defaultMinutes: 30, floorMinutes: 1 },
  analysis: { knob: "GUILDCTL_ANALYZE_TIMEOUT_MINS", defaultMinutes: 10, floorMinutes: 5 },
  "test-writing": { knob: "GUILDCTL_TEST_TIMEOUT_MINS", defaultMinutes: 15, floorMinutes: 5 },
  "code-writing": { knob: "GUILDCTL_CODE_TIMEOUT_MINS", defaultMinutes: 20, floorMinutes: 5 },
  review: { knob: "GUILDCTL_REVIEW_TIMEOUT_MINS", defaultMinutes: 10, floorMinutes: 1 },
  remediation: { knob: "GUILDCTL_REMEDIATION_TIMEOUT_MINS", defaultMinutes: 15, floorMinutes: 5 },
};

export const KNOWN_LIMIT_PHASES = Object.keys(CEILING_SPECS);

const CEILING_ENV_OVERRIDE = "GUILDCTL_AGENT_CEILING_SECONDS";
const INACTIVITY_ENV_OVERRIDE = "GUILDCTL_INACTIVITY_TIMEOUT_SECONDS";
const CEILING_CONFIG_KNOB = "agent_limits.ceiling_seconds";
const INACTIVITY_CONFIG_KNOB = "agent_limits.inactivity_timeout_seconds";

function parseMinutes(raw: string, fallbackMinutes: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallbackMinutes;
}

function parseSeconds(raw: string, fallbackSeconds: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallbackSeconds;
}

function applyFloor(effectiveMs: number, floorMinutes: number | undefined): { value: number; applied: boolean } {
  if (!floorMinutes) return { value: effectiveMs, applied: false };
  const floorMs = floorMinutes * 60_000;
  if (effectiveMs < floorMs) return { value: floorMs, applied: true };
  return { value: effectiveMs, applied: false };
}

/**
 * True when the project's `.guild/config.yaml` explicitly declared this
 * `agent_limits` value, as opposed to it merely being the deep-merged
 * built-in default. A merged value can only differ from
 * `DEFAULT_GUILD_CONFIG`'s own value when a file declared it, so comparing
 * against the shipped default is a reliable, I/O-free proxy.
 */
function isExplicitAgentLimit(config: GuildConfig, key: "ceiling_seconds" | "inactivity_timeout_seconds"): boolean {
  return config.agent_limits?.[key] !== DEFAULT_GUILD_CONFIG.agent_limits[key];
}

export function resolveEffectiveLimit(
  phase: string,
  kind: LimitKind,
  config: GuildConfig = DEFAULT_GUILD_CONFIG,
  env: Record<string, string | undefined> = process.env,
): EffectiveLimit {
  const spec = CEILING_SPECS[phase];
  const precedenceOrder = LIMIT_PRECEDENCE_ORDER;

  if (kind === "ceiling") {
    const floorMinutes = spec?.floorMinutes;
    const builtInDefaultMinutes = spec?.defaultMinutes ?? Math.round(DEFAULT_GUILD_CONFIG.agent_limits.ceiling_seconds / 60);

    // Tier 1: per-phase setting, occupied only when explicitly set.
    if (spec) {
      const raw = env[spec.knob];
      if (raw != null && raw !== "") {
        const requestedMinutes = parseMinutes(raw, spec.defaultMinutes);
        const requestedValueMs = requestedMinutes * 60_000;
        const { value: effectiveValueMs, applied: floorApplied } = applyFloor(requestedValueMs, floorMinutes);
        return { phase, kind, knob: spec.knob, effectiveValueMs, requestedValueMs, source: "per-phase-setting", floorApplied, precedenceOrder };
      }
    }

    // Tier 2: global environment override.
    const envOverride = env[CEILING_ENV_OVERRIDE];
    if (envOverride != null && envOverride !== "") {
      const requestedSeconds = parseSeconds(envOverride, config.agent_limits.ceiling_seconds);
      const requestedValueMs = requestedSeconds * 1000;
      const { value: effectiveValueMs, applied: floorApplied } = applyFloor(requestedValueMs, floorMinutes);
      return { phase, kind, knob: CEILING_ENV_OVERRIDE, effectiveValueMs, requestedValueMs, source: "env-override", floorApplied, precedenceOrder };
    }

    // Tier 3: project configuration, only when explicitly declared.
    if (isExplicitAgentLimit(config, "ceiling_seconds")) {
      const requestedValueMs = config.agent_limits.ceiling_seconds * 1000;
      const { value: effectiveValueMs, applied: floorApplied } = applyFloor(requestedValueMs, floorMinutes);
      return { phase, kind, knob: CEILING_CONFIG_KNOB, effectiveValueMs, requestedValueMs, source: "project-configuration", floorApplied, precedenceOrder };
    }

    // Tier 4: built-in default — the phase's own literal when known, else the
    // shipped agent_limits.ceiling_seconds default.
    const requestedValueMs = builtInDefaultMinutes * 60_000;
    const { value: effectiveValueMs, applied: floorApplied } = applyFloor(requestedValueMs, floorMinutes);
    return { phase, kind, knob: CEILING_CONFIG_KNOB, effectiveValueMs, requestedValueMs, source: "built-in-default", floorApplied, precedenceOrder };
  }

  // Inactivity: no per-phase tier or floor today (research R13); resolution
  // starts at the environment override.
  const envOverride = env[INACTIVITY_ENV_OVERRIDE];
  if (envOverride != null && envOverride !== "") {
    const requestedSeconds = parseSeconds(envOverride, config.agent_limits.inactivity_timeout_seconds);
    const effectiveValueMs = requestedSeconds * 1000;
    return { phase, kind, knob: INACTIVITY_ENV_OVERRIDE, effectiveValueMs, requestedValueMs: effectiveValueMs, source: "env-override", floorApplied: false, precedenceOrder };
  }
  if (isExplicitAgentLimit(config, "inactivity_timeout_seconds")) {
    const effectiveValueMs = config.agent_limits.inactivity_timeout_seconds * 1000;
    return { phase, kind, knob: INACTIVITY_CONFIG_KNOB, effectiveValueMs, requestedValueMs: effectiveValueMs, source: "project-configuration", floorApplied: false, precedenceOrder };
  }
  const effectiveValueMs = DEFAULT_GUILD_CONFIG.agent_limits.inactivity_timeout_seconds * 1000;
  return { phase, kind, knob: INACTIVITY_CONFIG_KNOB, effectiveValueMs, requestedValueMs: effectiveValueMs, source: "built-in-default", floorApplied: false, precedenceOrder };
}

/** Human-readable duration for CLI/message output, e.g. "20m", "120s". */
export function formatLimitDuration(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1000)}s`;
}

/** The termination message quoting the same descriptor enforcement used (FR-028). */
export function formatLimitTerminationNote(limit: EffectiveLimit): string {
  const sourceLabel = limit.source.replace(/-/g, " ");
  return `knob: ${limit.knob} = ${formatLimitDuration(limit.effectiveValueMs)} (source: ${sourceLabel})`;
}

/** Autonomous worker phase → limit-phase mapping (T043/T045): migrate → code-writing, repair → remediation. */
export function limitPhaseForAutoWorker(workerPhase: "migrate" | "repair"): string {
  return workerPhase === "repair" ? "remediation" : "code-writing";
}

/**
 * Distinguishes a descriptor-derived limit termination from every other
 * independent-review failure (a malformed marker, an identity-assertion
 * failure, a plain invocation error). Only this class routes an autonomous
 * review rejection through the non-throwing review-error close-out path in
 * `supervisor/loop.ts`; every other review failure still fails closed by
 * propagating out of `runAuto` (T047, T048).
 *
 * Carries the process-cleanup outcome (T058) so the worker-error/review-error
 * close-out can persist `cleanup_outcome`/`survivor_pids` from the same
 * termination the descriptor enforced, instead of reporting "not-applicable"
 * for a limit that actually fired.
 */
export class AutonomousLimitError extends Error {
  constructor(
    message: string,
    public readonly cleanupOutcome: "clean" | "survivors" | "not-applicable" = "not-applicable",
    public readonly survivorPids: number[] = [],
  ) {
    super(message);
  }
}
