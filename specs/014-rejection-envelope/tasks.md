---

description: "Task list template for feature implementation"
---

# Tasks: Rejection Reason Envelope for the Next Remediation Attempt

**Input**: Design documents from `/specs/014-rejection-envelope/`

**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/registry-commands.md, quickstart.md

**Tests**: Included — the codebase's existing convention (`migration/test/approval-gate.test.ts`, `migration/test/approve-command.test.ts`) is to cover registry-command behavior with Vitest/node tests, and this feature's fail-open/non-clobber/latest-wins guarantees are exactly the kind of behavior that convention exists to lock down.

**Organization**: Tasks are grouped by user story (US1 = P1, US2 = P2) per spec.md.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2)

## Path Conventions

Single project (per plan.md): registry backend under `migration/registry/`, tests under `migration/test/`, agent procedure docs under `package/agents/`.

---

## Phase 1: Setup

**Purpose**: No new project scaffolding is needed — this feature is additive inside `migration/registry` and `package/agents`, both of which already exist and already build/test the way this feature's changes will.

- [ ] T001 Confirm the local build/test loop works before changing anything: `cd migration/registry && npm run build` (or the repo's existing build script) and `npx vitest run migration/test/approval-gate.test.ts migration/test/approve-command.test.ts` to establish a clean baseline.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The reserved-key envelope read/write plumbing that both user stories build on. Must land before either story's tests can pass.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [ ] T002 Add a single exported reserved-key constant (e.g. `REJECTION_ENVELOPE_AGENT = "rejection-envelope"`) in `migration/registry/commands/context.ts`, so the write side and read side share one source of truth and can never drift (data-model.md, contracts/registry-commands.md).
- [ ] T003 Implement `writeRejectionEnvelope(db, artifactId, reason)` in `migration/registry/commands/context.ts`: synthesize a minimal file with a `## Summary` section wrapping `reason` verbatim, write it to `migration/artifacts/<slug>/context/rejection-envelope.md` (reusing `idToSlug`), and upsert the `agent_context` row for `(artifactId, REJECTION_ENVELOPE_AGENT)` using the same insert/upsert SQL shape `writeContext` already uses (contracts/registry-commands.md). Depends on T002.
- [ ] T004 Implement `getRejectionEnvelope(db, artifactId)` in `migration/registry/commands/context.ts` as a thin wrapper over the existing `getContext(db, artifactId, REJECTION_ENVELOPE_AGENT)`, returning `null` when the response `form` is `"none"` and the extracted text otherwise (contracts/registry-commands.md). Depends on T002.
- [ ] T005 [P] Write unit tests for `writeRejectionEnvelope`/`getRejectionEnvelope` round-tripping in a new `migration/test/rejection-envelope.test.ts`: write then read returns the exact reason text (FR-009); reading an artifact with no envelope returns `null`/`form: "none"` (FR-007). Depends on T003, T004.

**Checkpoint**: Envelope read/write primitives exist and are independently tested — user story work can now begin.

---

## Phase 3: User Story 1 - The next attempt sees why it was rejected (Priority: P1) 🎯 MVP

**Goal**: A rejection reason recorded through the approval gate automatically reaches remediation's carry-forward text for the next attempt, with no manual step and no change to behavior when there is no reason to carry.

**Independent Test**: Reject an artifact through the approval gate with a specific reason; run remediation on the resulting needs-rework artifact; confirm the reason it surfaces matches what the operator gave, without querying `approval_decisions` directly (spec.md US1 Independent Test).

### Tests for User Story 1

- [ ] T006 [P] [US1] Add a test in `migration/test/rejection-envelope.test.ts` (or a new `migration/test/approval-rejection-envelope.test.ts`) asserting that calling `recordApprovalDecision` with `decision: "rejected"` and a reason results in `getRejectionEnvelope` returning that exact reason for the artifact (FR-001).
- [ ] T007 [P] [US1] Add a test asserting that calling `recordApprovalDecision` with `decision: "approved"` does NOT write or alter any rejection-envelope entry (FR-001 scope boundary — approvals never populate the envelope).
- [ ] T008 [P] [US1] Add a test asserting the envelope write is fail-open: simulate a filesystem failure in the envelope write path (e.g. mock/stub `writeRejectionEnvelope` to throw) and confirm `recordApprovalDecision` still inserts the `approval_decisions` row and transitions the artifact to `needs-rework` (FR-008, research.md "fail-open write, fail-closed decision").

### Implementation for User Story 1

- [ ] T009 [US1] Wire `writeRejectionEnvelope` into `recordApprovalDecision` in `migration/registry/commands/approval.ts`: after the existing `needs-rework` transition, when `opts.decision === "rejected"`, call `writeRejectionEnvelope(db, opts.artifactId, opts.reason)` inside a `try { ... } catch { /* fail open */ }` block, per contracts/registry-commands.md. Depends on T003.
- [ ] T010 [US1] Add an explicit step to `package/agents/remediation-agent.agent.md`'s Procedure, immediately before recovery action **B (Send back one step)**: run `node migration/registry/dist/cli.js get-context --id "<id>" --agent rejection-envelope` and, when it returns a reason (not the `form: "none"` fallback), fold it into the `--reason`/`--summary` text passed to the existing `set-artifact-status --status planned` and `append-event --type remediated` calls in that same section (contracts/registry-commands.md, FR-006).
- [ ] T011 [US1] Update the Guardrails or Recovery goals section of `package/agents/remediation-agent.agent.md` with one line noting that the rejection-reason carry-forward is best-effort context, not a substitute for reading `get-events`/current evidence — keeps the existing "escalate when ambiguous" posture intact rather than over-trusting the envelope.

**Checkpoint**: User Story 1 is fully functional and independently testable — reject with a reason, run remediation, confirm the reason appears in the requeue text; reject with no downstream remediation run yet, confirm nothing errors.

---

## Phase 4: User Story 2 - A rejection reason is distinguishable and non-destructive (Priority: P2)

**Goal**: The rejection envelope never collides with or overwrites context another agent wrote for the same artifact, is clearly identifiable as a rejection reason on read, and always reflects only the most recent rejection.

**Independent Test**: Write context for an artifact via the existing `write-context` flow, then reject that same artifact with a reason; confirm both the prior context and the new rejection reason are separately retrievable afterward (spec.md US2 Independent Test).

### Tests for User Story 2

- [ ] T012 [P] [US2] Add a test in `migration/test/rejection-envelope.test.ts` asserting that writing context for an artifact under a real agent key (e.g. `context-agent`) via `writeContext`, then rejecting that artifact with a reason via `recordApprovalDecision`, leaves the `context-agent` row's `file_path`/`summary` unchanged (FR-003).
- [ ] T013 [P] [US2] Add a test asserting that rejecting the same artifact twice with two different reasons results in `getRejectionEnvelope` returning only the second (most recent) reason — the first is no longer surfaced via this path (FR-004).
- [ ] T014 [P] [US2] Add a test asserting `getRejectionEnvelope`'s result is read from the reserved `rejection-envelope` key specifically — i.e. `getContext(db, id, "rejection-envelope")` and `getContext(db, id, "context-agent")` (or any other real agent) never return each other's content, even when both exist for the same artifact simultaneously (FR-002).

### Implementation for User Story 2

- [ ] T015 [US2] Code-review pass over T003's `writeRejectionEnvelope`: confirm the upsert `WHERE`/`ON CONFLICT` clause is scoped to `(artifact_id, agent)` with `agent = REJECTION_ENVELOPE_AGENT` and cannot be reached with any other agent value — if T003 already satisfies this by construction (reusing the existing `agent_context` upsert), this task is a verification step, not new code.

**Checkpoint**: Both user stories are independently functional — US1's carry-forward behavior and US2's non-clobbering/distinguishability guarantees are both covered by passing tests.

---

## Phase 5: Polish & Cross-Cutting Concerns

**Purpose**: Final validation and documentation tidy-up affecting both stories.

- [ ] T016 [P] Run the full `migration/test/` suite (not just the new/touched files) to confirm no regression in existing approval-gate, context, or evidence tests: `npx vitest run migration/test/`.
- [ ] T017 Execute `specs/014-rejection-envelope/quickstart.md` Scenarios 1-4 end to end against a local registry DB, confirming each "Expected" outcome.
- [ ] T018 [P] Re-read `specs/014-rejection-envelope/spec.md` Functional Requirements (FR-001 through FR-009) against the finished implementation and confirm each is met; note any gap found back into this tasks.md before considering the feature done.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately.
- **Foundational (Phase 2)**: Depends on Setup completion — BLOCKS both user stories.
- **User Story 1 (Phase 3)**: Depends on Phase 2. No dependency on US2.
- **User Story 2 (Phase 4)**: Depends on Phase 2. Its tests (T012-T014) exercise the same `writeRejectionEnvelope`/`getRejectionEnvelope` primitives US1 wires up in T009, so in practice T009 should land before T012-T014 are run (though the code being tested is Phase 2's, not US1's) — sequence US1 before US2 if working solo.
- **Polish (Phase 5)**: Depends on both user stories being complete.

### Within Each User Story

- Tests (T006-T008, T012-T014) should be written and observed failing before their corresponding implementation tasks, per the codebase's existing test-first convention (Constitution V).
- US1: T009 (write-side wiring) before T010-T011 (remediation-agent read-side), since the read side has nothing to read until the write side exists.

### Parallel Opportunities

- T005 (Phase 2 tests) can run in parallel with nothing else in Phase 2 — it depends on T003+T004 both being done.
- T006, T007, T008 (US1 tests) are independent of each other and can be written in parallel.
- T012, T013, T014 (US2 tests) are independent of each other and can be written in parallel, and can be written in parallel with T006-T008 since both sets exercise the Phase-2 primitives from different angles.
- T016 and T018 in Polish can run in parallel with each other.

---

## Parallel Example: User Story 1

```bash
# Launch all US1 tests together:
Task: "Add rejection-writes-envelope test in migration/test/rejection-envelope.test.ts"
Task: "Add approval-never-writes-envelope test in migration/test/rejection-envelope.test.ts"
Task: "Add fail-open-on-write-failure test in migration/test/rejection-envelope.test.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (baseline build/test check).
2. Complete Phase 2: Foundational (reserved key + write/read primitives + their own tests).
3. Complete Phase 3: User Story 1 (wire into `recordApprovalDecision`, add the remediation-agent read/carry-forward step).
4. **STOP and VALIDATE**: run quickstart.md Scenarios 1-3 by hand.
5. This is the shippable MVP — the proposal's core ask (#216) is satisfied at this point.

### Incremental Delivery

1. Setup + Foundational → primitives ready and unit-tested.
2. Add User Story 1 → reject-then-remediate flow works end to end → this is the MVP.
3. Add User Story 2 → non-clobber and latest-wins guarantees locked down with tests → hardens US1 rather than adding new user-facing behavior.
4. Polish → full-suite regression check + quickstart validation + FR-by-FR review.

## Notes

- [P] tasks = different files or independent assertions in the same new test file, no dependencies between them.
- [Story] label maps task to specific user story for traceability.
- Both user stories share the same Phase 2 primitives by design — this feature is small enough that Foundational carries most of the actual new code, and US1/US2 are primarily "wire it in" and "prove it doesn't break things" respectively.
- Out of scope for all tasks above (per spec.md Assumptions / research.md): no change to `approval_decisions` schema, no new database table, no `migration-agent.agent.md` changes, no envelope expiry/consumed-marking, no automated-arbiter (`rejectArtifactWithEvidence`) rejection path.
