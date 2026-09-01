# Phase 0 Research: Always-On Supervisor Staleness Sweep

All Technical Context unknowns were resolved during specification (see spec.md Clarifications) or by reading the existing implementation directly. No NEEDS CLARIFICATION markers remain.

## Decision: Sweep trigger mechanism

**Decision**: Track elapsed wall-clock time since the last sweep (startup sweep counts as the first) using `Date.now()`, and check that elapsed time at the top of each `while` loop iteration in `runAutoQueue`, immediately before `selectCandidate` is called. If the interval has elapsed, run `reapDeadRuns`/`reconcileStaleClaims` again before continuing.

**Rationale**: `runAutoQueue`'s loop is single-threaded and `await`s one `executeArtifact` call per iteration; there is no way to preempt that in-flight call, so a real-time timer (e.g. `setInterval`) would either fire while a database write from `executeArtifact`'s own path is in flight (risking interleaved writes against the single-writer SQLite handle) or would need its own queuing/synchronization logic. Checking elapsed time at a loop-iteration boundary is simpler, requires no new concurrency primitives, and matches the existing pattern where the startup sweep already runs synchronously before the loop begins.

**Alternatives considered**:
- `setInterval`/timer-based sweep running concurrently with `executeArtifact`: rejected — introduces concurrent registry writes against a handle the codebase treats as effectively single-writer per session, and would fire during long single-artifact processing regardless of loop state, needing its own cancellation/cleanup on process exit.
- Sweep only when a candidate claim fails: rejected — doesn't catch staleness in claims unrelated to the artifact currently being selected, which is the core gap the proposal (issue #218) identifies.

## Decision: Interval configuration

**Decision**: Default interval is 10 minutes (600_000 ms), overridable via a new environment variable following the existing `GUILDCTL_STALL_MINS` naming convention (e.g. `GUILDCTL_SWEEP_INTERVAL_MINS`), parsed the same way `STALL_MINUTES` is parsed in `migration/guildctl/monitoring.ts` (`parseInt(process.env[...] ?? "10", 10)`), with a fallback to the default when the value is not a positive integer (covers the "misconfigured to zero/negative" edge case from spec.md).

**Rationale**: Reuses an established, already-documented pattern rather than inventing a new configuration mechanism or CLI flag surface. 10 minutes mirrors the existing stale-session default, giving the codebase one consistent "stale after ~10 min" mental model across `printStaleSessionWarnings` and this new sweep, and is short relative to a typical multi-hour `auto-run` session (materially better than the status quo of "only at startup, or whenever a human remembers").

**Alternatives considered**:
- New CLI flag (`--sweep-interval`) on `auto-run`: rejected per clarification — env var matches existing operational-tuning-knob precedent (`GUILDCTL_STALL_MINS`, `GUILD_PREFLIGHT_OFFLINE`) and avoids growing `auto-run`'s already sizeable option surface for a knob operators will rarely need to change.
- 1-hour default (matching doctor's dangling-claim threshold): rejected — that threshold defines what counts as "stale," not how often to check for it; checking hourly would leave most of a stale claim's first hour undetected mid-session, undermining "always-on."

## Decision: What the sweep reuses

**Decision**: The periodic sweep calls exactly `reapDeadRuns(db)` and `reconcileStaleClaims(db, "guildctl-auto-run")` — the same two functions and same owner-id argument already used for the startup sweep — and nothing else. It does not call `runPipelineStateChecks` (doctor's bundled multi-check function) or `printStaleSessionWarnings` (which queries a different table/threshold).

**Rationale**: Per FR-002 and the corresponding clarification, mixing in doctor's `artifact_claims`-based dangling-claims check (1-hour default threshold, different table) would create two different, simultaneously-active definitions of "stale" inside one feature — one via `reapDeadRuns`/`reconcileStaleClaims` (registry runs/claims tables, mutates state) and one via doctor (read-only report against `artifact_claims.heartbeat_at`). Reusing only the existing pair keeps the sweep's behavior identical in kind to what already happens at startup, just repeated.

**Alternatives considered**:
- Also surfacing `runPipelineStateChecks`'s dangling-claims warning text mid-sweep: rejected for this feature — that's a read-only report layered on a different definition of staleness; conflating it with the mutating reap/reconcile pair risks the sweep both reporting a claim as "dangling" and not being the thing that resolves it, confusing operators. Left as a candidate follow-up, not in scope.

## Decision: Result-shape and output integration

**Decision**: `AutoQueueResult.recoveredArtifacts` (already returned by `runAutoQueue`) accumulates periodic-sweep recoveries in addition to the startup sweep's, using the same array. A new internal counter/list distinguishes "found during periodic sweep #N at time T" for the purposes of live console output (User Story 2), but the final JSON result shape does not need a new field — per FR-010 and the clarification, consumers already treat `recoveredArtifacts` as "recovered by the queue's own reaping."

**Rationale**: Minimizes API/schema churn for existing consumers of `AutoQueueResult` (tests, any tooling reading `--json` output) while still satisfying the live-visibility requirement (FR-005) through console output emitted at the moment each periodic sweep runs, not just in the final summary.

**Alternatives considered**:
- New `periodicSweeps: Array<{ at: string; recoveredArtifacts: string[] }>` field on `AutoQueueResult`: considered but deferred — adds surface area beyond what FR-005/FR-010 require (operator-visible-in-output, not necessarily structured-in-JSON). Live console output plus the existing `recoveredArtifacts` array satisfies the spec's success criteria without a schema change; can be added later if a consumer needs structured per-sweep detail.

## Decision: Testability (fixed interval vs. injectable clock)

**Decision**: The elapsed-time check uses an injectable clock function (defaulting to `Date.now`) threaded through `AutoQueueOptions`, following the existing pattern of `AutoQueueOptions.executeArtifact` and `AutoRunCommandDependencies.preflight` being injectable for hermetic tests.

**Rationale**: `migration/test/auto-queue.test.ts` already exercises `runAutoQueue` with injected fakes; a real 10-minute wait in a test suite run via `node --import tsx --test` is not viable. An injectable clock lets tests simulate "time has advanced past the interval" deterministically, consistent with Constitution Principle V (tests before production code) and the Development Workflow gate requiring regression tests for phase-control-flow changes.

**Alternatives considered**:
- Iteration-count-based sweep (e.g., every N artifacts) instead of wall-clock time: rejected — doesn't match "fixed interval" from the proposal/spec, and a queue of few-but-slow artifacts (each taking much longer than the interval) would never get a periodic sweep under an iteration-count trigger, defeating the purpose.
