# Contract: Periodic Sweep in `runAutoQueue`

This is not a network/HTTP contract — `migration/guildctl` is a CLI/registry tool. The "interface" this feature exposes is (a) the `runAutoQueue` TypeScript function signature and result shape, consumed by `migration/guildctl/commands/auto-run.ts` and by tests, and (b) one environment variable, consumed by operators. Both are documented here as the stable contract points other code and other people depend on.

## 1. `runAutoQueue` options (TypeScript)

File: `migration/guildctl/supervisor/queue.ts`

```ts
export interface AutoQueueOptions {
  executeArtifact: QueueArtifactExecutor;
  wave?: number;
  limit?: number;
  resume?: boolean;
  workspaceRoot?: string;
  /** NEW — overrides the resolved sweep interval; primarily for tests. */
  sweepIntervalMs?: number;
  /** NEW — injectable clock; defaults to Date.now. Primarily for tests. */
  now?: () => number;
}
```

**Backward compatibility**: Both new fields are optional. Existing callers (`migration/guildctl/commands/auto-run.ts`, and any test constructing `AutoQueueOptions`) compile and behave unchanged if they omit both fields — the sweep interval resolves from the environment variable/default, and the clock resolves to `Date.now`.

## 2. `runAutoQueue` result (TypeScript)

File: `migration/guildctl/supervisor/queue.ts`

```ts
export interface AutoQueueResult {
  status: "complete" | "partial" | "stalled" | "limited" | "cancelled" | "failed";
  completed: number;
  blocked: number;
  processed: Array<{ artifactId: string; resume: boolean; status: string; runId?: string; attempts?: number }>;
  recoveredArtifacts: string[]; // UNCHANGED shape — now also includes periodic-sweep recoveries, deduplicated
  dependencyBlocked: string[];
  remaining: AutoQueueRemaining;
  error?: string;
}
```

**Contract guarantee**: `recoveredArtifacts` shape is unchanged (still `string[]`); its contents are a superset of what today's startup-only sweep would have produced. No consumer needs to change to keep working; a consumer that wants periodic-sweep-specific detail must read the new console output (see §4), since no new structured field is added (per research.md's decision to avoid schema churn).

## 3. Environment variable

| Name | Default | Parsing | Consumed by |
|---|---|---|---|
| `GUILDCTL_SWEEP_INTERVAL_MINS` | `10` | `parseInt(value, 10)`; any non-finite or non-positive result falls back to the default | `migration/guildctl/supervisor/queue.ts` (`runAutoQueue`), resolved once per invocation unless overridden by `AutoQueueOptions.sweepIntervalMs` |

**Contract guarantee**: Unset, empty, or invalid values behave identically to today (default 10-minute interval) — no operator relying on current behavior is affected by upgrading. This follows the exact resolution pattern already used for `GUILDCTL_STALL_MINS` in `migration/guildctl/monitoring.ts`.

## 4. Operator-facing output contract

- On a periodic sweep that reaps or reconciles at least one item: one line of console output is written at the moment the sweep runs (not deferred to the final summary), clearly labeled as a periodic/mid-session sweep (as opposed to the existing startup-sweep reporting, if any exists in the caller today) and naming what was recovered.
- On a periodic sweep that finds nothing: no output (FR-006).
- On a periodic sweep that errors: one line of non-fatal warning output, and the loop continues (FR-007) — this line must be distinguishable from a fatal `auto-run` error so operators don't mistake it for the whole session failing.

## 5. Explicitly not part of this contract

- `guildctl auto` (single-artifact path, `migration/guildctl/commands/auto.ts`) — unchanged, no periodic sweep (User Story 3 / FR-001 scope boundary).
- `guildctl doctor`, `guildctl repair`, `guildctl release` — unchanged; remain available as manual tools.
- `printStaleSessionWarnings` / `runPipelineStateChecks` — not called by the periodic sweep (research.md decision).
