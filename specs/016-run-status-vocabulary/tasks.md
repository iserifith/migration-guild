---

description: "Task list for feature implementation"
---

# Tasks: Run Status Vocabulary on the Operator Dashboard

**Input**: Design documents from `/specs/016-run-status-vocabulary/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/run-status-api.md, quickstart.md

**Tests**: Included. Per the constitution's Principle V note in plan.md ("Kit behavior itself MUST be covered by the `migration/test` suite") and repo precedent (spec-013 US4's T024/T025 preceding T026-T029), registry-layer and UI tests are written alongside/before their implementation tasks.

**Organization**: Tasks are grouped by user story (US1 = working, US2 = idle, US3 = consistent four-state presentation of the already-shipped waiting-for-approval/rejected states), matching spec.md.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)
- Paths are relative to repo root

## Path Conventions

Existing monorepo layout (see plan.md Project Structure): `migration/registry/` (backend reads), `migration/ui/src/` (dashboard), `migration/test/` (registry-layer tests).

---

## Phase 1: Setup

**Purpose**: No new project scaffolding is needed — this feature extends existing `migration/registry` and `migration/ui` packages. This phase only confirms the starting point compiles/tests clean.

- [ ] T001 Run `npm test` from repo root on a clean `016-run-status-vocabulary` branch to confirm the existing suite (migration + migration/ui) passes before any changes, per the constitution's Development Workflow gate

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The single derivation function, its backing constant/type, and the endpoint that exposes it are shared by all three user stories (a "working" vs. "idle" vs. "waiting-for-approval" vs. "rejected" label all come out of one precedence-ordered function per data-model.md). This phase builds that shared foundation; no user story can be demoed without it.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [ ] T002 [P] Add `WORKING_RECENCY_THRESHOLD_MS` constant (5 minutes, `5 * 60 * 1000`) and the `RunStatusLabel`/`RunStatusEntry` types to `migration/registry/types.ts`, with a comment distinguishing it from `guildctl doctor`'s separate 60-minute `danglingClaimThresholdMs` (research.md)
- [ ] T003 [US-shared] Write a registry-layer test in `migration/test/` (new file, e.g. `run-status.test.ts`) covering the precedence rules from data-model.md: recent-heartbeat active claim → `working`; stale-heartbeat/no active claim → `idle`; `pending-approval` status → `waiting-for-approval`; recorded `rejected` arbitration decision → `rejected`; an artifact satisfying both an active recent claim and a `rejected` decision → `rejected` (precedence); NULL `heartbeat_at` falls back to `claimed_at` (FR-006). Write this test to FAIL before T004 exists.
- [ ] T004 Implement the derivation function (e.g. `queryRunStatusForUI`) in `migration/registry/commands/queries.ts`, reusing `listPendingApprovals` (or its underlying `pending-approval` check) and the `arbitration_decisions` read pattern from `migration/registry/commands/approval.ts` per FR-007/FR-008 — no duplicated query logic. Run T003 to green.
- [ ] T005 Add `GET /api/run-status` to `migration/registry/commands/serve.ts`, dispatching directly to the T004 function, following the existing `GET /api/approvals` dispatcher pattern (serve.ts ~lines 137-140)
- [ ] T006 [P] Add `fetchRunStatus()` to `migration/ui/src/api.ts` and mirror the `RunStatusEntry` DTO type in `migration/ui/src/types.ts`
- [ ] T007 [P] Add badge colors/labels for the four-state vocabulary to `migration/ui/src/constants.ts` (parallel to existing `STATUS_COLORS`), and add a hook in `migration/ui/src/hooks.ts` that fetches `/api/run-status` using the existing `pollIntervalMs`-driven shared fetch pattern already used elsewhere in that file

**Checkpoint**: Foundation ready — `/api/run-status` returns correct four-state labels for all fixture cases; UI has data access. User story implementation (which is now mostly presentation/wiring) can begin.

---

## Phase 3: User Story 1 - Operator sees which artifacts are actively being worked on right now (Priority: P1) 🎯 MVP

**Goal**: The dashboard visibly labels an artifact "working" when its active claim has a recent heartbeat, and stops labeling it "working" once the heartbeat crosses the 5-minute threshold.

**Independent Test**: With one artifact under an active claim with a recent `heartbeat_at`, open the dashboard and confirm a "working" indicator; let the heartbeat go stale past 5 minutes without releasing the claim, and confirm the indicator changes away from "working" on the next poll.

### Tests for User Story 1 ⚠️

- [ ] T008 [P] [US1] Write a UI test in `migration/ui/src/components/RunStatusBadge.test.tsx` asserting the badge renders "working" for a `working`-labeled entry, and that a poll-cycle refetch (advance the existing `pollIntervalMs` timer, same pattern as other polling hook tests) that changes the entry from `working` to `idle` updates the badge without a manual reload (SC-003, FR-011). Write to FAIL before T010 exists.

### Implementation for User Story 1

- [ ] T009 [US1] Create the shared `RunStatusBadge` component in `migration/ui/src/components/RunStatusBadge.tsx`, rendering the label/color from `migration/ui/src/constants.ts` (T007) for a single `RunStatusEntry`
- [ ] T010 [US1] Wire the T007 hook + `RunStatusBadge` into `migration/ui/src/App.tsx` (or the artifact list/detail composition point, e.g. `ArtifactList.tsx`/`ArtifactDetail.tsx`) so artifacts with a `working` label are visibly indicated. Run T008 to green.

**Checkpoint**: User Story 1 fully functional and independently testable — operators can see "working" artifacts live.

---

## Phase 4: User Story 2 - Operator sees which artifacts have nothing happening on them (Priority: P1)

**Goal**: Artifacts with no active claim (or a claim whose heartbeat has gone stale) are clearly labeled "idle," distinct from "working," "waiting-for-approval," and "rejected."

**Independent Test**: With an artifact that has no active claim, open the dashboard and confirm it is labeled "idle" and not any other of the three labels; release/expire an active claim and confirm the label changes from "working" to "idle" on the next poll, not to a blank/error state.

### Tests for User Story 2 ⚠️

- [ ] T011 [P] [US2] Extend `migration/ui/src/components/RunStatusBadge.test.tsx` (or add a sibling test) asserting the badge renders "idle" for an `idle`-labeled entry, and that it is visually distinct from the "working" badge style (FR-009). Write to FAIL before T012 exists.

### Implementation for User Story 2

- [ ] T012 [US2] Confirm/finish `RunStatusBadge`'s `idle` rendering path (styling per T007's constants) — this is largely covered by T009's generic implementation; this task closes any `idle`-specific gap (e.g., default/fallback styling, empty-claim edge case verification against T003's fixtures). Run T011 to green.

**Checkpoint**: User Stories 1 AND 2 both work independently — the two new derived states are both visible and correctly distinguished.

---

## Phase 5: User Story 3 - Operator sees the full four-state vocabulary presented consistently (Priority: P2)

**Goal**: "Waiting-for-approval" and "rejected" (already shipped via spec-013 US4) are presented using the same visual vocabulary/legend as the new "working"/"idle" states, without altering the existing `ApprovalsPanel`'s endpoints or approve/reject behavior.

**Independent Test**: With one artifact held at `pending-approval` and one with a recorded `rejected` decision, confirm both are identifiable via the same shared badge/legend vocabulary as "working"/"idle" artifacts, and confirm `ApprovalsPanel`'s existing approve/reject flow is unchanged.

### Tests for User Story 3 ⚠️

- [ ] T013 [P] [US3] Add a UI test asserting `RunStatusBadge` renders `waiting-for-approval` and `rejected` labels using the same shared styling system as `working`/`idle` (not `ApprovalsPanel`-specific styling), in `migration/ui/src/components/RunStatusBadge.test.tsx`
- [ ] T014 [P] [US3] Run the existing `migration/ui/src/components/ApprovalsPanel.test.tsx` suite unmodified and confirm it still passes (regression guard for FR-007/SC-004 — this feature must not alter approval endpoint/panel behavior)

### Implementation for User Story 3

- [ ] T015 [US3] Add a small shared legend (or consistent badge treatment) referencing all four labels, placed near existing status displays in `migration/ui/src/App.tsx`, so `waiting-for-approval`/`rejected` (sourced from the existing `ApprovalsPanel` data path per FR-007/FR-008) read as part of the same vocabulary as the new `working`/`idle` badges. Run T013/T014 to green.

**Checkpoint**: All three user stories independently functional — dashboard tells one coherent four-state story.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Constitution's Development Workflow gate and final validation.

- [ ] T016 Run `quickstart.md`'s full validation sequence (registry-layer, API, UI, and optional manual end-to-end check) against the finished implementation
- [ ] T017 Run `npm test` from repo root and confirm the full suite (migration + migration/ui) passes
- [ ] T018 [P] Update `CHANGELOGS.MD` under `Unreleased` noting the new four-state dashboard vocabulary, per the constitution's Development Workflow gate
- [ ] T019 Answer the constitution's maintainer checklist (repo-only vs. shipped; `package/` update needed?; `migration/` updated; `DEVELOPMENT.md` update needed?) — this feature is `migration/`-only (registry + UI runtime code), so confirm no `package/` mirror is required per the "Runtime code MUST NOT be mirrored between `migration/` and `package/`" boundary

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS all user stories (T002-T007 produce the one derivation function/endpoint/hook every story's UI work depends on)
- **User Stories (Phase 3-5)**: All depend on Foundational phase completion; US1 and US2 can proceed in parallel since they touch the same `RunStatusBadge` component but different label branches (coordinate on T009 vs. treat T012 as a fast-follow after T009 lands); US3 depends on US1/US2's `RunStatusBadge` existing (T009) since it reuses the same component for the other two labels
- **Polish (Phase 6)**: Depends on all three user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational — creates `RunStatusBadge` (T009)
- **User Story 2 (P1)**: Can start after Foundational — extends the same `RunStatusBadge` created in US1; in practice implement US1 and US2 together since they share one component, but they are independently testable per their Independent Test criteria
- **User Story 3 (P2)**: Can start after Foundational; depends on `RunStatusBadge` existing (from US1/US2) to reuse for `waiting-for-approval`/`rejected`

### Parallel Opportunities

- T002 (types/constant) and T006/T007 (UI types/api/hook scaffolding) can run in parallel — different files
- T008 and T011 (US1/US2 tests) can be written in parallel once T009's component shell exists
- T013 and T014 (US3 tests) can run in parallel — different test files
- T018 (changelog) can run in parallel with T016/T017 (validation)

---

## Parallel Example: Foundational Phase

```bash
Task: "Add WORKING_RECENCY_THRESHOLD_MS constant and RunStatusLabel/RunStatusEntry types to migration/registry/types.ts"
Task: "Add fetchRunStatus() to migration/ui/src/api.ts and mirror RunStatusEntry in migration/ui/src/types.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (produces the full four-state endpoint, even though only "working" is surfaced in the UI at this point)
3. Complete Phase 3: User Story 1 — dashboard shows "working" badges
4. **STOP and VALIDATE**: Confirm US1's Independent Test passes
5. Deploy/demo if ready — "idle" artifacts simply show no badge yet, which is a safe intermediate state

### Incremental Delivery

1. Setup + Foundational → four-state data available end-to-end via `/api/run-status`
2. Add US1 → "working" visible → validate → demo (MVP)
3. Add US2 → "idle" visible and distinct → validate → demo
4. Add US3 → "waiting-for-approval"/"rejected" folded into the same vocabulary/legend → validate → demo
5. Polish → changelog, full suite, quickstart validation

---

## Notes

- Open item carried forward, not resolved by this task list (per spec.md Assumptions and research.md): the 5-minute working-recency threshold (T002) and issue #218's concurrently-specified supervisor staleness sweep interval conceptually overlap and should probably share a constant eventually — noted here for whoever picks up that reconciliation, not actioned in this feature.
- [P] tasks touch different files with no dependency on an incomplete task
- Commit after each task or logical group
- Avoid: vague tasks, same-file conflicts, cross-story dependencies that break independent testability
