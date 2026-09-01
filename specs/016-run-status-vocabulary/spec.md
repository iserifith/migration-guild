# Feature Specification: Run Status Vocabulary on the Operator Dashboard

**Feature Branch**: `016-run-status-vocabulary`

**Created**: 2026-09-01

**Status**: Draft

**Input**: User description: "Expose idle/working status vocabulary on the operator dashboard (issue #220): adopt a four-state UI status enum (waiting-for-approval, rejected, working, idle) mapped onto data the registry already has. waiting-for-approval and rejected already shipped via spec-013 US4 (pending-approvals panel). working must be derived from artifact_claims.heartbeat_at recency with an explicit threshold decision. idle is the default state with no active claim."

## Clarifications

### Session 2026-09-01

- Q: What should the "working" recency threshold be — how old can a claim's heartbeat be before the dashboard stops calling it "working"? → A: 5 minutes, as a distinct constant from `guildctl doctor`'s 60-minute dangling-claim threshold.
- Q: How should the dashboard pick up a claim's heartbeat becoming stale (crossing the working threshold) — does it need a live polling/refresh mechanism, or is it computed only when the dashboard is manually reloaded? → A: The dashboard already polls for live data (per the existing "Live" indicator and periodic reload pattern in `migration/ui/src/App.tsx`/`hooks.ts`); the four-state label MUST be recomputed on each existing poll cycle, not just on manual reload. No new polling mechanism is introduced.
- Q: If an artifact somehow has both an active, recently-heartbeating claim AND a recorded `rejected` arbitration decision for its current attempt, which of "working" or "rejected" should the dashboard show? → A: "Rejected" takes precedence — a rejected decision means the current attempt's output was judged unacceptable, which is a more operator-actionable signal than "still heartbeating," and matches the general principle in FR-005 that approval/arbitration outcomes take precedence over the derived working/idle signal.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Operator sees which artifacts are actively being worked on right now (Priority: P1)

An operator watching the Mission Control dashboard during a live migration run wants to distinguish, at a glance, artifacts whose claim is actively progressing ("working") from artifacts that merely hold a lease but have gone quiet ("idle" in the sense of "not actively progressing"). Today the dashboard shows artifact status (e.g. `in-progress`) but gives no live-recency signal — an artifact stuck for an hour looks identical to one that heartbeated ten seconds ago.

**Why this priority**: This is the core gap identified in issue #220 — the dashboard has no way to show "actively being worked right now" distinct from "holding a claim." Without it, operators fall back to reading logs or waiting for `guildctl doctor`'s dangling-claim warning, which only fires after a full hour of silence.

**Independent Test**: With one artifact under an active claim whose `heartbeat_at` is recent, open the dashboard and confirm it displays a "working" indicator; let the same claim's heartbeat go stale past the configured threshold (without being reassigned) and confirm the indicator changes away from "working."

**Acceptance Scenarios**:

1. **Given** an artifact has an active claim (`artifact_claims.state = 'active'`) with `heartbeat_at` within the configured recency threshold, **When** an operator views that artifact on the dashboard, **Then** it is labeled "working."
2. **Given** an artifact has an active claim whose `heartbeat_at` has fallen outside the configured recency threshold (but the claim has not been released, reassigned, or flagged as dangling by `guildctl doctor`), **When** an operator views that artifact on the dashboard, **Then** it is no longer labeled "working."

---

### User Story 2 - Operator sees which artifacts have nothing happening on them (Priority: P1)

An operator wants a clear "idle" label for artifacts that have no active claim at all, so idle artifacts are visually distinct from both actively-worked and pending-approval/rejected artifacts, without having to infer "nothing is happening" from the absence of other signals.

**Why this priority**: Idle is the default/fallback bucket every other state is defined against; without it, "no active claim" reads as an unstyled or ambiguous state rather than a deliberate one.

**Independent Test**: With an artifact that has no row in `artifact_claims` with `state = 'active'`, open the dashboard and confirm it is labeled "idle" (and not "working," "waiting-for-approval," or "rejected").

**Acceptance Scenarios**:

1. **Given** an artifact has no active claim, **When** an operator views it on the dashboard, **Then** it is labeled "idle."
2. **Given** an artifact's active claim is released or its lease expires, **When** the dashboard next reflects that change, **Then** the artifact's label changes from "working" to "idle" (not to an error or blank state).

