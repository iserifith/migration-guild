---

description: "Task list for Adversary Agent Role Between Review and the Approval Gate"
---

# Tasks: Adversary Agent Role Between Review and the Approval Gate

**Input**: Design documents from `/specs/017-adversary-agent-gate/`

**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/registry-commands.md, quickstart.md

**Tests**: Included. Constitution Principle V requires kit-behavior changes (claims, evidence gates, arbitration, phase control flow) to ship with regression tests in `migration/test/`, and the Development Workflow gate requires `npm test` to pass — this feature touches arbitration routing (`evidence.ts`) and the context store (`context.ts`), so test tasks are mandatory, not optional, matching #216's own `rejection-envelope.test.ts` precedent.

**Organization**: Tasks are grouped by user story (US1, US2, US3 from spec.md) to enable independent implementation and testing of each.

**Blocking dependency**: Per plan.md and spec.md Assumptions, this feature builds directly on issue #216 (branch `014-rejection-envelope`)'s `writeRejectionEnvelope`/`getRejectionEnvelope` helpers and reserved-key convention in `migration/registry/commands/context.ts`. T004 below assumes those exist on the integration branch before foundational work proceeds; if #216 has not landed, T004 must first land equivalent scaffolding or this phase blocks.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)
- File paths are exact, relative to repository root

## Path Conventions

Single project. Registry backend: `migration/registry/commands/`, `migration/registry/types.ts`. Kit test suite: `migration/test/`. Shipped agent procedures: `package/agents/`.

---

## Phase 1: Setup

**Purpose**: Confirm the branch is positioned correctly against its blocking dependency; no new tooling/dependencies needed (plan.md: "no new dependencies").

