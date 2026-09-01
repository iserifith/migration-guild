# Feature Specification: Always-On Supervisor Staleness Sweep

**Feature Branch**: `015-supervisor-staleness-sweep`

**Created**: 2026-09-01

**Status**: Draft

**Input**: User description: "Add a periodic check inside the supervisor loop that re-runs staleness detection (reap dead runs / reconcile stale claims) on a fixed interval during long-running `guildctl auto`/`auto-run` sessions, not just once at startup, so a claim or run that goes stale mid-session is surfaced and self-healed without an operator manually running `guildctl doctor` or `guildctl repair`. See issue #218."

## Clarifications

### Session 2026-09-01

- Q: What should the default periodic sweep interval be? → A: 10 minutes, matching the existing `GUILDCTL_STALL_MINS` default already used for stale-session warnings elsewhere in guildctl, so the codebase has one consistent "stale after ~10 min" mental model, comfortably below typical multi-hour `auto-run` sessions.
- Q: Is `guildctl auto` (a single bounded artifact invocation) in scope for periodic sweeps, or only `auto-run`'s sequential queue loop? → A: Scope is limited to `auto-run`'s queue loop (`runAutoQueue`) for this feature. Standalone `guildctl auto` returns after one bounded migrate/verify/repair cycle and has no persistent loop to attach a timer to without separate, larger surgery; it keeps only its existing startup-equivalent behavior. This is documented as an explicit out-of-scope limitation, not a silent gap.
- Q: Should the periodic sweep reuse only the same reap/reconcile functions used by the existing startup sweep, or also fold in doctor's separate dangling-claims check (which reads a different table/definition of staleness)? → A: Reuse only the existing `reapDeadRuns` / `reconcileStaleClaims` pair already used by the startup sweep. Do not merge in doctor's `artifact_claims`-based dangling-claims check, since it uses a distinct table and threshold and mixing the two would create two competing definitions of "stale" inside one feature.
- Q: How should an operator configure the sweep interval without editing code? → A: An environment variable, following the existing precedent of `GUILDCTL_STALL_MINS` and `GUILD_PREFLIGHT_OFFLINE` for other guildctl operational tuning knobs, rather than a new CLI flag.
- Q: How should artifacts recovered by a periodic sweep be represented in the session's final machine-readable result? → A: Merged into the existing `recoveredArtifacts` array on the queue result, the same field the startup sweep's recoveries already populate, rather than a separate field — consumers already treat that array as "recovered by the queue's own reaping," regardless of when it happened.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Mid-session self-healing of a stale claim (Priority: P1)

An operator kicks off a long `guildctl auto-run` session that will sequentially process many artifacts. Partway through, one of the spawned per-artifact agent processes hangs and stops updating its claim heartbeat. Today, nothing detects this until the session ends and the operator remembers to run `guildctl doctor` or `guildctl repair`. With this feature, the supervisor loop itself notices the stale claim on its next periodic sweep, releases/reaps it the same way the existing startup sweep does, and the artifact becomes claimable again — all while the session is still running.

**Why this priority**: This is the core value of the feature — the whole point of "always-on" is that staleness introduced mid-run gets caught without a human intervening.

**Independent Test**: Start an `auto-run` session against a queue with several artifacts, artificially age one artifact's claim past the staleness threshold while the session is still processing other artifacts, and confirm the stale claim is reaped/reconciled and the artifact becomes eligible for reprocessing before the session ends, without the operator invoking `doctor` or `repair`.

**Acceptance Scenarios**:

1. **Given** an `auto-run` session is mid-loop processing artifact B while artifact A's claim (from an earlier, now-dead run) has gone stale, **When** the next periodic sweep interval elapses, **Then** artifact A's stale claim is reaped/reconciled the same way the startup sweep would have handled it, without stopping or restarting the session.
2. **Given** a periodic sweep runs and finds no stale claims or dead runs, **When** the sweep completes, **Then** the session continues processing its queue with no visible disruption.

---

### User Story 2 - Operator visibility into mid-session staleness findings (Priority: P2)