---

### User Story 3 - Operator sees the full four-state vocabulary presented consistently (Priority: P2)

An operator wants "waiting-for-approval" and "rejected" — already shipped via spec-013 User Story 4's pending-approvals panel — presented as part of the same four-state vocabulary as the new "working"/"idle" states, so the dashboard tells one coherent story about run state rather than mixing an old ad hoc panel with a new status concept.

**Why this priority**: Lower priority than US1/US2 because the underlying data and UI for these two states already exist and are functioning (per spec-013 T026-T029); this story is about presentation coherence, not new capability.

**Independent Test**: With one artifact held at `pending-approval` and one artifact with a recorded `rejected` arbitration decision, confirm both appear in the dashboard labeled consistently with the same four-state vocabulary used for "working"/"idle" artifacts (e.g., a shared legend, consistent badge styling, or a shared filter), without altering the existing pending-approvals panel's endpoints or approve/reject behavior.

**Acceptance Scenarios**:

1. **Given** an artifact is held at `pending-approval`, **When** an operator views the dashboard, **Then** it is identifiable using the same status vocabulary/legend as "working" and "idle" artifacts.
2. **Given** an artifact has a recorded `rejected` arbitration decision, **When** an operator views the dashboard, **Then** it is identifiable using that same shared vocabulary.

---

### Edge Cases

- What happens when an artifact has an active claim but `heartbeat_at` is NULL (e.g., a claim created before heartbeating was introduced, or a race at claim-insert time)? The dashboard must not crash or show "working" without a recency basis — treat as falling back to `claimed_at`, consistent with `guildctl doctor`'s existing fallback behavior (see FR-006 note).
- What happens when an artifact simultaneously has an active claim (recent heartbeat) and is at status `pending-approval`, or has a recorded `rejected` decision for its current attempt? Clarified in FR-005 — approval/arbitration-related states ("waiting-for-approval," "rejected") take display precedence over the derived working/idle signal.
- What happens when the dashboard's data is stale (e.g., a network fetch failed) — does "idle" get shown incorrectly for an artifact that is actually working? The dashboard's existing loading/error states (see `status.loading`/`status.error` in `migration/ui/src/App.tsx`) must be preserved; the four-state vocabulary only applies once data has successfully loaded.
- What happens right at the threshold boundary (heartbeat age exactly equal to the threshold)? Treated as no longer "working" (threshold is an inclusive upper bound on "working," per FR-003).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The dashboard MUST display, for every non-terminal artifact, exactly one of four status labels: "working," "idle," "waiting-for-approval," or "rejected."
- **FR-002**: The dashboard MUST label an artifact "idle" when it has no claim in `artifact_claims` with `state = 'active'`.
- **FR-003**: The dashboard MUST label an artifact "working" when it has an active claim (`state = 'active'`) whose most recent recency signal (`heartbeat_at`, falling back to `claimed_at` when `heartbeat_at` is absent) is within a configured "working" recency threshold of the current time.
- **FR-004**: The system MUST define an explicit, named "working" recency threshold of 5 minutes for dashboard purposes, distinct from `guildctl doctor`'s existing 60-minute dangling-claim threshold (`migration/guildctl/doctor.ts` line ~225, `60 * 60 * 1000` ms), which answers a different question ("has this claim probably been abandoned") than "is this actively being worked on right now."
- **FR-005**: When an artifact simultaneously qualifies for an approval- or arbitration-related label ("waiting-for-approval" via `pending-approval` status, or "rejected" via a recorded `rejected` arbitration decision for its current attempt) and would otherwise qualify as "working" by claim recency, the dashboard MUST display the approval/arbitration-related label — "waiting-for-approval" and "rejected" both take precedence over the derived working/idle signal, since they represent more operator-actionable outcomes than a claim still heartbeating.
- **FR-011**: The dashboard MUST recompute each artifact's four-state label on every existing live-data poll cycle (the same polling/reload mechanism already backing the dashboard's "Live" indicator), not only on manual page reload, so a claim crossing the working-recency threshold is reflected without requiring the operator to refresh.
- **FR-006**: The dashboard MUST NOT treat a NULL `heartbeat_at` on an active claim as an error; it MUST fall back to `claimed_at` for the recency calculation, consistent with the existing fallback pattern in `guildctl doctor`'s dangling-claim check.
- **FR-007**: The dashboard MUST reuse the existing spec-013 US4 pending-approvals data path (`listPendingApprovals`, the pending-approvals endpoint in `migration/registry/commands/serve.ts`, and the `ApprovalsPanel` component) to source "waiting-for-approval" status rather than re-deriving it from a new query.
- **FR-008**: The system MUST source "rejected" status from existing recorded arbitration decisions (`decision = 'rejected'`), without introducing a new rejection data path.
- **FR-009**: The dashboard MUST present all four statuses using a single, consistent visual vocabulary (e.g., a shared legend or consistent badge treatment) rather than styling the new working/idle states differently from the existing pending-approval/rejected presentation.
- **FR-010**: This feature MUST NOT require new database columns or schema migrations; all four states MUST be derived from existing columns (`artifact_claims.state`, `artifact_claims.heartbeat_at`, `artifact_claims.claimed_at`, `artifacts.status`, and existing arbitration decision records).

