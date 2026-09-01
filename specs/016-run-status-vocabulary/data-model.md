# Phase 1 Data Model: Run Status Vocabulary on the Operator Dashboard

No schema changes. This feature reads three existing tables and derives one new response-shape field. Nothing below is a new persisted column.

## Existing tables read (unchanged)

### `artifact_claims` (unchanged; see `migration/registry/types.ts` `ArtifactClaim`)

Relevant existing columns used by this feature:

- `artifact_id` — join key to `artifacts`
- `state` — a claim is only eligible for "working" when `state = 'active'`
- `heartbeat_at` — primary recency signal
- `claimed_at` — fallback recency signal when `heartbeat_at` is NULL (mirrors `guildctl doctor`'s existing fallback pattern)

### `artifacts` (unchanged)

- `id`, `status` — used to detect `pending-approval` (already surfaced via `listPendingApprovals`) and to exclude terminal statuses (`migrated`, `reviewed`, `completed`, `skipped`) from the four-state vocabulary per spec.md Assumptions

### `arbitration_decisions` (unchanged; see `migration/registry/commands/evidence.ts` writer, `migration/registry/commands/approval.ts` reader precedent)

- `artifact_id`, `decision` — the most recent row per artifact with `decision = 'rejected'` (for the artifact's current attempt) sources the "rejected" label

## New derived entity (not persisted): `RunStatusLabel`

A read-time computed value, one per non-terminal artifact, returned by the new registry read function and consumed by the UI. Conceptually:

| Field | Type | Description |
|---|---|---|
| `artifact_id` | string | Foreign key to `artifacts.id` |
| `label` | `"working" \| "idle" \| "waiting-for-approval" \| "rejected"` | The single resolved status per FR-001/FR-005 precedence rules |
| `heartbeat_age_ms` | number \| null | Milliseconds since the recency signal (`heartbeat_at` or `claimed_at` fallback) was last updated, for a "working" or "idle" label; null when the label is `waiting-for-approval`/`rejected` and no active claim exists |

## Derivation rules (precedence order, per spec.md FR-005 / research.md)

1. If the artifact has a recorded `arbitration_decisions` row with `decision = 'rejected'` for its current attempt → `rejected`.
2. Else if the artifact's status is `pending-approval` (i.e., it appears in `listPendingApprovals`'s result) → `waiting-for-approval`.
3. Else if the artifact has an active claim (`artifact_claims.state = 'active'`) whose recency signal is within the 5-minute working threshold → `working`.
4. Else → `idle` (covers both "no active claim" and "active claim whose recency signal exceeds the threshold").

## New named constant

- `WORKING_RECENCY_THRESHOLD_MS` (or equivalent name chosen at implementation time) = `5 * 60 * 1000`, defined once in the registry command layer near the new derivation function, analogous to `doctor.ts`'s `ctx.danglingClaimThresholdMs ?? 60 * 60 * 1000` pattern but intentionally a separate constant (see research.md and spec.md Assumptions on future reconciliation with issue #218).

## State transitions

Not a stateful entity — `RunStatusLabel` is recomputed from scratch on every read (registry query on every poll cycle, per FR-011). No transition table is needed; the derivation rules above are pure functions of current data.
