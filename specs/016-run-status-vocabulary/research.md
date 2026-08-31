# Phase 0 Research: Run Status Vocabulary on the Operator Dashboard

All Technical Context fields were resolved directly from grounding in the existing codebase (no NEEDS CLARIFICATION remained after `/speckit-clarify`). This document records the decisions and the evidence behind them.

## Decision: "working" recency threshold value and independence from `guildctl doctor`

- **Decision**: 5 minutes, defined as a new named constant distinct from `guildctl doctor`'s existing dangling-claim threshold.
- **Rationale**: `migration/guildctl/doctor.ts` (~line 225) already hardcodes a 60-minute (`60 * 60 * 1000` ms) threshold via `ctx.danglingClaimThresholdMs ?? 60 * 60 * 1000`, filtering `artifact_claims` rows with `state = 'active'` whose `heartbeat_at` (falling back to `claimed_at`) is older than that. That threshold answers "has this claim probably been abandoned" — a low-frequency, high-tolerance check appropriate for a periodic health sweep. This feature answers a different, higher-frequency question for a live dashboard: "is this claim actively progressing right now." Reusing the 60-minute value would make almost every claim show as "working" for nearly an hour after its last real heartbeat, defeating the purpose. Resolved via `/speckit-clarify` (recommended option accepted).
- **Alternatives considered**: (a) Reuse doctor's 60-minute threshold directly — rejected, wrong grain for a live signal. (b) Make the threshold user-configurable from day one — deferred; a single named constant is sufficient for this feature's scope and can be made configurable later without a breaking change. (c) 2/10/15-minute alternatives — 5 minutes chosen as the balance between avoiding flicker from normal heartbeat jitter and staying meaningfully "live."

## Decision: precedence when an artifact qualifies for multiple labels simultaneously

- **Decision**: `rejected` > `waiting-for-approval` > `working` > `idle` (approval/arbitration outcomes always take precedence over the derived claim-recency signal).
- **Rationale**: A `rejected` or `pending-approval` state represents an explicit, human/arbiter-recorded outcome that is more operator-actionable than "still heartbeating." In the current spec-013 model, `pending-approval` artifacts are not held under an active claim, so overlap with `working` is theoretical but should still be defined defensively. Resolved via `/speckit-clarify`.
- **Alternatives considered**: Showing multiple simultaneous badges — rejected as adding UI complexity for a case FR-001 defines as mutually exclusive by design (exactly one of four labels).

## Decision: live recompute mechanism

- **Decision**: Reuse the dashboard's existing poll-based refresh (`pollIntervalMs` parameter already implemented in `migration/ui/src/hooks.ts`'s shared data-fetching hook, the same mechanism backing the existing "Live" indicator in `App.tsx`). No new polling loop, WebSocket, or push mechanism is introduced.
- **Rationale**: The dashboard already has a working, tested polling pattern; introducing a second live-update mechanism for just this feature would violate the "reuse, don't rebuild" framing of this feature (it is presentation of already-collected data, not new instrumentation).
- **Alternatives considered**: Server-sent events / WebSocket push — rejected as disproportionate infrastructure for a UI-layer feature explicitly scoped to reuse existing data paths (FR-010).

## Decision: where the four-state derivation logic lives

- **Decision**: A new pure function in the registry command layer (`migration/registry/commands/queries.ts`, following the existing `queryPendingApprovalsForUI` pattern immediately above/below it — see `migration/registry/commands/queries.ts` lines ~1010-1014 — or a small sibling module if the SQL/derivation logic is substantial), NOT computed client-side in the UI.
- **Rationale**: Every existing dashboard-facing derived value in this codebase (pending approvals, decided-history, classification summaries) is computed registry-side and shipped as a DTO; the UI layer only renders. Computing `working`/`idle` client-side from raw claim rows would require shipping heartbeat timestamps to the browser and duplicating threshold logic in two languages/runtimes — inconsistent with existing architecture and with FR-010's "no new instrumentation" framing.
- **Alternatives considered**: Client-side derivation from existing artifact/claim list endpoints — rejected for the duplication reason above, though it was noted this is the simpler-looking option; registry-side derivation was preferred for consistency with existing precedent.

## Note: doctor.ts vs. monitoring.ts (grounding correction relative to issue #220's original framing)

Issue #220 pointed at `migration/guildctl/monitoring.ts:379`'s `printStaleSessionWarnings` as reading `heartbeat_at`. Verified against the actual source: `printStaleSessionWarnings` reads `claimed_at` off the `artifacts` table directly, not `heartbeat_at` off `artifact_claims`. The function that actually reads `artifact_claims.heartbeat_at` with a threshold is `guildctl doctor`'s dangling-claim check (`migration/guildctl/doctor.ts`, ~line 225). This plan and its threshold reconciliation note (see spec.md Assumptions) are grounded in `doctor.ts`, not `monitoring.ts`.
