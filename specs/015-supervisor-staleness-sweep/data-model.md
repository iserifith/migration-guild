# Phase 1 Data Model: Always-On Supervisor Staleness Sweep

This feature introduces no new registry tables or persisted entities — it re-invokes existing reap/reconcile logic against the existing `runs` and `artifact_claims`/`artifacts` registry tables. The only new "entities" are in-memory, process-lifetime concepts scoped to a single `runAutoQueue` invocation.

## SweepClock (in-memory, per `runAutoQueue` call)

Tracks when the last staleness sweep ran so the loop knows when the next one is due.

| Field | Type | Notes |
|---|---|---|
| `intervalMs` | number | Resolved once at the start of `runAutoQueue` from the sweep-interval environment variable, falling back to the 10-minute default when unset, non-numeric, or non-positive. |
| `lastSweepAt` | number (epoch ms) | Initialized to the time of the startup sweep (the existing `reapDeadRuns`/`reconcileStaleClaims` call already at the top of `runAutoQueue`). Updated every time a periodic sweep runs, whether or not it finds anything. |
| `now` | () => number | Injectable clock function, defaults to `Date.now`; exists purely for deterministic tests (see research.md). |

Lifecycle: created once per `runAutoQueue` call, discarded when the call returns. Not persisted.

## SweepEvent (in-memory / log line, not persisted as a distinct table)

Represents one periodic sweep's outcome, used to drive operator-facing output (FR-005/FR-006) and to accumulate into the existing result.

| Field | Type | Notes |
|---|---|---|
| `triggeredAt` | number (epoch ms) | When this sweep ran. |
| `reapedRunIds` | string[] | Run IDs reaped by `reapDeadRuns` during this sweep (empty if none). |
| `reconciledArtifactIds` | string[] | Artifact IDs released by `reconcileStaleClaims` during this sweep (empty if none). |
| `error` | string \| undefined | Set when the sweep itself threw; the loop continues regardless (FR-007). |

A `SweepEvent` with `reapedRunIds.length === 0 && reconciledArtifactIds.length === 0 && !error` is a "clean" sweep and MUST NOT produce operator-facing output (FR-006).

## Extended: `AutoQueueResult` (existing type in `migration/guildctl/supervisor/queue.ts`)

No new top-level field. Existing field's semantics are extended:

| Field | Type | Change |
|---|---|---|
| `recoveredArtifacts` | string[] | Existing field, populated today only by the startup sweep. Extended to also include artifact IDs reconciled by any periodic sweep that ran during the same `runAutoQueue` call, deduplicated (an artifact ID should not appear twice even if, hypothetically, both a startup and periodic sweep touched related state). |

No other fields on `AutoQueueResult`, `AutoQueueOptions`, or `AutoRunCliOptions` change shape. `AutoQueueOptions` gains one new optional field to support the injectable clock and interval override for tests:

| Field | Type | Notes |
|---|---|---|
| `sweepIntervalMs` (optional, on `AutoQueueOptions`) | number | Test/advanced-override hook; when omitted, resolved from the environment variable / default as described above. Not exposed as a CLI flag (per clarification). |
| `now` (optional, on `AutoQueueOptions`) | () => number | Injectable clock; defaults to `Date.now`. |

## Existing entities reused, unchanged

- **Run** (`migration/registry/commands/runs.ts` / registry `runs` table) — reaped by `reapDeadRuns`; no schema change.
- **Claim** (`migration/registry/commands/claim.ts` / registry `artifact_claims` table) — reconciled by `reconcileStaleClaims`; no schema change.
- **Artifact** (registry `artifacts` table) — status transitions caused by reconciliation are the existing ones `reconcileStaleClaims` already performs; no new transitions introduced.