An operator watching a long-running `auto-run` session's output wants to know when the supervisor's periodic sweep found and cleaned up something stale, so they can correlate it with an agent process that misbehaved, without having to separately run `guildctl doctor` afterward to reconstruct what happened.

**Why this priority**: Self-healing without visibility risks masking real problems (e.g., a systematically flaky harness). Surfacing findings is what makes the sweep trustworthy, but it is secondary to the self-healing itself.

**Independent Test**: Run an `auto-run` session where a claim goes stale mid-session; confirm the session's output includes a warning identifying what the periodic sweep found and reaped, distinguishable from the one-time startup sweep's report.

**Acceptance Scenarios**:

1. **Given** a periodic sweep reaps a dead run or reconciles a stale claim mid-session, **When** the operator reviews the session's output (live or after the fact), **Then** they can see what was found and remediated, and roughly when, without running a separate command.
2. **Given** a periodic sweep finds nothing stale, **When** the operator reviews output, **Then** no false-positive warning is shown.

---

### User Story 3 - Standalone single-artifact `auto` is explicitly out of scope (Priority: P3)

An operator runs `guildctl auto` against a single artifact whose per-attempt migrate/verify/repair cycle runs long enough that a claim elsewhere in the registry (held by a different, unrelated process) could go stale during that time. Per the scope decision recorded in Clarifications, standalone `guildctl auto` is not wired to the periodic sweep in this feature — it keeps today's one-time (startup-equivalent) staleness handling only. This user story exists to make that boundary explicit and testable, not to describe new behavior.

**Why this priority**: Real-world benefit is concentrated in `auto-run` (many sequential artifacts over a long session); a standalone `auto` invocation is bounded and short enough by comparison that this is documented as a limitation rather than built in this feature.

**Independent Test**: Run `guildctl auto` for a single long-running artifact while a stale claim exists elsewhere in the registry; confirm the stale claim is *not* cleaned up mid-invocation by this feature (no periodic sweep fires), and that this limitation is documented for operators (e.g., they should use `auto-run` or run `guildctl repair` manually for long standalone `auto` sessions).

**Acceptance Scenarios**:

1. **Given** `guildctl auto` is processing one artifact for longer than one sweep interval, **When** the sweep interval elapses, **Then** no periodic sweep fires (`auto` is out of scope for this feature), and this is documented as a known limitation rather than an oversight.

---

### Edge Cases

- What happens when a periodic sweep is due but the loop is currently awaiting a long-running `executeArtifact` call (migrate/verify/repair for the current artifact)? The sweep cannot preempt that in-flight work; it fires at the next loop iteration boundary, and the interval is measured in elapsed wall-clock time so a sweep is never skipped outright, only delayed until the current artifact's step completes.
- What happens when the periodic sweep's own staleness check fails (e.g., a transient database error)? The sweep failure must not crash or abort the session; the loop continues processing its queue, and the failure is surfaced as a warning, consistent with how other non-fatal supervisor conditions are already reported.
- What happens on a very short queue (e.g., 1-2 artifacts that finish before a single sweep interval elapses)? No periodic sweep fires beyond the existing startup sweep; behavior is unchanged from today for short sessions.
- What happens when the sweep reaps a run or reconciles a claim for an artifact that is *not* the one currently being processed? The artifact whose claim was reaped becomes eligible for (re-)selection by the normal candidate-selection logic on a later loop iteration, exactly as the existing startup sweep already allows.
- What happens when the sweep interval is misconfigured (e.g., set to zero or a negative value)? The system falls back to a safe default interval rather than sweeping on every iteration or never sweeping at all.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The `auto-run` sequential-processing loop (`runAutoQueue`) MUST perform a staleness sweep — reaping dead runs and reconciling stale claims — more than once per session when the session runs longer than a fixed interval, not only once at the start as it does today. Standalone `guildctl auto` is explicitly out of scope (see User Story 3).
- **FR-002**: The periodic sweep MUST reuse only the existing reap-dead-runs and reconcile-stale-claims logic already used for the startup sweep, and MUST NOT introduce doctor's separate `artifact_claims`-based dangling-claims check or any other new definition of "stale."
- **FR-003**: The sweep interval MUST default to 10 minutes and MUST be overridable by an operator via an environment variable (without modifying code), consistent with how the existing stale-session threshold (`GUILDCTL_STALL_MINS`) is already overridable.
- **FR-004**: The periodic sweep MUST NOT block or delay the processing of the artifact currently in flight; it runs at loop-iteration boundaries between artifacts, based on elapsed wall-clock time since the last sweep (startup sweep counts as the first).
- **FR-005**: When a periodic sweep reaps one or more dead runs or reconciles one or more stale claims, the session's operator-facing output MUST report what was found and remediated, distinguishable from the initial startup sweep's report.
- **FR-006**: When a periodic sweep finds nothing stale, it MUST NOT produce any operator-facing warning or noise.
- **FR-007**: A failure while performing a periodic sweep (e.g., a registry read error) MUST NOT abort or crash the session; the loop MUST continue processing remaining queued work, and the failure MUST be surfaced as a non-fatal warning.
- **FR-008**: An artifact whose claim is reaped/reconciled by a periodic sweep MUST become eligible for normal candidate selection on a subsequent loop iteration, the same way an artifact recovered by the startup sweep already does.
- **FR-009**: The existing one-time startup sweep behavior MUST remain unchanged; the periodic sweep is additive and does not replace or alter it.
- **FR-010**: The final session result/summary (for both human-readable and machine-readable/JSON output) MUST account for artifacts recovered by periodic sweeps by merging them into the same `recoveredArtifacts` collection the startup sweep already populates, not a separate field.

