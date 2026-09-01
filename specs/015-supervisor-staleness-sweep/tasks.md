---
description: "Task list for the always-on supervisor staleness sweep (issue #218)"
---

# Tasks: Always-On Supervisor Staleness Sweep

**Input**: Design documents from `/specs/015-supervisor-staleness-sweep/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/supervisor-queue-sweep.md, quickstart.md

**Tests**: Included. The constitution's Development Workflow gate requires regression tests for any change to phase/supervisor control flow (Principle V, "Tests Before Production Code"), so each user story writes its tests first.

**Organization**: Tasks are grouped by user story from spec.md (US1 = P1, US2 = P2, US3 = P3) to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)
- Exact file paths are included in every task description

## Path Conventions

Single project (existing `migration/guildctl` + `migration/registry` CLI/registry tool). All paths are relative to the repository root.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Extend the shared type surface both user stories build on, with zero behavior change yet.

- [X] T001 [P] Extend `AutoQueueOptions` in `migration/guildctl/supervisor/queue.ts` with optional `sweepIntervalMs?: number` and `now?: () => number` fields, per `contracts/supervisor-queue-sweep.md` §1. No behavior change — fields are unused until Phase 2.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The interval-resolution and sweep-clock plumbing every user story depends on.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T002 Implement `resolveSweepIntervalMs(envValue: string | undefined): number` in `migration/guildctl/supervisor/queue.ts`: parse with `parseInt(envValue ?? "10", 10)` minutes, convert to ms, and fall back to the 10-minute default (600000ms) when the parsed value is not a finite positive number — mirrors the existing `STALL_MINUTES` pattern in `migration/guildctl/monitoring.ts`. Reads `process.env["GUILDCTL_SWEEP_INTERVAL_MINS"]` when `AutoQueueOptions.sweepIntervalMs` is not supplied.
- [X] T003 In `runAutoQueue` (`migration/guildctl/supervisor/queue.ts`), initialize a `lastSweepAt` timestamp (using `opts.now ?? Date.now`) immediately after the existing startup `reapDeadRuns`/`reconcileStaleClaims` calls, and resolve the effective interval via T002. No sweep-triggering logic yet — this just establishes the clock state the loop will read in Phase 3.
- [X] T004 [P] Add a `createFakeClock(startMs: number)` test helper (returns `{ now, advance(ms) }`) to `migration/test/auto-queue.test.ts`, for deterministic interval-elapsed simulation across all sweep tests (depends on T001).

**Checkpoint**: Foundation ready — user story implementation can now begin.

---

## Phase 3: User Story 1 - Mid-session self-healing of a stale claim (Priority: P1) 🎯 MVP

**Goal**: A claim or run that goes stale mid-`auto-run` session is detected and remediated by the loop itself, without an operator running `doctor`/`repair`.

**Independent Test**: Start `runAutoQueue` against a multi-artifact queue with an injected fake clock; advance the clock past the interval mid-loop while a stale claim/dead run exists in the registry fixtures; assert it is reaped/reconciled and reflected in `recoveredArtifacts`, with no session abort.

### Tests for User Story 1 ⚠️

> Write these tests FIRST; confirm they FAIL before starting implementation tasks below.

- [X] T005 [P] [US1] Test: with the fake clock advanced past the configured interval between two loop iterations, `runAutoQueue` re-invokes reap/reconcile and a previously-stale claim/run fixture is recovered, in `migration/test/auto-queue.test.ts`.
- [X] T006 [P] [US1] Test: with the fake clock advanced by less than the interval, no additional reap/reconcile call happens beyond the startup sweep, in `migration/test/auto-queue.test.ts`.
- [X] T007 [P] [US1] Test: when the periodic sweep call throws, `runAutoQueue` catches it, does not abort, and continues processing remaining queued artifacts to a normal terminal status, in `migration/test/auto-queue.test.ts`.
- [X] T008 [P] [US1] Test: an artifact recovered by a periodic sweep (not the artifact currently in flight) is selectable by `selectCandidate` on the next loop iteration and appears in the final `processed`/`recoveredArtifacts` output, in `migration/test/auto-queue.test.ts`.

### Implementation for User Story 1

- [X] T009 [US1] In the `while` loop body of `runAutoQueue` (`migration/guildctl/supervisor/queue.ts`), at the top of each iteration (before `selectCandidate`), compare `(opts.now?.() ?? Date.now()) - lastSweepAt` against the resolved interval; when due, call `reapDeadRuns(db)` and `reconcileStaleClaims(db, "guildctl-auto-run")` again and update `lastSweepAt`. Depends on T002, T003.
- [X] T010 [US1] Wrap the periodic sweep call from T009 in try/catch: on error, do not rethrow or abort the loop; record the error for non-fatal reporting (consumed by US2's output task) and still update `lastSweepAt` so a persistently-failing sweep doesn't spin every iteration (FR-007). In `migration/guildctl/supervisor/queue.ts`. Depends on T009.
- [X] T011 [US1] Merge each periodic sweep's `reconcileStaleClaims` return value into the function-scoped `recoveredArtifacts` array already returned in `AutoQueueResult`, de-duplicating against existing entries (including the startup sweep's), in `migration/guildctl/supervisor/queue.ts`. Depends on T009.

**Checkpoint**: Run `node --import tsx --test migration/test/auto-queue.test.ts` — all US1 tests pass. User Story 1 is independently functional: a long `auto-run` session self-heals mid-session staleness.

---

## Phase 4: User Story 2 - Operator visibility into mid-session staleness findings (Priority: P2)

**Goal**: When a periodic sweep finds and remediates something, the operator sees it in the session's own output, distinguishable from the startup sweep; a clean sweep produces no noise.

**Independent Test**: Run `runAutoQueue` (via injected `write`) with a fake clock advanced past the interval against a fixture containing a stale claim; assert one distinctly-labeled output line appears at sweep time (not only in the final summary) and that a clean sweep produces zero lines.

### Tests for User Story 2 ⚠️

- [X] T012 [P] [US2] Test: a periodic sweep that reaps/reconciles something produces exactly one console line via the injected `write` function, labeled distinctly from the startup sweep's report (if any) and naming what was recovered, in `migration/test/auto-queue.test.ts`.
- [X] T013 [P] [US2] Test: a periodic sweep that finds nothing stale produces zero additional output lines, in `migration/test/auto-queue.test.ts`.
- [X] T014 [P] [US2] Test: a periodic sweep that errors (per T010) produces one non-fatal warning line distinguishable from a fatal `auto-run` failure, in `migration/test/auto-queue.test.ts`.

### Implementation for User Story 2

- [X] T015 [US2] Add an optional `write?: (text: string) => void` field to `AutoQueueOptions` in `migration/guildctl/supervisor/queue.ts`, and thread `dependencies.write` from `runAutoRunCommand` (`migration/guildctl/commands/auto-run.ts`) into the `runAutoQueue` call, defaulting to `process.stdout.write` — mirrors the existing `AutoRunCommandDependencies.write` pattern already used for the runtime report. Depends on T001.
- [X] T016 [US2] In `migration/guildctl/supervisor/queue.ts`, after each periodic sweep (T009) that reaps or reconciles at least one item, call `opts.write` with one formatted line naming the reaped run ID(s)/reconciled artifact ID(s) and marking it as a mid-session/periodic sweep (per `contracts/supervisor-queue-sweep.md` §4). Emit nothing when the sweep is clean (FR-006). Depends on T009, T015.
- [X] T017 [US2] In `migration/guildctl/supervisor/queue.ts`, on a caught periodic-sweep error (T010), call `opts.write` with one non-fatal warning line clearly distinct from the `auto-run` failure summary format used in `migration/guildctl/commands/auto-run.ts`. Depends on T010, T015.

**Checkpoint**: Run `node --import tsx --test migration/test/auto-queue.test.ts` — all US1 + US2 tests pass. Operators running `auto-run` can see periodic sweep activity live.

---

## Phase 5: User Story 3 - Standalone `auto` stays out of scope; config edge cases (Priority: P3)

**Goal**: Confirm and document the scope boundary from Clarifications — standalone `guildctl auto` does not gain periodic sweeping — and harden the interval-configuration edge cases.

**Independent Test**: Run `guildctl auto`'s code path (`migration/guildctl/commands/auto.ts`) in isolation and confirm it makes no reference to the new sweep machinery; set `GUILDCTL_SWEEP_INTERVAL_MINS` to invalid values and confirm the documented fallback.

### Tests for User Story 3 ⚠️

- [X] T018 [P] [US3] Test: `resolveSweepIntervalMs` (T002) falls back to the 10-minute default for unset, `"0"`, `"-5"`, and `"abc"` input, and honors a valid positive value, in `migration/test/auto-queue.test.ts`.
- [X] T019 [P] [US3] Test/assertion: `migration/guildctl/commands/auto.ts` (the standalone `guildctl auto` path) does not call `runAutoQueue` and is unaffected by this feature — a static import/reference check or an explicit regression test confirming its existing test suite (if any covers it) still passes unchanged, in `migration/test/auto-queue.test.ts` or the nearest existing `auto`-path test file.

### Implementation for User Story 3

- [X] T020 [US3] Verify (and adjust if needed) that T002's `resolveSweepIntervalMs` fallback logic in `migration/guildctl/supervisor/queue.ts` satisfies T018 exactly — no separate implementation needed if T002 was written correctly; this task exists to close the loop on the edge case explicitly called out in spec.md's Edge Cases.
- [X] T021 [US3] Add a short note to `DEVELOPMENT.md` documenting the new `GUILDCTL_SWEEP_INTERVAL_MINS` environment variable, its default, and the explicit scope boundary (periodic sweep applies to `auto-run`'s queue loop only, not standalone `auto`), per the constitution's Development Workflow gate ("Changes to claim, lease, evidence, or run-lifecycle semantics MUST update both maintainer docs...").
- [X] T022 [P] [US3] Add an entry under `Unreleased` in `CHANGELOGS.MD` describing the always-on staleness sweep, citing issue #218.

**Checkpoint**: All three user stories are independently functional and documented.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Final validation across all stories.

- [X] T023 Run `npm --prefix migration test` (full suite, not just `auto-queue.test.ts`) and confirm no regressions in `migration/test/supervisor-held-approval.test.ts`, `migration/test/supervisor-failures.test.ts`, or any other test touching `runAutoQueue`/`AutoQueueOptions`.
- [X] T024 Execute the manual validation steps in `specs/015-supervisor-staleness-sweep/quickstart.md` §2 against a scratch workspace (or `package/mock/` fixtures) to confirm end-to-end behavior outside the unit-test harness.
- [X] T025 [P] Re-read `specs/015-supervisor-staleness-sweep/spec.md` Functional Requirements (FR-001 through FR-010) and confirm each is satisfied by the merged implementation; note any gaps as follow-up tasks rather than silently closing them out.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately.
- **Foundational (Phase 2)**: Depends on Setup (T001) — BLOCKS all user stories.
- **User Story 1 (Phase 3)**: Depends on Foundational (Phase 2) completion. No dependency on US2/US3.
- **User Story 2 (Phase 4)**: Depends on Foundational (Phase 2) completion, and on US1's sweep-trigger implementation (T009/T010) existing to have something to report on — practically sequenced after US1, though its `write` plumbing (T015) is independent and could start in parallel.
- **User Story 3 (Phase 5)**: Depends on Foundational (Phase 2) completion only; independent of US1/US2 implementation, though T019 benefits from US1 existing to assert against.
- **Polish (Phase 6)**: Depends on all desired user stories being complete.

### Within Each User Story

- Tests (T005-T008, T012-T014, T018-T019) MUST be written and FAIL before their corresponding implementation tasks.
- Core sweep-trigger logic (T009) before error handling (T010) and result-merging (T011).
- `write` plumbing (T015) before output formatting (T016, T017).

### Parallel Opportunities

- T001 (Setup) has no peers to parallelize with but is a single fast task.
- T004 (Foundational) is `[P]` — independent of T002/T003's production-code edits.
- All four US1 test tasks (T005-T008) are `[P]` — different assertions in the same file but logically independent; write them together, then implement T009-T011 sequentially since they touch the same loop body.
- All three US2 test tasks (T012-T014) are `[P]`.
- T018 and T019 (US3 tests) are `[P]`.
- T021 (docs) and T022 (changelog) can run in parallel with each other and with US1/US2 implementation once Foundational is done.

---

## Parallel Example: User Story 1

```bash
# Write all US1 tests together (all in migration/test/auto-queue.test.ts, but independent assertions):
Task: "Test: periodic sweep fires and recovers a stale fixture once interval elapses"
Task: "Test: periodic sweep does not fire before interval elapses"
Task: "Test: periodic sweep failure does not abort the loop"
Task: "Test: sweep-recovered artifact becomes selectable on next iteration"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001).
2. Complete Phase 2: Foundational (T002-T004) — CRITICAL, blocks all stories.
3. Complete Phase 3: User Story 1 (T005-T011).
4. **STOP and VALIDATE**: `node --import tsx --test migration/test/auto-queue.test.ts` — confirm self-healing works with no operator-visible output yet (that's US2).
5. This is a legitimate MVP: the core proposal from issue #218 (self-healing without a human running `doctor`/`repair`) is delivered even before US2's visibility layer lands.

### Incremental Delivery

1. Setup + Foundational → foundation ready.
2. User Story 1 → test independently → self-healing works silently (MVP).
3. User Story 2 → test independently → self-healing is now operator-visible.
4. User Story 3 → test independently → scope boundary and config edge cases are locked down and documented.
5. Polish → full-suite regression pass and manual quickstart validation.

---

## Notes

- [P] tasks touch independent logic even where they share a file (`migration/guildctl/supervisor/queue.ts` or `migration/test/auto-queue.test.ts`); sequence the actual edits to avoid merge conflicts within a single working session even when marked [P].
- Constitution Principle V requires tests before production code for supervisor control-flow changes — every implementation task in Phases 3-5 has a preceding test task.
- No task modifies `legacy/`, `modern/`, `migration/guildctl/commands/auto.ts` (standalone `auto`), `migration/guildctl/doctor.ts`, or `migration/guildctl/monitoring.ts` — confirmed out of scope per spec.md Assumptions and research.md.
- Commit after each task or logical group; stop at each Checkpoint to validate that story independently before continuing.
