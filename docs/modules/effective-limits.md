# Effective Limits & Termination Process Deep-Dive

The guildctl Limits subsystem (`migration/guildctl/limits.ts`) ensures that autonomous LLM agents—which are inherently unpredictable and prone to getting stuck or running away—are strictly bound by enforceable limits (time limits, inactivity timeouts, etc.).

This document details how the limits are resolved, the tier-based precedence, how floors apply, and how limit breaches are propagated back up through the process hierarchy.

## Overview & The `EffectiveLimit` Descriptor

Unlike early iterations where timeouts were passed around as loose milliseconds strings scattered across different CLI parameters and scripts, the Guildctl runtime relies on the `EffectiveLimit` descriptor.

An `EffectiveLimit` binds the *effective enforced value* with the *exact source* that provided it. The definition is found in `migration/guildctl/limits.ts`:

```typescript
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
```

By ensuring that termination logs read from this single source of truth, it is structurally impossible for a limit error message to name an environment variable or config property that did not actually govern the run (FR-028).

## 1. Limit Kinds: Ceiling and Inactivity

The runtime enforces two types of limits (`LimitKind`):
- **`ceiling`**: The absolute wall-clock timeout. If an agent is still running when this limit is reached, it is terminated regardless of its activity. (e.g., 20 minutes for code-writing).
- **`inactivity`**: The liveliness timeout. If the agent's observable output (stdout/stderr) goes completely silent for this duration, it is assumed hung and is terminated well before the wall-clock ceiling.

## 2. The 4-Tier Resolution Hierarchy

Limits are computed in `resolveEffectiveLimit()` using a strict 4-tier precedence:

1. **`per-phase-setting`**: Tier 1. Set via specific phase environment variables (e.g., `GUILDCTL_CODE_TIMEOUT_MINS`). This is the most granular level.
2. **`env-override`**: Tier 2. Set via global environment variables that apply to all phases (e.g., `GUILDCTL_AGENT_CEILING_SECONDS` and `GUILDCTL_INACTIVITY_TIMEOUT_SECONDS`).
3. **`project-configuration`**: Tier 3. Loaded from the `.guild/config.yaml` explicitly (`agent_limits.ceiling_seconds`).
4. **`built-in-default`**: Tier 4. The absolute fallback hardcoded into the runtime.

`resolveEffectiveLimit` stops at the first tier that has an explicitly configured value and computes the resulting milliseconds.

## 3. The "Floor" Logic

To prevent operators from misconfiguring limits to impossibly low bounds (e.g., setting a 1-second timeout for a complex task, causing an immediate failure loop), `ceiling` limits specify a `floorMinutes`.

In `limits.ts`:
```typescript
const CEILING_SPECS: Record<string, PhaseCeilingSpec> = {
  inventory: { knob: "GUILDCTL_INVENTORY_TIMEOUT_MINUTES", defaultMinutes: 30, floorMinutes: 1 },
  analysis: { knob: "GUILDCTL_ANALYZE_TIMEOUT_MINS", defaultMinutes: 10, floorMinutes: 5 },
  // ...
};
```
If a tier sets a limit below this floor, `applyFloor()` will raise the enforced duration (`effectiveValueMs`) to match the `floorMs`, and mark the descriptor's `floorApplied` boolean as `true`.

Note: Currently, `inactivity` limits do not have floors or phase-specific tier 1 overrides (they start at Tier 2).

## 4. `runner.ts` Enforcement & The Process-Tree Termination Path

In `migration/guildctl/runner.ts` (specifically inside `spawnAgent()`), the process tree uses `resolveEffectiveLimit()` for both the ceiling and inactivity bounds.

When a limit fires, the `killAgent()` function is invoked:
1. The limit flag (`inactivityKilled` or `ceilingKilled`) is set.
2. The exact `EffectiveLimit` descriptor that fired is captured.
3. The group is signaled using `terminateProcessGroup(proc.pid, { graceMs })`. This kills not just the direct spawned node shim, but any background child processes (such as disconnected Python daemon or Java Gradle daemons) the agent may have started, preventing zombie leaks.

```typescript
const killAgent = (flag: "inactivity" | "ceiling"): void => {
  if (settled) return;
  const limit = flag === "inactivity" ? inactivityLimit : ceilingLimit;
  if (flag === "inactivity") inactivityKilled = true;
  else ceilingKilled = true;
  firingLimit = limit;
  // ...
  // R8/FR-035–FR-038: terminate the whole process group this attempt
  // started (graceful → forced → confirm), not only the direct child.
  terminationPromise = terminateProcessGroup(proc.pid, { graceMs: terminationGraceMs });
};
```

## 5. `AutonomousLimitError` Exception

While normal independent review failures (e.g., malformed markers, verification logic failures) propagate via raw exceptions, limit breaches during the independent review phase use a specialized `AutonomousLimitError`:

```typescript
export class AutonomousLimitError extends Error {
  constructor(
    message: string,
    public readonly cleanupOutcome: "clean" | "survivors" | "not-applicable" = "not-applicable",
    public readonly survivorPids: number[] = [],
  ) {
    super(message);
  }
}
```
In `migration/guildctl/supervisor/loop.ts`, the `guardedIndependentReview` captures this distinct error type. If a normal exception is thrown, the whole autonomous loop halts to preserve state and requires operator attention. However, if an `AutonomousLimitError` is caught, the supervisor safely routes it through the non-throwing review-error close-out path (`closeOutReviewError()`). This ensures the specific artifact fails cleanly and preserves the process cleanup outcome (survivor pids, cleanup state) while allowing the rest of the autonomous queue to keep running.

## 6. Phase Mapping (T045/T047)

Because commands sometimes categorize runs under umbrella terms (e.g., `repair` or `migrate`), they must repoint to the correct underlying limit specs to read the specific limits. The `limitPhaseForAutoWorker` helper performs this translation, ensuring, for example, that the `repair` worker maps to the `remediation` limit tier rather than `code-writing`.

```typescript
/** Autonomous worker phase → limit-phase mapping (T043/T045): migrate → code-writing, repair → remediation. */
export function limitPhaseForAutoWorker(workerPhase: "migrate" | "repair"): string {
  return workerPhase === "repair" ? "remediation" : "code-writing";
}
```
