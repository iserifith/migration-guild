# Tasks: Characterization Test Automation

**Input**: Design documents from `/specs/002-characterization-test-automation/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md), `.specify/memory/constitution.md`

**Tests**: REQUIRED, not optional. Constitution Principle V (*Tests Before Production Code*) is
non-negotiable, and this feature touches the evidence gate and Arbiter-consumed evidence — a
surface the constitution explicitly names as requiring `migration/test` regression coverage.
plan.md's Constitution Check records this. Every phase below writes its tests before its
production code.

**Organization**: Tasks are grouped by user story (US1–US3 from spec.md) so each story can be
implemented, tested, and delivered independently.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Which user story this task belongs to (US1–US3); absent on Setup, Foundational, Polish
- Every task names its exact repository file path

## Path Conventions

This repository is the source of the Migration Guild kit. All work for this feature is under
`migration/` (registry + guildctl runtime, repo-only source of truth — no `package/` mirror
applies to this feature, since it touches no stack-pack or workspace-template content):

- `migration/registry/` — storage/domain library (types, evidence commands).
- `migration/guildctl/` — CLI (commands, `cli.ts`).
- `migration/test/` — flat suite glob `test/*.test.ts`; a shared helper file must not itself end
  in `.test.ts`.

## Scope Guard

Confirmed scope: issue **#58**, corrected per the owner's review comments captured in
spec.md's Assumptions section. First slice only — captures already-passing unit/invocation-
level legacy test seams; runtime-dependent seams (HTTP, DB) are explicitly out of scope (see
spec.md Edge Cases and Assumptions). Excluded: automatic seam discovery per stack (research.md
Decision 5), a second/parallel freshness mechanism (forbidden by FR-009), and any change to
other in-flight evidence proposals (e.g. the already-merged evidence-freshness/drift-gate
foundation from issue #54, which this feature consumes but does not modify).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: establish the pre-feature baseline so later failures are attributable to this
feature, not pre-existing state.

- [X] T001 Install workspace dependencies and build the runtime from the repository root per quickstart.md conventions: `npm --prefix migration install`
- [X] T002 Record the pre-feature `npm test` baseline (`cd migration && npm test`) before any source change, and note any pre-existing failure so it is never attributed to this feature

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the evidence-type extension and shared fixture-file I/O helpers every user story
consumes. Placing them here is what keeps US1–US3 independently deliverable.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T003 Write the failing foundational regression test first: `migration/test/evidence-characterization.test.ts` asserting `"characterization-fixture"` is accepted as an `EvidenceType`, is present in `EXECUTABLE_EVIDENCE_TYPES`, and that `addAcceptanceEvidence()` rejects a caller-asserted `"characterization-fixture"` row the same way it already rejects a caller-asserted `"runtime"` row (data-model.md, research.md Decision 1)
- [X] T004 Add `"characterization-fixture"` to the `EvidenceType` union in `migration/registry/types.ts` (data-model.md § New enum member)
- [X] T005 Add `"characterization-fixture"` to `EXECUTABLE_EVIDENCE_TYPES` in `migration/registry/commands/evidence.ts`, and extend the existing `evidenceType === "runtime"` guard in `addAcceptanceEvidence()` to also reject a caller-asserted `"characterization-fixture"` type (data-model.md § call sites; research.md Decision 1)
- [X] T006 [P] Create the shared fixture-file I/O helper module `migration/registry/commands/fixture-file.ts` exporting `writeFixtureFile()` (writes `{seam, input, output, capturedAt, contentSha256}` JSON per data-model.md § Non-persisted shape: Fixture file, computing `contentSha256` as SHA-256 of the serialized `output`) and `readFixtureFile()`, under `<evidence.output_dir>/characterization/<evidence_id>.json` (research.md Decision 2)

**Checkpoint**: evidence-type plumbing and fixture-file I/O exist. User story implementation can now begin.

---

## Phase 3: User Story 1 - Capture a behavioral snapshot from legacy code (Priority: P1) 🎯 MVP

**Goal**: an operator can run fixture capture against a legacy artifact with an already-passing
test seam and get back a `characterization-fixture` evidence record containing the seam, the
concrete input/output, and a content hash — or, if no runnable seam exists, an explicit skip
with a stated reason rather than a fabricated or silently-failed capture.

**Independent Test**: run `guildctl capture-fixture` against an artifact with a passing unit
test seam (quickstart.md Scenario 1); verify a `characterization-fixture` evidence row exists
with the expected fields. Run it again against a seam that requires a live runtime
(quickstart.md Scenario 2); verify capture is skipped with a reason and no fixture row is added.

### Tests for User Story 1

- [X] T007 [P] [US1] Write failing test in `migration/test/evidence-characterization.test.ts` (or split into `migration/test/capture-fixture-cli.test.ts` if the shared file grows large) for `runCaptureFixtureCommand()` success path: given an artifact and a passing seam command, asserts a `characterization-fixture` evidence row is recorded with `pass: 1`, `command` set to the seam invocation, `output_path` pointing at a readable fixture file, and `content_sha256` populated
- [X] T008 [P] [US1] Write failing test for the skip path: given a seam command that exits non-zero (simulating a runtime-dependent seam that can't run), asserts no `characterization-fixture` evidence row is added and a skip result with a `reason` is returned (spec FR-005, Edge Cases)
- [X] T009 [P] [US1] Write failing test for re-capture: running capture twice against the same artifact/seam produces two independent evidence rows, neither overwritten (spec FR-010, Story 1 Scenario 4)

### Implementation for User Story 1

- [X] T010 [US1] Implement `runCaptureFixture()` in new file `migration/guildctl/commands/capture-fixture.ts`, modeled on `migration/guildctl/commands/verify.ts`: resolve workspace root/config, `startRun` (phase `"capture-fixture"`), create a run operator credential, execute the seam `--command`, and on success write the fixture file via `writeFixtureFile()` (T006) and call `addAcceptanceEvidence()`-equivalent tool-owned recording path with `evidence_type: "characterization-fixture"`, `pass: 1`; on failure, skip recording and return `{captured: false, reason}`; `finishRun` in both cases (contracts/cli-capture-fixture.md § Behavior)
- [X] T011 [US1] Register the `guildctl capture-fixture` command in `migration/guildctl/cli.ts` with `--artifact`, `--seam`, `--command`, `--json` options, following the existing `verify` command's registration pattern (contracts/cli-capture-fixture.md § Invocation)
- [X] T012 [US1] Implement human-readable and `--json` output formatting for both the captured and skipped cases in `migration/guildctl/commands/capture-fixture.ts` (contracts/cli-capture-fixture.md § Output)
- [X] T013 [US1] Add `--artifact`/db-existence error handling consistent with other `guildctl` commands (`assertDbExists`, `assertArtifactExists`) to `runCaptureFixture()`

**Checkpoint**: User Story 1 is fully functional and testable independently — `guildctl capture-fixture` produces real, inspectable evidence rows for capturable seams and skips cleanly for non-capturable ones.

---

## Phase 4: User Story 2 - Migrate consults the captured fixture as its behavioral target (Priority: P2)

**Goal**: the Migrate phase can retrieve a captured fixture for an artifact and compare
candidate migrated output against it, getting back a match/mismatch result with a diff on
mismatch — while an artifact with no captured fixture is not blocked.

**Independent Test**: call `compareToFixture()` against an artifact with a captured fixture
(quickstart.md Scenario 3) with output identical to the fixture (expect `match: true`) and with
different output (expect `match: false` plus a `diff`); call it against an artifact with no
fixture and confirm the resulting error is distinguishable and treated as non-blocking.

### Tests for User Story 2

- [X] T014 [P] [US2] Write failing test in `migration/test/evidence-characterization.test.ts` for `compareToFixture()`: matching candidate output returns `{match: true}`; differing output returns `{match: false, diff}` with a non-empty diff description (contracts/lib-compare-to-fixture.md § Behavior)
- [X] T015 [P] [US2] Write failing test for the no-fixture case: `compareToFixture()` against an artifact with no `characterization-fixture` evidence throws a typed, distinguishable error (not a generic error) that a caller can branch on to proceed non-blocked (spec FR-007; contracts/lib-compare-to-fixture.md § Behavior step 2)

### Implementation for User Story 2

- [X] T016 [US2] Implement `compareToFixture(db, artifactId, candidateOutput)` in `migration/registry/commands/evidence.ts`: look up the latest `characterization-fixture` evidence row for the artifact (reusing the same "latest executable evidence" query shape `checkEvidenceFreshness()` uses), load its fixture file via `readFixtureFile()` (T006), deep-equal compare against `candidateOutput`, and return `{match: true}` or `{match: false, diff}` (contracts/lib-compare-to-fixture.md § Signature, § Behavior)
- [X] T017 [US2] Throw a typed `RegistryError` from `compareToFixture()` when no `characterization-fixture` evidence exists for the artifact, distinct from a mismatch result, per contracts/lib-compare-to-fixture.md § Behavior step 2

**Checkpoint**: User Stories 1 AND 2 both work independently — captured fixtures can be compared against candidate Migrate output, and absence of a fixture never blocks Migrate.

---

## Phase 5: User Story 3 - Arbiter gates on fixture evidence (Priority: P3)

**Goal**: a characterization-fixture comparison result is recorded as evidence the Arbiter's
existing evidence-gated approval decision can see on the same terms as any other evidence type,
and a stale fixture (legacy source changed since capture) is caught by the existing freshness
check with no new or different freshness rule.

**Independent Test**: record a comparison result as evidence for an artifact (quickstart.md
Scenario 4), confirm it appears in `guildctl evidence list` and is visible going into
`guildctl arbitrate`; then simulate a stale fixture (quickstart.md Scenario 5) and confirm
`checkEvidenceFreshness()` reports it stale using its existing content-hash rule.

### Tests for User Story 3

- [X] T018 [P] [US3] Write failing test asserting that recording a `compareToFixture()` result as a new `characterization-fixture` evidence row (with `pass` set from `match`, `output_excerpt` set from `diff` when present) makes it visible via `listAcceptanceEvidence()`/`guildctl evidence list` alongside other evidence types (spec FR-008; research.md Decision 4)
- [X] T019 [P] [US3] Write failing test asserting `checkEvidenceFreshness()` correctly identifies a `characterization-fixture` evidence row as stale when the underlying captured output's content hash no longer matches, using the existing content-hash/same-run rule already exercised for `runtime`/`static-check` evidence — no new freshness code path (spec FR-009; quickstart.md Scenario 5)
- [X] T020 [P] [US3] Write failing test asserting a failing (`pass: 0`) characterization-fixture comparison is visible in the evidence set an arbitration decision reads, and does not silently pass (spec Story 3 Scenario 2)

### Implementation for User Story 3

- [X] T021 [US3] Implement the comparison-recording path (e.g. `recordFixtureComparison()` in `migration/registry/commands/evidence.ts` or as part of the Migrate-phase caller in `migration/guildctl/commands/migrate.ts`, per research.md Decision 4): after calling `compareToFixture()` (T016), record its result as a new `characterization-fixture` evidence row via the tool-owned recording path (same as T010), with `pass` set from `match` and `output_excerpt` set from `diff` when present
- [X] T022 [US3] Verify (add regression coverage if not already implied by existing arbitration tests) that `migration/registry/commands/evidence.ts`'s arbitration evidence-reading path requires no new branch to include `characterization-fixture` rows — confirm `checkEvidenceFreshness()` and the evidence-listing functions it composes are already generic over `evidence_type` and need no code change beyond T004/T005

**Checkpoint**: all three user stories are independently functional — capture, Migrate-phase comparison, and Arbiter-visible evidence with correct freshness behavior.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: close out constitution and quickstart obligations that span all three stories.

- [X] T023 [P] Update `guildctl capture-fixture --help` / evidence-type CLI help text listing (e.g. in `migration/guildctl/cli.ts`) to mention `characterization-fixture` for discoverability, without adding it to the `evidence add` `VALID_EVIDENCE_TYPES` allowlist (data-model.md § call sites; research.md Decision 1 — must remain rejected by `evidence add`)
- [X] T024 Run the full `migration/test` suite (`cd migration && npm test`) and confirm zero regressions against the T002 baseline
- [X] T025 Execute every scenario in `specs/002-characterization-test-automation/quickstart.md` end-to-end against a real (non-mocked) test workspace and confirm expected outputs match

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately.
- **Foundational (Phase 2)**: Depends on Setup completion — BLOCKS all user stories.
- **User Stories (Phase 3+)**: All depend on Foundational phase completion.
  - US1 has no dependency on US2/US3 and can ship alone as the MVP.
  - US2 depends on US1 existing (it reads `characterization-fixture` evidence US1 produces) but is independently testable once US1's capture path works, per quickstart.md Scenario 3.
  - US3 depends on US2's `compareToFixture()` (T016) to produce a result to record, but its Arbiter-visibility and freshness behavior are independently testable given a pre-recorded evidence row (quickstart.md Scenarios 4–5).
- **Polish (Phase 6)**: Depends on all three user stories being complete.

### Within Each User Story

- Tests MUST be written and FAIL before implementation (constitution Principle V).
- Foundational plumbing (evidence type, fixture-file I/O) before any story-specific logic.
- Story complete and its checkpoint validated before moving to the next priority.

### Parallel Opportunities

- T003 and T006 in Foundational can proceed in parallel once T004/T005 land (T006 has no
  dependency on the evidence-type extension itself, only on knowing the fixture-file shape from
  data-model.md).
- All tests within a story phase marked [P] (T007–T009, T014–T015, T018–T020) can run in
  parallel — they touch the same test file but assert independent behaviors, so write them
  together before any implementation task in that phase.
- T023 (Polish) is independent of T024/T025 and can run in parallel with them.

---

## Parallel Example: User Story 1

```bash
# Launch all tests for User Story 1 together:
Task: "Write failing test for capture success path in migration/test/evidence-characterization.test.ts"
Task: "Write failing test for capture skip path in migration/test/evidence-characterization.test.ts"
Task: "Write failing test for re-capture producing independent rows in migration/test/evidence-characterization.test.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup.
2. Complete Phase 2: Foundational (CRITICAL — blocks all stories).
3. Complete Phase 3: User Story 1.
4. **STOP and VALIDATE**: run quickstart.md Scenarios 1–2 against a real workspace.
5. `guildctl capture-fixture` is now usable standalone, independent of any Migrate/Arbiter integration.

### Incremental Delivery

1. Setup + Foundational → foundation ready.
2. Add US1 → validate independently → fixture capture is usable on its own (MVP).
3. Add US2 → validate independently → Migrate phase can consult fixtures as behavioral targets.
4. Add US3 → validate independently → Arbiter sees fixture-comparison evidence with correct freshness.
5. Polish → full regression pass + quickstart validation.

---

## Implementation Notes (deviations discovered while coding)

Two things the design docs got wrong or under-specified, corrected during implementation
rather than by going back and rewriting research.md/data-model.md after the fact:

1. **`evidence_type` is also CHECK-constrained at the SQL level**, not just in the TypeScript
   union — `registry_schema.sql`'s `acceptance_evidence` table has
   `CHECK (evidence_type IN (...))`. data-model.md's "no schema migration needed" claim (based
   on inspecting only `registry/db/schema.ts`, not `registry_schema.sql`) was itself an
   instance of the same kind of inaccuracy the owner's review comments corrected in the original
   proposal. SQLite cannot widen a CHECK constraint via `ALTER TABLE`, so
   `migration/registry/db/schema.ts` gained `ensureCharacterizationFixtureEvidenceType()`, which
   rebuilds `acceptance_evidence` (same columns and indexes, widened CHECK list) for any
   pre-existing database, guarded by inspecting `sqlite_master` so it's a no-op once applied.
   Covered by a dedicated regression test simulating an old-schema database.
2. **`characterization-fixture` was deliberately *not* added to `EXECUTABLE_EVIDENCE_TYPES`.**
   `getLatestExecutableEvidence()` (the function `canApproveArtifact` uses to find the evidence
   an approval is actually gated on) is hardcoded to `evidence_type = 'runtime'` in SQL, so
   adding a second type to that constant would not have changed arbitration eligibility — but it
   *would* have made `characterization-fixture` evidence usable as an explicit `--evidence` ID
   in `guildctl arbitrate --approve`, requiring it to carry `log_sha256` and HMAC `authenticity`
   the same way runtime evidence does. The constitution requires approval to gate specifically
   on verifier-generated *runtime* evidence; letting a second evidence type substitute for that
   would have been a bigger change than this feature's scope. Instead, characterization-fixture
   behaves like `static-check`: it is recorded, visible via `evidence list`/arbitration's
   evidence set (FR-008), and participates in `checkEvidenceFreshness()` (FR-009), but is not
   itself sufficient to satisfy approval eligibility. Also unlike `static-check`, the new
   freshness block does **not** require `run_id` to match the latest runtime evidence's
   `run_id` — a fixture is captured once against legacy code, typically in an earlier, unrelated
   run to when the migrated artifact is later verified, so same-run binding would make every
   fixture stale by construction. Only the content-hash check applies. This is documented inline
   in `evidence.ts` at the point it matters.

## Notes

- [P] tasks = different files or independent assertions, no dependencies.
- [Story] label maps task to specific user story for traceability.
- Each user story should be independently completable and testable.
- Verify tests fail before implementing (constitution Principle V).
- Commit after each task or logical group.
- Stop at any checkpoint to validate story independently.
- Avoid: a second freshness mechanism (FR-009), adding `characterization-fixture` to the
  `evidence add` allowlist (research.md Decision 1), and auto-discovering test seams
  (research.md Decision 5 — out of scope for this slice).