### Key Entities

- **Sweep event**: A point in time when the periodic staleness check runs. Attributes: trigger time, dead runs reaped (if any), claims reconciled (if any), and outcome (clean / findings / failed).
- **Stale claim / dead run**: An existing registry concept (unchanged by this feature) representing a claim or run whose heartbeat/activity has not been updated within the staleness threshold, making it eligible for automatic release or reaping.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In a long-running `auto-run` session (longer than one sweep interval), a claim or run that goes stale mid-session is detected and remediated without any operator running a separate command, in 100% of sessions that run past at least one sweep interval.
- **SC-002**: The time between a claim/run going stale and it being automatically remediated during an active session is bounded by the configured sweep interval (default sweep interval keeps this well under the time it previously took — an entire session, potentially hours — for a human to notice and intervene).
- **SC-003**: Sessions that complete within a single sweep interval show no behavior change from today (no added noise, no added latency) — 0 regressions in existing short-session output/tests.
- **SC-004**: 100% of periodic sweep findings are visible in the session's own output, so an operator reviewing a completed session's logs never has to separately run `guildctl doctor` to learn what staleness occurred during that session.
- **SC-005**: A malfunctioning periodic sweep (e.g., a transient error) never causes a session-ending failure that would not otherwise have occurred — 0 sessions abort solely due to a sweep-check error.

## Assumptions

- "Long-running" is defined relative to the configurable sweep interval: any `auto-run` session whose total wall-clock duration exceeds one sweep interval (default 10 minutes) is in scope for a second (or later) sweep; sessions shorter than that see no behavior change.
- This feature reuses existing staleness detection (dead-run reaping and stale-claim reconciliation) rather than defining new staleness rules or thresholds; existing thresholds for what counts as "stale" are out of scope for this feature to change.
- Scope is limited to `auto-run`'s queue loop (`runAutoQueue`). Standalone `guildctl auto` and unrelated commands (`migrate`, `repair`, etc.) that already have their own one-shot staleness reporting are out of scope.
- The periodic sweep is expected to run synchronously between artifact iterations (not on a separate background timer/thread), since the loop is already single-threaded and awaits one artifact at a time; this keeps the remediation logic's existing single-writer assumptions about the registry database intact.
- This feature does not change what "stale" means, does not add new remediation actions beyond reap/reconcile, and does not change the human-triggerable `doctor`/`repair`/`release` commands, which remain available as before.