- [ ] T001 Confirm `migration/registry/commands/context.ts` contains #216's `writeRejectionEnvelope`/`getRejectionEnvelope` (or equivalent) and its `"rejection-envelope"` reserved-key constant; if absent, rebase/merge branch `014-rejection-envelope` (or its landed equivalent) into this feature branch before proceeding, per plan.md's blocking-dependency note.
- [ ] T002 Read current `migration/registry/commands/evidence.ts` and `migration/registry/commands/approval.ts` in full to reconfirm the below-cutoff branch location (`approveArtifactWithEvidence`'s `setArtifactStatus(db, opts.artifactId, "reviewed")` call) and the gate-bound branch location (`pending-approval` hold) have not shifted since research.md was written.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Registry-layer primitives every user story's routing depends on. No user story work should begin until this phase is complete.

**⚠️ CRITICAL**: Phase 3+ tasks all depend on T003–T006 below.

- [ ] T003 [P] Add the reserved `"adversary-envelope"` key as an exported constant in `migration/registry/commands/context.ts` (or `migration/registry/types.ts`, matching wherever #216 placed `"rejection-envelope"`), per data-model.md and contracts/registry-commands.md "single source of truth" requirement (FR-008).
- [ ] T004 [P] Implement `writeAdversaryEnvelope(db, artifactId, finding)` in `migration/registry/commands/context.ts`, mirroring `writeRejectionEnvelope`'s synthesized `## Summary` file write and `agent_context` upsert, keyed on the T003 constant; MUST NOT touch any other `agent`'s row for the same artifact (FR-007, FR-009, contracts/registry-commands.md).
- [ ] T005 [P] Implement `getAdversaryEnvelope(db, artifactId)` in `migration/registry/commands/context.ts` as a thin wrapper over `getContext(db, artifactId, "adversary-envelope")`, returning `null` on `form: "none"` (FR-010, FR-013, contracts/registry-commands.md).
- [ ] T006 Add the two new `events.type` literals (`adversary-flagged`, `adversary-inconclusive`, `adversary-probe-passed`) to wherever the codebase documents/validates known event types (check `migration/registry/types.ts` and any event-type allowlist), per data-model.md's Adversary Probe Event table.

**Checkpoint**: `writeAdversaryEnvelope`/`getAdversaryEnvelope` exist, are independently unit-testable, and do not yet have any caller — foundation ready for Phase 3.

---

## Phase 3: User Story 1 - A below-cutoff artifact gets one adversarial probe before it completes unattended (Priority: P1) 🎯 MVP

**Goal**: Insert the adversary-agent checkpoint into `approveArtifactWithEvidence` so a below-cutoff artifact cannot reach `reviewed` without a clean adversarial probe, and a gate-bound artifact runs the same checkpoint (FR-001–FR-006, FR-008a, FR-008b).

**Independent Test**: Per spec.md — take an artifact with a deliberately introduced spec-violating edge case its test suite doesn't cover, run the checkpoint, and confirm it does not reach `reviewed`; separately confirm a clean-probe artifact reaches `reviewed`/`pending-approval` exactly as today.

### Tests for User Story 1

- [ ] T007 [P] [US1] Test: below-cutoff artifact with a clean adversary probe reaches `reviewed` with no `adversary-envelope` row and no new event, in `migration/test/adversary-envelope.test.ts` (new file).
- [ ] T008 [P] [US1] Test: below-cutoff artifact with a flagged adversary probe reaches `needs-rework`, not `reviewed`, with an `adversary-flagged` event and a readable `adversary-envelope` row, in `migration/test/adversary-envelope.test.ts`.
- [ ] T009 [P] [US1] Test: below-cutoff artifact with an inconclusive adversary probe reaches `needs-rework` with an `adversary-inconclusive` event and an inconclusive-reason `adversary-envelope` row (FR-008a), in `migration/test/adversary-envelope.test.ts`.
- [ ] T010 [P] [US1] Test: gate-bound (above-cutoff) artifact with a clean adversary probe still holds at `pending-approval` as today, plus an `adversary-probe-passed` event that is not selectable as `acceptance_evidence` (FR-008b), in `migration/test/adversary-envelope.test.ts`.
- [ ] T011 [P] [US1] Test: gate-bound artifact with a flagged adversary probe routes to `needs-rework` instead of `pending-approval` (FR-006 — the checkpoint is not exempted by risk tier), in `migration/test/adversary-envelope.test.ts`.

### Implementation for User Story 1

- [ ] T012 [US1] In `migration/registry/commands/evidence.ts`, add the adversary-agent checkpoint inputs to `ApproveArtifactWithEvidenceOptions` (or an equivalent parameter shape resolving the "exact call-site wiring... left to task-level design" note in contracts/registry-commands.md), and thread the checkpoint result into the below-cutoff (`else`) branch immediately before `setArtifactStatus(db, opts.artifactId, "reviewed")` (depends on T003–T006).
- [ ] T013 [US1] In the same below-cutoff branch, on a violation-found or inconclusive result: call `writeAdversaryEnvelope` (T004) with the finding/inconclusive text, `appendEvent` with type `adversary-flagged` or `adversary-inconclusive`, and `setArtifactStatus(db, opts.artifactId, "needs-rework")` instead of `"reviewed"` — reusing the exact primitives `rejectArtifactWithEvidence` already uses (FR-004, FR-008a, FR-014).
- [ ] T014 [US1] Wrap the `writeAdversaryEnvelope` call from T013 in a try/catch that swallows any error (fail-open write, FR-015), mirroring `commitPromotedArtifact`'s existing doc-commented fail-open pattern in `migration/registry/commands/evidence.ts`; the `needs-rework` status transition and event append MUST still occur even if the write throws.
- [ ] T015 [US1] In the gate-bound (`gateScope.inScope`) branch of `approveArtifactWithEvidence`, on a clean adversary-agent result, append an `adversary-probe-passed` event (no `agent_context` write, no `targetStatus` change) before the existing `pending-approval` hold (FR-008b).
- [ ] T016 [US1] In the same gate-bound branch, on a violation-found or inconclusive result, route to `needs-rework` via the same T013 logic instead of holding at `pending-approval` (FR-006 — the checkpoint applies regardless of risk tier).
- [ ] T017 [US1] Author `package/agents/adversary-agent.agent.md`, modeled on `package/agents/review-agent.agent.md`'s structure (workspace-shape guidance, a narrow procedure scoped to FR-002, an output-format contract), documenting how its finding text reaches the T012 call site and that it MUST NOT invoke a separate approval/rejection CLI path of its own (FR-014, contracts/registry-commands.md).
- [ ] T018 [US1] Run `npm test` (registry/kit suite) and confirm T007–T011 pass against the T012–T016 implementation.

**Checkpoint**: User Story 1 is independently functional — the adversary-agent checkpoint runs, routes correctly, and is unskippable by risk tier. This is the MVP slice.

---

## Phase 4: User Story 2 - An adversary finding reaches the next remediation attempt through the existing rejection-relay flow (Priority: P1)

**Goal**: Give `remediation-agent.agent.md` a second, analogous read step so an `adversary-envelope` finding — alongside any `rejection-envelope` reason — reaches the next attempt's requeue text (FR-010–FR-013).

**Independent Test**: Per spec.md — force an adversary-agent finding via US1's mechanism, run remediation on the resulting `needs-rework` artifact, and confirm the finding appears in the requeue reason/summary without remediation reading any adversary-specific table directly.

### Tests for User Story 2

- [ ] T019 [P] [US2] Test: `getAdversaryEnvelope` returns the finding for a flagged artifact and `null` for an unflagged one, in `migration/test/adversary-envelope.test.ts` (extends T005's implementation coverage; may already be indirectly covered by T008/T009 — add an explicit direct-call test if not).
- [ ] T020 [P] [US2] Test: remediation's `get-context --agent adversary-envelope` read is exercised end-to-end (CLI or the function it calls) and its result appears in the `--reason`/`--summary` text passed to `set-artifact-status --status planned` / `append-event --type remediated`, in `migration/test/remediation-*.test.ts` (match #216's equivalent remediation test file name/location for `rejection-envelope`).
- [ ] T021 [P] [US2] Test: an artifact carrying both a `rejection-envelope` reason and an `adversary-envelope` finding surfaces both, distinguishably, in remediation's requeue text — neither overwrites the other (FR-009, FR-012), in the same test file as T020.
- [ ] T022 [P] [US2] Test: an artifact with neither envelope produces remediation output identical to pre-feature baseline (FR-013), in the same test file as T020.

### Implementation for User Story 2

- [ ] T023 [US2] Edit `package/agents/remediation-agent.agent.md`: add a second explicit procedural step, alongside #216's existing `get-context --agent rejection-envelope` step, to also run `get-context --agent adversary-envelope` before requeueing a `needs-rework` artifact (contracts/registry-commands.md, FR-010).
- [ ] T024 [US2] In the same document, update the instructions for folding envelope content into the requeue `--reason`/`--summary` text so both origins are included when both are present, each distinguishably labeled (e.g. prefixed "Human rejection:" / "Adversary finding:") (FR-011, FR-012).
- [ ] T025 [US2] Update the instructions to leave the existing reason/summary text unchanged when neither `get-context` call returns a result (FR-013) — no fabricated reason.
- [ ] T026 [US2] Run `npm test` and confirm T019–T022 pass against the T023–T025 implementation.

**Checkpoint**: User Stories 1 AND 2 both work independently — a flagged artifact is routed correctly (US1) and its finding reaches remediation (US2).

---

## Phase 5: User Story 3 - An adversary-agent finding does not silently vanish if it can't be recorded (Priority: P3)

**Goal**: Confirm and lock in, via explicit regression tests, the fail-open-write/fail-closed-routing asymmetry already implemented as part of US1 (T014) — this story adds no new production code, only dedicated coverage and documentation of the guarantee (FR-015).

**Independent Test**: Per spec.md — simulate a failure while writing the adversary finding into context and confirm the artifact still transitions to `needs-rework` with an event recorded, even though the detailed finding text is unavailable.

### Tests for User Story 3

- [ ] T027 [P] [US3] Test: simulate `writeAdversaryEnvelope` throwing (e.g. mock/monkeypatch the file write) during a flagged-artifact routing call; confirm `setArtifactStatus` still transitions to `needs-rework` and the `adversary-flagged`/`adversary-inconclusive` event is still appended, in `migration/test/adversary-envelope.test.ts`.
- [ ] T028 [P] [US3] Test: after the T027 simulated failure, confirm an operator can still determine "this artifact was sent back by the adversary-agent" purely from the event record (`events.type` = `adversary-flagged`/`adversary-inconclusive`), independent of whether `get-context --agent adversary-envelope` resolves, in `migration/test/adversary-envelope.test.ts`.

### Implementation for User Story 3

- [ ] T029 [US3] Review T014's try/catch placement against T027/T028; if any code path allows a `writeAdversaryEnvelope` failure to propagate out of `approveArtifactWithEvidence` (e.g. a failure occurring after the catch's scope, or during a future refactor), correct it in `migration/registry/commands/evidence.ts`.
- [ ] T030 [US3] Add a doc comment above the T013/T014 call site in `evidence.ts` stating the fail-open/fail-closed asymmetry explicitly, mirroring `commitPromotedArtifact`'s existing precedent comment, so future edits don't accidentally invert it.
- [ ] T031 [US3] Run `npm test` and confirm T027–T028 pass.

**Checkpoint**: All three user stories are independently functional and covered by regression tests.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Repo-hygiene and documentation gates the Constitution's Development Workflow section requires for every change.

- [ ] T032 [P] Run `migration/test/adversary-envelope.test.ts` and all other `migration/test/` files together via `npm test` to confirm no regressions in `approveArtifactWithEvidence`'s existing (pre-feature) behavior for artifacts the adversary-agent checkpoint does not affect.
- [ ] T033 [P] Update `DEVELOPMENT.md` if the maintainer checklist (repo-only vs. shipped; `package/` updated; `migration/` updated) requires it for this change, per the Constitution's Development Workflow gate.
- [ ] T034 [P] Add an entry under `CHANGELOGS.MD`'s `Unreleased` section, grouped by today's date heading, describing the new adversary-agent checkpoint and its dependency on issue #216.
- [ ] T035 Execute every scenario in `specs/017-adversary-agent-gate/quickstart.md` (Scenarios 1–8) against the implemented feature and confirm each expected outcome holds.
- [ ] T036 Re-read `migration/registry/commands/approval.ts` (`recordApprovalDecision`) to confirm it was not modified by any task above, satisfying FR-017.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — confirms the #216 blocking dependency is present.
- **Foundational (Phase 2)**: Depends on Phase 1 (T001 must confirm #216's helpers exist before T004/T005 can mirror them). BLOCKS all user stories.
- **User Story 1 (Phase 3)**: Depends on Phase 2 (T003–T006). No dependency on US2/US3.
- **User Story 2 (Phase 4)**: Depends on Phase 2. Its tests (T019–T022) exercise output US1 produces, so in practice run after US1, but its own implementation tasks (T023–T025) touch only `remediation-agent.agent.md` and do not modify US1's files — independently deliverable if US1's envelope-writing primitives (T004/T005) already exist, even before US1's `evidence.ts` wiring lands.
- **User Story 3 (Phase 5)**: Depends on Phase 2 and reviews/hardens US1's T013/T014 output — sequenced after US1 in this plan, though its own new work (T029/T030) is a small, isolated correction pass.
- **Polish (Phase 6)**: Depends on all three user stories being complete.

### Parallel Opportunities

- T003, T004, T005 (Phase 2) touch the same file (`context.ts`) but distinct functions/constants — mark [P] only if the implementer is comfortable with sequential merge inside one file; treat as effectively sequential in a single-author execution.
- T007–T011 (US1 tests) are [P] — same test file, but each is an independent test case addable in any order before T012–T016 land.
- T019–T022 (US2 tests) are [P] for the same reason.
- T027–T028 (US3 tests) are [P] for the same reason.
- T032–T034 (Polish) are [P] — distinct files (`test` run output, `DEVELOPMENT.md`, `CHANGELOGS.MD`).

---

## Parallel Example: User Story 1

```bash
# Launch all US1 tests together (all extend the same new file, but are independent cases):
Task: "Test: clean probe reaches reviewed with no envelope row, in migration/test/adversary-envelope.test.ts"
Task: "Test: flagged probe reaches needs-rework with adversary-flagged event, in migration/test/adversary-envelope.test.ts"
Task: "Test: inconclusive probe reaches needs-rework with adversary-inconclusive event, in migration/test/adversary-envelope.test.ts"
Task: "Test: gate-bound clean probe holds at pending-approval with adversary-probe-passed event, in migration/test/adversary-envelope.test.ts"
Task: "Test: gate-bound flagged probe routes to needs-rework, in migration/test/adversary-envelope.test.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1 (confirm #216 dependency) and Phase 2 (envelope primitives).
2. Complete Phase 3 (US1): the adversary-agent checkpoint itself, wired into `approveArtifactWithEvidence`.
3. **STOP and VALIDATE**: run quickstart.md Scenarios 1, 2, 7, 8 — the checkpoint routes correctly on its own, even before remediation reads its output.
4. This is a legitimate MVP: even without US2, an operator reading raw event/context records already gets the adversarial signal — US2 only automates carrying it into remediation's own text.

### Incremental Delivery

1. Setup + Foundational → primitives ready.
2. US1 → the checkpoint exists and routes correctly (MVP).
3. US2 → the finding automatically reaches the next remediation attempt.
4. US3 → the fail-open/fail-closed guarantee is explicitly locked in by tests and a doc comment.
5. Polish → quickstart validated end-to-end, docs/changelog updated, `recordApprovalDecision` confirmed untouched.

---

## Notes

- [P] tasks = different files or independent test cases; verify before assuming true parallel safety on shared files.
- [Story] label maps task to specific user story for traceability.
- This feature is spec/plan/tasks-only per the originating issue's scope note (see spec.md Assumptions) — no `speckit-implement` run is expected as part of this decomposition; the tasks above are written so a future implementer (once #216 lands) can execute them directly.
- Commit after each task or logical group.
- Avoid: vague tasks, same-file conflicts beyond what's noted above, cross-story dependencies that break independence.
