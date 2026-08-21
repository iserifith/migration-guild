---

description: "Task list for feature implementation"
---

# Tasks: Human Approval Gate and Attempt-Scoped Retry History for the Migrate/Review Loop

**Input**: Design documents from `/specs/013-approval-gate-attempt-state/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/registry-commands.md](contracts/registry-commands.md), [quickstart.md](quickstart.md)

**Tests**: Included and required, not optional — the project constitution (Principle V: "Kit behavior itself MUST be covered by the `migration/test` suite. Changes to claims, evidence gates, arbitration, warden scope, or phase control flow MUST ship with regression tests.") mandates regression tests for exactly the surfaces this feature touches (arbitration, evidence gate, claim-adjacent attempt bookkeeping).

**Organization**: Tasks are grouped by user story (US1–US4, priorities from spec.md) to enable independent implementation and testing of each.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Which user story this task belongs to (US1, US2, US3, US4)
- File paths are exact, taken from plan.md's Project Structure and contracts/registry-commands.md

## Path Conventions

Single existing project. All paths are relative to the repository root, rooted at `migration/` (registry, guildctl CLI, supervisor, ui, test) per plan.md's Structure Decision. No new top-level directories.

---

## Phase 1: Setup (Shared Test Infrastructure)

**Purpose**: Fixture helpers reused by multiple stories' test files, so story test tasks don't duplicate registry bootstrap boilerplate.

- [ ] T001 [P] Create `createGatedArtifactDb()` fixture helper in migration/test/approval-fixtures.ts — a database with one artifact already at `migrated` status, an `artifact_risk_assessments` row, and an approving `arbitration_decisions` row, parameterizable as above/below the risk cutoff (reused by US1 and US2 tests)
- [ ] T002 [P] Create a flaky-attempt fixture helper in migration/test/attempt-fixtures.ts that drives an artifact through N configurable migrate-attempt failures before succeeding, following the existing flaky-fixture pattern used elsewhere in migration/test (reused by US3 tests)

**Checkpoint**: Fixture helpers exist; story phases below can begin.

---

## Phase 2: Foundational

**No blocking foundational tasks were identified.** Per plan.md's Constitution Check and data-model.md, the two schema additions (`approval_decisions`/`pending-approval` status for US1, `attempt_records` for US3) are independently additive and are not shared by every story — each is scoped to the story phase that needs it (T004 under US1, T018 under US3). This preserves the stories' independence: US1/US2 (the approval gate) and US3 (attempt history) can be implemented, tested, and delivered in either order.

**Note**: Both schema additions land in the same file, `migration/registry_schema.sql` — T004 and T018 touch that file and are therefore not parallelizable with each other even though their stories are otherwise independent.

---

## Phase 3: User Story 1 - High-risk artifacts wait for a human decision before completing (Priority: P1) 🎯 MVP

**Goal**: An approving arbiter verdict on an in-scope (high-risk) artifact diverts it to a new `pending-approval` state instead of completing it; a shared registry function, not yet exposed by any CLI/UI surface, records the human decision and releases the artifact to `reviewed` or `needs-rework`.

**Independent Test**: Per spec.md — run the pipeline over a fixture with one above-cutoff and one below-cutoff artifact, both passing automated review; confirm the below-cutoff artifact completes unattended while the above-cutoff artifact holds at `pending-approval`, and only advances when `recordApprovalDecision` is called directly (no CLI needed to prove this story).

### Tests for User Story 1 ⚠️

> Write these tests FIRST; they MUST fail until the implementation tasks below land.

- [ ] T003 [P] [US1] Write state-transition tests in migration/test/approval-gate.test.ts covering: acceptance scenarios 1–5 from spec.md (divert on approving verdict, approve→reviewed, reject→needs-rework with reason, below-cutoff bypasses the gate unchanged, unattended run holds without auto-approving per FR-012), plus FR-006 (stale-evidence approval is blocked), FR-007 (no active claim held in `pending-approval`), and research.md §1 (arbiter identity cannot record its own gated artifact's decision)

### Implementation for User Story 1

- [ ] T004 [US1] Extend migration/registry_schema.sql: add `'pending-approval'` to the `artifacts.status` CHECK constraint (and `artifact_claims.from_status` CHECK, per data-model.md §1); add the `approval_decisions` table and its two indexes (data-model.md §2)
- [ ] T005 [US1] Implement `resolveGateScope(db, artifactId)` in migration/registry/commands/approval.ts, reading `artifact_risk_assessments.high_risk` and the stack pack's `resolveRiskSpec`/`highRiskScoreCutoff` (migration/guildctl/risk.ts) — pure read, per contracts/registry-commands.md
- [ ] T006 [US1] Implement `recordApprovalDecision(db, opts)` in migration/registry/commands/approval.ts: precondition checks (status is `pending-approval`; operator ≠ approving arbiter identity; `checkEvidenceFreshness` passes; reason required on reject), single-transaction insert into `approval_decisions` + status transition + events row, per contracts/registry-commands.md
- [ ] T007 [US1] Wire the gate-scope check into `approveArtifactWithEvidence()` in migration/registry/commands/evidence.ts (currently the `migrated → reviewed` transition point, evidence.ts:487): call `resolveGateScope`, and for in-scope artifacts transition to `pending-approval` instead of `reviewed`, in the same transaction as the arbiter decision
- [ ] T008 [US1] Update migration/guildctl/commands/arbitrate.ts's verdict→status output/messaging (arbitrate.ts:80 area) to reflect `pending-approval` as the resulting target status for gated artifacts, without altering the arbiter's own approve/reject verdict logic
- [ ] T009 [US1] Exclude `status = 'pending-approval'` from claim eligibility queries in migration/guildctl/supervisor/loop.ts (same exclusion shape as the existing `blocked`/`skipped` handling)
- [ ] T010 [US1] Add a `heldForApproval` count, distinct from `blocked`, to the run-summary reporting in migration/guildctl/supervisor/loop.ts, satisfying FR-005
- [ ] T011 [US1] Run migration/test/approval-gate.test.ts (T003) to green; add the rework re-entry case (research.md §2: reject → rework → re-passes review → re-enters `pending-approval`)

**Checkpoint**: User Story 1 is fully functional and independently testable via direct calls to `recordApprovalDecision` — no CLI required yet.

---

## Phase 4: User Story 2 - Operator can record approve/reject decisions without a graphical interface (Priority: P1)

**Goal**: A `guildctl approve` CLI command lists and decides pending approvals by calling the exact same registry functions User Story 1 built — no CLI-local business logic.

**Independent Test**: Per spec.md — with one artifact awaiting decision (produced by US1's mechanics), list pending decisions from the command line, approve one by identifier, confirm it completes; reject another with a reason, confirm it returns to rework.

**Depends on**: User Story 1 (T004–T007) for the `pending-approval` state and `recordApprovalDecision`/schema to exist. Not parallelizable with US1, but implementable as a distinct, later increment.

### Tests for User Story 2 ⚠️

- [ ] T012 [P] [US2] Write CLI tests in migration/test/approval-cli.test.ts covering spec.md acceptance scenarios 1–2 (list shows risk reason codes + verdict summary; approve and reject via CLI produce the identical outcome as calling the registry function directly), following the existing migration/test/arbitrate-manual-approval.test.ts pattern (spawnSync against the CLI, credential handling)

### Implementation for User Story 2

- [ ] T013 [US2] Implement `listPendingApprovals(db)` in migration/registry/commands/approval.ts per contracts/registry-commands.md (pure read: artifact id, risk reason codes, arbitration verdict summary, entry timestamp)
- [ ] T014 [US2] Implement the `guildctl approve` command in migration/guildctl/commands/approve.ts: `--list [--json]`, `<artifact-id> [--reject --reason <text>] [--run-id <id>] [--operator-token <token>]`, calling only `recordApprovalDecision`/`listPendingApprovals` (no hand-rolled SQL, per FR-004), with clean single-line stderr + non-zero exit on `RegistryError`, matching the existing `guildctl arbitrate` convention in migration/guildctl/commands/arbitrate.ts
- [ ] T015 [US2] Register the `approve` command in migration/guildctl/cli.ts alongside the existing `.command("arbitrate")` registration (cli.ts:535 area)
- [ ] T016 [US2] Run migration/test/approval-cli.test.ts (T012) to green

**Checkpoint**: User Stories 1 and 2 together deliver the full approval-gate feature end-to-end via the command line (spec.md SC-001, SC-002).

---

## Phase 5: User Story 3 - Attempt-scoped retry and failure history survives and is queryable (Priority: P1)

**Goal**: Each migrate-phase retry attempt's outcome and failure classification is durably recorded, queryable after the fact, and correctly reconstructs retry-budget accounting across a process restart.

**Independent Test**: Per spec.md — run a fixture artifact that fails twice and succeeds on the third attempt; query retry history and confirm each attempt's outcome/failure reason is attributable to its own attempt number; kill and restart the process mid-artifact and confirm budget accounting afterward is neither reset nor double-counted.

**Depends on**: Nothing from US1/US2 — fully independent (uses `artifact_claims.attempt_no` and `migration/guildctl/supervisor/failures.ts`, untouched by US1/US2). Can be implemented before, after, or in parallel with US1/US2 by a different contributor.

### Tests for User Story 3 ⚠️

- [ ] T017 [P] [US3] Write tests in migration/test/attempt-records.test.ts covering spec.md acceptance scenarios 1–4: durable per-attempt failure classification (FR-008), ordered queryable attempt history matching the artifact's current attempt count (FR-010), restart-resumption with no lost/double-counted budget (FR-009, SC-004), and confirming `supervisor/loop.ts` scheduling reads only the final `outcome` column, never in-attempt detail (FR-011)

### Implementation for User Story 3

- [ ] T018 [US3] Extend migration/registry_schema.sql: add the `attempt_records` table and its two indexes, keyed `(artifact_id, attempt_no)` joined to the existing `artifact_claims.attempt_no` (data-model.md §3)
- [ ] T019 [US3] Implement `recordAttemptOutcome(db, opts)` and `getAttemptHistory(db, artifactId)` in migration/registry/commands/attempts.ts per contracts/registry-commands.md — `INSERT`-only (never upsert), throwing `RegistryError` on a primary-key collision
- [ ] T020 [US3] Implement `getPersistedBudgetState(db, artifactId)` in migration/registry/commands/attempts.ts, used to seed budget accounting from durable state (research.md §5)
- [ ] T021 [US3] Update `FailureBudget` in migration/guildctl/supervisor/failures.ts to persist through `attempts.ts`: write `recordAttemptOutcome` as each attempt concludes (reusing the existing `classifyFailure`/`FailureKind` vocabulary for the `failure_kind` column per research.md §4), and seed its in-process maps from `getPersistedBudgetState` on construction, without changing its existing public method signatures used by callers
- [ ] T022 [US3] Update the `FailureBudget` construction/call sites in migration/guildctl/supervisor/loop.ts to pass the `db`/artifact context `attempts.ts` needs
- [ ] T023 [US3] Run migration/test/attempt-records.test.ts (T017) to green, including the process-restart simulation (construct a fresh `FailureBudget` against the same `db` mid-sequence and confirm accounting continuity)

**Checkpoint**: All three P1 stories (US1, US2, US3) are independently complete; spec.md SC-001 through SC-004 are all demonstrable.

---

## Phase 6: User Story 4 - Pending decisions are visible in the operator dashboard (Priority: P2)

**Goal**: The Mission Control dashboard surfaces pending approvals with an Approve/Reject control, reusing US1/US2's registry functions verbatim.

**Independent Test**: Per spec.md — with one artifact awaiting decision, open the dashboard, confirm it appears in a labeled section with context; approve it from the dashboard; confirm the same outcome as the CLI path.

**Depends on**: User Story 1 (schema, `recordApprovalDecision`) and User Story 2 (`listPendingApprovals`). Deferred per plan.md's Structure Decision — this phase is the follow-up increment, not required for the feature's MVP.

### Tests for User Story 4 ⚠️

- [ ] T024 [P] [US4] Write an endpoint test alongside migration/registry/commands/serve.ts's existing test coverage, confirming the pending-approvals endpoint calls `listPendingApprovals`/`recordApprovalDecision` directly with no duplicated logic (FR-004)
- [ ] T025 [P] [US4] Write a UI test in migration/ui/src (following the existing `*.test.tsx` pattern, e.g. alongside ArtifactList.test.tsx) for the pending-approvals panel: renders held artifacts, empty state is not an error state, Approve/Reject controls fire the endpoint

### Implementation for User Story 4

- [ ] T026 [US4] Add a pending-approvals read endpoint to migration/registry/commands/serve.ts, calling `listPendingApprovals` directly
- [ ] T027 [US4] Add an approve/reject decision endpoint to migration/registry/commands/serve.ts, calling `recordApprovalDecision` directly
- [ ] T028 [US4] Add a pending-approvals panel component under migration/ui/src/components, wired through migration/ui/src/api.ts, showing each held artifact's risk reason codes, diff/output location, and arbiter verdict summary, with Approve/Reject controls
- [ ] T029 [US4] Wire the new panel into migration/ui/src/App.tsx (or the existing dashboard composition point), with an explicit empty state per spec.md acceptance scenario 3
- [ ] T030 [US4] Run T024/T025 to green

**Checkpoint**: All four user stories complete; spec.md SC-002 is also achievable through the dashboard, not just the CLI.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Constitution's Development Workflow gate and final validation.

- [ ] T031 Run `npm test` (full migration + Mission Control UI suite) from the repository root and confirm it passes in full — required before the change is considered complete per the constitution's Development Workflow section
- [ ] T032 [P] Add an entry under `Unreleased` in CHANGELOGS.MD describing the approval gate and attempt-history feature, per the constitution's Development Workflow section
- [ ] T033 [P] Answer the maintainer checklist from the constitution (repo-only vs. shipped; `package/` update needed; `migration/` update needed — yes; `DEVELOPMENT.md` update needed if claim/lease/evidence/run-lifecycle semantics changed, which they have via the new `pending-approval` status)
- [ ] T034 Run quickstart.md's five validation scenarios end-to-end in a disposable test workspace (per the user's own workflow convention: a dated subfolder under `migration-guild-test-workspaces/`, never the repository root)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately.
- **Foundational (Phase 2)**: No tasks (see note above) — does not block anything.
- **User Story 1 (Phase 3)**: Depends on Setup (T001). No dependency on other stories.
- **User Story 2 (Phase 4)**: Depends on Setup (T001) and User Story 1 (T004–T007) — needs the `pending-approval` state and `recordApprovalDecision` to exist before a CLI can drive them.
- **User Story 3 (Phase 5)**: Depends on Setup (T002) only. Fully independent of US1/US2 — different tables, different files, no shared call path.
- **User Story 4 (Phase 6)**: Depends on User Story 1 (schema, `recordApprovalDecision`) and User Story 2 (`listPendingApprovals`).
- **Polish (Phase 7)**: Depends on whichever stories were completed (at minimum US1–US3 for the feature's stated MVP; T034's quickstart scenarios 1–2 need US1+US2, scenario 4 needs US3).

### Within Each User Story

- Tests are written first and MUST fail before the corresponding implementation task lands.
- Schema task before command-layer tasks (a table must exist before code queries it).
- Command-layer (`registry/commands/*`) before CLI/supervisor call sites that invoke it.
- Story's own test-green task is last.

### Parallel Opportunities

- T001 and T002 (Setup) run in parallel — different files.
- User Story 3 (Phase 5) can be staffed and executed entirely in parallel with User Stories 1+2 (Phases 3–4) — no shared files except the one-line, non-conflicting note in registry_schema.sql (T004 vs. T018 — coordinate order, don't run simultaneously against the same file).
- T024 and T025 (US4 tests) run in parallel — different files (`serve.ts` test vs. UI test).
- T032 and T033 (Polish) run in parallel with each other and with T034.

---

## Parallel Example: Setup + User Story 3 run alongside User Stories 1–2

```bash
# Team member A, sequentially:
Task: "T001 Create createGatedArtifactDb() fixture helper"
Task: "T003 Write approval-gate state-transition tests (must fail)"
Task: "T004 Extend registry_schema.sql: pending-approval status + approval_decisions table"
Task: "T005 Implement resolveGateScope()"
Task: "T006 Implement recordApprovalDecision()"
Task: "T007 Wire gate-scope check into evidence.ts"
# ...continues through US1, then US2

# Team member B, in parallel, once T002 lands:
Task: "T002 Create flaky-attempt fixture helper"
Task: "T017 Write attempt-records tests (must fail)"
Task: "T018 Extend registry_schema.sql: attempt_records table"
Task: "T019 Implement recordAttemptOutcome()/getAttemptHistory()"
Task: "T020 Implement getPersistedBudgetState()"
Task: "T021 Wire FailureBudget persistence into failures.ts"
Task: "T022 Update loop.ts FailureBudget call sites"
Task: "T023 Run attempt-records.test.ts to green"
```

Coordinate T004 and T018 (both edit `registry_schema.sql`) so one lands before the other starts, even though the stories are otherwise independent.

---

## Implementation Strategy

### MVP First (User Stories 1 + 2 only)

1. Complete Phase 1: Setup (T001 sufficient for this path; T002 can wait).
2. Skip Phase 2 (no foundational tasks).
3. Complete Phase 3: User Story 1.
4. Complete Phase 4: User Story 2.
5. **STOP and VALIDATE**: run quickstart.md Scenarios 1–3 against a disposable test workspace.
6. This is a demoable MVP: high-risk artifacts hold for human approval, decidable from the CLI (spec.md SC-001, SC-002).

### Incremental Delivery

1. Setup → Foundation ready (trivial here — no real foundational phase).
2. US1 + US2 → Approval gate fully usable via CLI → validate → demo (MVP).
3. US3 → Attempt history durable and restart-safe → validate independently (can be delivered before, after, or interleaved with step 2) → demo.
4. US4 → Dashboard convenience layer → validate → demo.
5. Each story adds value without breaking a previously delivered one — no story's tasks modify another story's files except the shared, one-line-coordinated `registry_schema.sql` edits.

### Parallel Team Strategy

With two contributors:

1. Both complete Setup (T001, T002) together — five minutes of work, not worth splitting further.
2. Contributor A: User Story 1 → User Story 2 → User Story 4 (the approval-gate thread).
3. Contributor B: User Story 3 (the attempt-history thread), fully independent.
4. Both converge on Phase 7 (Polish) once their threads are done.

---

## Notes

- [P] tasks touch different files and have no incomplete-task dependency.
- [Story] labels map every implementation task back to spec.md's user stories for traceability.
- Every story phase ends with a "run tests to green" task — tests are written first (per the constitution's Principle V) and must fail before their implementation tasks land.
- The only cross-story file contention is `migration/registry_schema.sql` (T004, T018) — coordinate order, don't parallelize those two specific tasks against each other.
- Total: 34 tasks across Setup, (empty) Foundational, four user stories, and Polish.