### Key Entities

- **Run/Artifact Status Label** (dashboard-facing, derived — not a new persisted column): one of `working`, `idle`, `waiting-for-approval`, `rejected`, computed at read time from existing `artifact_claims` and `artifacts` data plus arbitration decisions.
- **Working Recency Threshold**: a named, configurable duration used to decide whether an active claim's heartbeat is recent enough to count as "working." Distinct from (but conceptually related to) `guildctl doctor`'s existing 60-minute dangling-claim threshold.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An operator can determine, without reading logs or running a CLI command, whether any given artifact is currently being actively worked on, idle, waiting for approval, or rejected, by looking at the dashboard alone.
- **SC-002**: 100% of artifacts shown on the dashboard resolve to exactly one of the four status labels (no artifact renders with an ambiguous, blank, or conflicting status).
- **SC-003**: An artifact whose claim goes quiet (stops heartbeating) is visibly reclassified away from "working" within one existing dashboard poll cycle after crossing the 5-minute working-recency threshold, with no manual reload required.
- **SC-004**: The existing pending-approvals panel's approve/reject behavior (spec-013 US4) continues to function unchanged after this feature ships.

## Assumptions

- The "working" recency threshold is a new, dashboard-specific constant, not a reuse of `guildctl doctor`'s 60-minute dangling-claim threshold — the two answer different questions ("actively progressing right now" vs. "probably abandoned"). **Resolved** (previously flagged as needing reconciliation with issue #218's supervisor staleness sweep, `specs/015-supervisor-staleness-sweep`): no reconciliation is needed. #218's sweep interval (default 10 minutes) is how often the supervisor loop *re-checks* for staleness — it reuses the existing, unchanged `reapDeadRuns`/`reconcileStaleClaims` staleness thresholds and introduces no new threshold value of its own. This feature's 5-minute working-recency threshold is a distinct, UI-facing signal ("is this claim actively progressing right now") with no shared semantics with a check-interval. The two numbers are unrelated by construction and intentionally allowed to diverge; there is no shared constant to extract.
- "Waiting-for-approval" and "rejected" reuse the existing spec-013 US4 data paths and UI (`listPendingApprovals`, `recordApprovalDecision`, `ApprovalsPanel.tsx`) verbatim; this feature does not modify their behavior, only how they are labeled/presented alongside the two new derived states.
- This feature is scoped to the operator dashboard (the Mission Control UI in `migration/ui/src`) and its backing read APIs; it does not change CLI output (`guildctl doctor`, `printStaleSessionWarnings`) or claim/heartbeat write behavior.
- "Idle" is the default state for any artifact without an active claim, regardless of its underlying `artifacts.status` value (e.g., `pending`, `planned`, `blocked` are all "idle" for the purposes of this four-state vocabulary) — this feature does not ask operators to reconcile the four-state vocabulary with the full underlying `ArtifactStatus` enum shown elsewhere in the dashboard; both can coexist as separate signals.
- Terminal artifact statuses (`migrated`, `reviewed`, `completed`, `skipped`) are out of scope for the four-state vocabulary — FR-001 applies to non-terminal artifacts only, since a completed artifact is neither working, idle, waiting-for-approval, nor rejected in any meaningful sense.
