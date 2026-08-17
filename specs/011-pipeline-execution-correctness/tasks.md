# Tasks: Fix Pipeline Execution Correctness (Onboarding Hardening, Wave 4)

**Input**: Design documents from `/specs/011-pipeline-execution-correctness/` (`plan.md`, `spec.md`)

**Prerequisites**: `plan.md` (required, present), `spec.md` (required, present). No `research.md`, `data-model.md`, or `contracts/` exist for this feature — plan.md's "Technical Approach Per User Story" and "Testing Strategy" sections serve as the equivalent design detail.

**Tests**: Tests are explicitly requested. Constitution Principle V ("Tests Before Production Code") and NFR-003 require each of the three fixes to be covered by new `migration/test/*` regression suites, written before/alongside the fix. Principle I ("Exit code zero is not completion evidence") and Principle III ("Claims MUST be recoverable without human intervention... release work back to the pool") govern the runtime-enforcement assertions in US1 and US3's tests respectively; Principle VI ("Fail-Closed Automation") governs US3's escape-hatch assertion. Every test task below MUST be written and confirmed failing (for the specific case under test) before its paired implementation task begins.

**Organization**: Tasks are grouped by user story (US1/US2/US3, all Priority P1) to enable independent implementation and testing of each story. Per `plan.md`'s "MVP vs Incremental Boundaries", **all three stories together are the entire scope of this spec** — see Implementation Strategy below for what that means for delivery ordering.

**Source of truth for line numbers**: verified by direct read of `origin/dev` HEAD `078d15d` (this branch's base) on 2026-08-17; re-verify line numbers before editing if the base branch has moved.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: Which user story this task belongs to (US1, US2, US3); Setup/Foundational/Polish tasks carry no story label
- Every task includes exact repository file path(s)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Establish the regression baseline this feature's fixes are measured against. No new project scaffolding, dependencies, or directories are needed (`plan.md`: "No new directories; all changes land in the existing `migration/guildctl/` and `migration/registry/` modules").

- [ ] T001 Verify baseline: from `migration/`, run `npm test` (`node --import tsx --test test/*.test.ts`, script defined in `migration/package.json` line 13) and confirm all existing suites — including `migration/test/cli-phase-aliases.test.ts`, `migration/test/registry-api-queries.test.ts`, and `migration/test/registry-schema-delta.test.ts` — pass on the unmodified branch. This is the "existing suites stay green" baseline that SC-004 and the regression guards in T004/T008/T012/T013 are checked against.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before ANY user story can be implemented.

**This phase is intentionally empty.** The three user stories touch fully disjoint areas (`migration/guildctl/cli.ts` for US1, `scripts/build-dist.mjs` + `GETTING-STARTED.md`/`setup.ts` for US2, `migration/registry/commands/artifacts.ts` for US3) and disjoint new test files (`cli-run-phase-exit-code.test.ts`, `registry-serve-ui-dir.test.ts`, `artifacts-release-pending.test.ts`), with no shared model, schema, or infrastructure change introduced by any of them (`plan.md` Constitution Check: "no schema change", "no new redaction path"). No task is required beyond T001's baseline check.

**Checkpoint**: Foundation ready — all three user story phases below may start immediately and in parallel with each other once T001 passes.

---

## Phase 3: User Story 1 - A failed pipeline phase exits non-zero (Priority: P1) — #122

**Goal**: `guildctl run [phase]` sets a non-zero process exit code when the phase throws or fails its own postcondition check, mirroring the existing `preflight`/`doctor` `process.exit(1)` behavior (cli.ts:180/195/237), without changing green-path exit codes.

**Independent Test** (spec.md): invoke the `run [phase]` action for a phase that fails its postcondition (e.g. an inventory fixture whose quality gate fails) and assert `process.exitCode !== 0` (or the spawned `cli.js` process exits non-zero); a passing phase must still exit `0`.

### Tests for User Story 1 ⚠️

> Write these tests FIRST; the failing-quality-gate case MUST fail against the current, unmodified `cli.ts` before T003 is implemented.

- [ ] T002 [P] [US1] Write failing tests in `migration/test/cli-run-phase-exit-code.test.ts` (NEW). Follow the spawn/invoke pattern from `migration/test/cli-phase-aliases.test.ts`. Cases:
  - (a) `guildctl run inventory` against a fixture workspace whose inventory quality gate fails (mirroring `migration/guildctl/commands/inventory.ts`'s own quality-gate fixture, which throws at its line 461) → assert the process/`process.exitCode` is non-zero, and stderr still contains `Inventory quality gate failed` (the existing diagnostic must be preserved, not replaced). **This case must fail today** (current `run [phase]` action at `migration/guildctl/cli.ts` lines 670–720 has no `try/catch`, so the rejection does not reliably set a non-zero exit).
  - (b) the same invocation against a passing inventory fixture → assert exit code `0` (green-path regression, FR-003/NFR-001). Should already pass today.
  - (c) regression guard (FR-004): `guildctl preflight` / `guildctl doctor` against a `verdict: fail` fixture still exit non-zero, proving cli.ts:180/195/237 are untouched. Should already pass today.

### Implementation for User Story 1

- [ ] T003 [US1] Implement the fix in `migration/guildctl/cli.ts`: wrap the `switch (phase) { … }` body (lines 671–719, inside `.action(async (phase, opts) => { … })` at line 670) in `try { switch (phase) { … } } catch (err) { process.stderr.write(String(err?.message ?? err) + "\n"); process.exitCode = 1; }`. Use `process.exitCode = 1` (not `process.exit(1)`) so already-scheduled stdout/stderr writes flush before exit (FR-002, NFR-001). Leave the `case undefined:` branch (line 713, `printNextSteps(db())`) and the `default:` branch (lines 716–718, existing `process.stderr.write(...)` + `process.exit(1)` for an unknown phase name) exactly as-is — they are inside the wrapped switch but neither throws, so behavior for both is unchanged. Depends on T002 (test must exist and fail first).

- [ ] T004 [US1] Verify: from `migration/`, run `npm test` and confirm `migration/test/cli-run-phase-exit-code.test.ts` passes (all three cases) and `migration/test/cli-phase-aliases.test.ts` remains green (SC-001, SC-004). Depends on T003.

**Checkpoint**: US1 is independently functional and testable — a failing `run [phase]` now exits non-zero; passing phases and the existing `preflight`/`doctor` paths are unchanged.

---

## Phase 4: User Story 2 - `registry serve` serves the built UI with no manual copy (Priority: P1) — #123

**Goal**: `npm run build:dist` packages the real build outputs — `migration/registry/dist`, `migration/guildctl/dist` (per `migration/tsup.config.ts`), and a built `migration/ui-dist` — instead of depending on the never-created `migration/dist`, so `migration/registry/dist/cli.js serve` works with no manual copy step; and `GETTING-STARTED.md`/`setup.ts` document the real CLI path (`migration/registry/dist/cli.js`) instead of the non-existent `migration/dist/registry/cli.js`. `migration/registry/commands/serve.ts`'s `UI_DIR` (line 34) is already correct for the shipped bundle — confirmed by a live smoke test (`node migration/registry/dist/cli.js serve` against a built `migration/ui-dist/` returns `200` + real `index.html`) — and is **not modified** by this story.

**Independent Test** (spec.md): run `npm run build:dist` on a clean checkout, confirm it completes without `ENOENT`, and confirm the packaged `migration/registry/dist/cli.js serve` returns `200` at `/` with real `index.html` and real JSON at `/api/artifacts`, with no manual `ui-dist` copy; confirm `GETTING-STARTED.md`/`setup.ts` no longer reference `migration/dist/registry/cli.js`.

### Tests for User Story 2 ⚠️

> Write these tests FIRST; cases (a)–(d) MUST fail against the current, unmodified `scripts/build-dist.mjs` and docs before T006/T007 are implemented.

- [ ] T005 [P] [US2] Write failing tests in `migration/test/registry-serve-ui-dir.test.ts` (NEW). Reuse the registry test DB fixture pattern from `migration/test/registry-api-queries.test.ts`. Cases:
  - (a) run `npm run build:dist` (or a fixture-simulated equivalent invocation of `scripts/build-dist.mjs`'s `assembleTarball()`) on a clean checkout, assert it completes without `ENOENT`, and assert the packaged output contains `migration/registry/dist/cli.js`, `migration/guildctl/dist/cli.js`, and a built `migration/ui-dist/`. **Must fail today**: `assembleTarball()` (`scripts/build-dist.mjs` line 183) unconditionally copies `repoRoot/migration/dist`, which the `tsup`-based `build:dist` pipeline never creates, so the build throws `ENOENT` on a clean checkout (or ships stale content if a stray `migration/dist` exists) and never copies `migration/ui-dist` at all.
  - (b) start `serve` from the packaged `migration/registry/dist/cli.js`, `fetch` `http://127.0.0.1:<port>/`, assert `200` with the real `index.html` body — proving the packaging fix (not a `serve.ts` code change) makes the UI reachable.
  - (c) `fetch` `.../api/artifacts` against a populated temp/in-memory registry DB → assert `200` + JSON array of real rows.
  - (d) grep `GETTING-STARTED.md` and `setup.ts` and assert neither file references `migration/dist/registry/cli.js` or `migration/dist/guildctl/cli.js` — only `migration/registry/dist/cli.js` / `migration/guildctl/dist/cli.js`. **Must fail today**: `GETTING-STARTED.md` (lines ~65/131/186/188/189) and `setup.ts` (lines ~325/328/330) hardcode the non-existent `migration/dist/registry/cli.js` path.
  - (e) Edge Case regression guard: with no built UI, assert `serve`'s `/` route still surfaces its existing named error (serve.ts:224, `UI not built...`) rather than a silent 404 — confirms this story leaves `serve.ts`'s existing error-handling behavior untouched. Should already pass today.

### Implementation for User Story 2

- [ ] T006 [US2] Fix `scripts/build-dist.mjs`: in `assembleTarball()` (line 183), replace the unconditional copy of `repoRoot/migration/dist` with copies of the real tsup outputs, `migration/registry/dist` and `migration/guildctl/dist` (per `migration/tsup.config.ts`'s `outDir` settings). Add a UI build step (invoke `vite build` for `migration/ui`, e.g. via a new `build:ui` script or inline in the existing build chain near line 208–209 alongside the `tsup` invocation) so `migration/ui-dist` is built and copied into the packaged tarball. The UI build step MUST NOT be wrapped in a try/swallow — a failed `vite build` must propagate its non-zero exit through `build-dist.mjs`, the same way the existing `tsup` step does. This makes `npm run build:dist` complete without `ENOENT` on a clean checkout and ship a working UI (FR-005, FR-006). This is the required, end-to-end packaging fix — not an optional follow-through. Depends on T005.

- [ ] T007 [US2] Correct the documented built-CLI paths in `GETTING-STARTED.md` (lines ~65/131/186/188/189) and `setup.ts` (lines ~325/328/330): replace every `node migration/dist/registry/cli.js` reference with `node migration/registry/dist/cli.js`, and the `guildctl` equivalent (`migration/dist/guildctl/cli.js` → `migration/guildctl/dist/cli.js`), matching the real tsup output layout (FR-007). `migration/registry/commands/serve.ts` is NOT touched by this task — its `UI_DIR` (line 34) already resolves correctly for the shipped bundle; only the documented path to invoke that bundle was wrong. Independent file from T006 — can run in parallel with it. Depends on T005.

- [ ] T008 [US2] Verify: from the repo root, run `npm run build:dist` on a clean checkout and confirm it completes without `ENOENT`; from `migration/`, run `npm test` and confirm `migration/test/registry-serve-ui-dir.test.ts` passes (all cases) and no existing suite touching `serve.ts` or `artifacts.ts` regresses (SC-002, SC-004). Depends on T006, T007.

**Checkpoint**: US1 and US2 are both independently functional and testable — `npm run build:dist` now packages the real tsup outputs plus a built UI with no manual copy step, `serve.ts` is unchanged, and the documented CLI paths match what the build actually produces.

---

## Phase 5: User Story 3 - `registry release` accepts a claimed-but-pending "stuck" artifact (Priority: P1) — #124

**Goal**: `releaseTask` in `migration/registry/commands/artifacts.ts` accepts `status='pending' && claimed_by != NULL` as a releasable "stuck" state (the literal GETTING-STARTED.md crash-recovery trigger), in addition to the existing `in-progress` case, while still refusing `status='planned' && claimed_by IS NULL`.

**Independent Test** (spec.md): insert an artifact with `status='pending', claimed_by='crashed-agent'`, call `releaseTask(db, id, 'operator', 'crashed')`, and assert it returns an artifact with `claimed_by = NULL` and `status` reset to `claimed_from ?? 'planned'` (no throw).

### Tests for User Story 3 ⚠️

> Write these tests FIRST; case (a) MUST fail against the current, unmodified `artifacts.ts` before T010 is implemented.

- [ ] T009 [P] [US3] Write failing tests in `migration/test/artifacts-release-pending.test.ts` (NEW). Reuse the in-memory/temp-DB + schema-apply fixture pattern from `migration/test/registry-api-queries.test.ts` / `migration/test/registry-schema-delta.test.ts`. Cases:
  - (a) seed a temp/in-memory registry DB with an artifact row `status='pending', claimed_by='crashed-agent'`; call `releaseTask(db, id, 'operator', 'crashed')` (`migration/registry/commands/artifacts.ts`); assert: no throw; the returned artifact has `claimed_by === null`, `claimed_at === null`, `claimed_from === null`, `status === (original claimed_from ?? 'planned')`; and an `events` row with `type === 'status-changed'` and a `summary` mentioning `'crashed'` exists (FR-008, FR-010). **Must fail today**: `artifacts.ts` line 226 (`if (artifact.status !== "in-progress")`) unconditionally throws `RegistryError(1, ...)` for this exact case.
  - (b) regression (FR-009): an artifact with `status='in-progress'` and an active claim releases exactly as before (unchanged assertions against the existing claim-release path, lines 232–253). Should already pass today.
  - (c) still refused (FR-009): an artifact with `status='planned'` and `claimed_by IS NULL` still throws `RegistryError` — the widening must not turn release into a no-op-safe call for never-claimed artifacts. Should already pass today.
  - (d) audit-trail / injection guard (Edge Cases, FR-010): call `releaseTask` with a `reason` containing a SQL metacharacter (e.g. `"crashed'; DROP TABLE artifacts; --"`) against the pending-claimed fixture from (a); assert the `artifacts` and `events` tables are intact afterward (reason flows through the existing parameterized `INSERT`/`UPDATE`, lines 240–252, not string-concatenated SQL).

### Implementation for User Story 3

- [ ] T010 [US3] Implement the guard-widening fix in `migration/registry/commands/artifacts.ts` `releaseTask` (lines 215–255): change the initial lookup at lines 222–224 (`SELECT status FROM artifacts WHERE id = ?`) to also select `claimed_by` (or reuse the full-row fetch already performed later at lines 233–235), then widen the guard currently at line 226 (`if (artifact.status !== "in-progress")`) to a two-branch check:
  - `status === "in-progress"` → unchanged, proceeds to the existing claim-release branch (lines 232–253).
  - `status === "pending" && claimed_by !== null` → new: route through the same clear-claim/reset-status/write-event logic as the `in-progress` branch (clear `claimed_by`/`claimed_at`/`claimed_from`, reset `status` to `claimed_from ?? "planned"`, write the same parameterized `INSERT INTO events (...) VALUES (lower(hex(randomblob(8))), ?, 'status-changed', ?, ?)` from lines 249–252) using the operator's `reason` (FR-010).
  - Anything else (notably `status === "planned" && claimed_by IS NULL`) → unchanged, still throws `RegistryError(1, ...)`; update the message (currently line 229, `Cannot release "<id>": status is "<status>", expected "in-progress".`) to name both accepted states, e.g. `expected "in-progress" or "pending" with an active claim.` (FR-009).
  Depends on T009 (test must exist and fail first).

- [ ] T011 [US3] Document the intentionally-unwidened bulk path (Edge Cases #124, no behavior change): in `migration/registry/commands/artifacts.ts`, add a one-line comment above the `releaseClaimedArtifactsForOwner` bulk SQL filter (`WHERE status = 'in-progress' AND claimed_by = ?`, currently lines 268–269) stating that this filter is intentionally left scoped to `in-progress` only and is NOT widened to `pending` — the bulk owner-release path reassigns a *live* agent's active claims, not the single-artifact crash-recovery flow `releaseTask` (T010) now serves. Same file as T010 — sequential, not parallel. Depends on T010.

- [ ] T012 [US3] Verify: from `migration/`, run `npm test` and confirm `migration/test/artifacts-release-pending.test.ts` passes (all cases) and no existing suite touching `releaseTask`/`releaseClaimedArtifactsForOwner` regresses (SC-003, SC-004). Depends on T010, T011.

**Checkpoint**: All three user stories are now independently functional and testable — US1's exit-code propagation, US2's UI-serving fix, and US3's stuck-release fix each pass their own regression suite without affecting the other two.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Confirm all three fixes hold together and the operator-facing documentation stays accurate.

- [ ] T013 Run the full `migration/` regression suite (`npm test` in `migration/`, all of `test/*.test.ts`) once T004, T008, and T012 have each individually passed, confirming SC-001 through SC-004 hold simultaneously with no cross-story interaction (e.g. US1's `try/catch` around `run [phase]` does not mask or alter US2/US3-relevant error paths elsewhere in `migration/guildctl/cli.ts`). Depends on T004, T008, T012.

- [ ] T014 [P] Cross-check `GETTING-STARTED.md`'s documented recovery/monitoring instructions against the actual behavior shipped in this feature: confirm the "Agent left a file stuck → release" instruction (US3, T010) and the "Monitor progress" `serve` instructions, including the corrected `node migration/registry/dist/cli.js serve` path (US2, T006/T007), match the real commands. Update `GETTING-STARTED.md` only if a further discrepancy is found beyond what T007 already fixed; otherwise this task is a no-op confirmation. Independent file from T013 — can run in parallel.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately (T001).
- **Foundational (Phase 2)**: Empty — depends only on Setup (T001). Does not block anything beyond what T001 already unblocks.
- **User Stories (Phase 3, 4, 5)**: All depend only on T001 (Setup). The three stories touch disjoint files and can proceed fully in parallel, or sequentially in priority order (all are P1; spec.md's stated risk ordering is US1 > US2 > US3 — see Implementation Strategy).
- **Polish (Phase 6)**: Depends on all three user story phases being complete (T004, T008, T012).

### User Story Dependencies

- **User Story 1 (#122)**: Can start after T001. No dependency on US2 or US3.
- **User Story 2 (#123)**: Can start after T001. No dependency on US1 or US3.
- **User Story 3 (#124)**: Can start after T001. No dependency on US1 or US2.

### Within Each User Story

- Test task MUST be written and observed failing (for the specific new-behavior case) before the implementation task begins (Constitution Principle V).
- Within US3, the later implementation task (T011 after T010) touches the *same file* as the preceding task and is therefore sequenced, not parallel, even though both carry the same [Story] label. Within US2, T006 (`scripts/build-dist.mjs`) and T007 (`GETTING-STARTED.md`/`setup.ts`) touch different files and can run in parallel.
- Each story's final task is a `npm test` verification run scoped to (at minimum) that story's new suite plus the pre-existing suites touching the same file(s).

### Same-File Sequencing (explicit)

- `migration/guildctl/cli.ts`: T003 only (single edit; no other task in this feature touches this file).
- `scripts/build-dist.mjs`: T006 only.
- `GETTING-STARTED.md` / `setup.ts`: T007 only.
- `migration/registry/commands/artifacts.ts`: T010 → T011 (sequential, same file).
- `migration/test/cli-run-phase-exit-code.test.ts`: T002 only.
- `migration/test/registry-serve-ui-dir.test.ts`: T005 only.
- `migration/test/artifacts-release-pending.test.ts`: T009 only.

### Parallel Opportunities

- T002 [US1 test], T005 [US2 test], and T009 [US3 test] touch three different new files and depend only on T001 — all three can be written in parallel.
- T006 (`scripts/build-dist.mjs`) and T007 (`GETTING-STARTED.md`/`setup.ts`) are different files and can be done in parallel once T005 exists and fails.
- T013 and T014 in Polish touch different files (`migration/` test run vs. `GETTING-STARTED.md`) and can run in parallel once their shared prerequisite (all three stories' verify tasks) is met.
- The three user story phases (3, 4, 5) as a whole can be staffed and executed in parallel by different people, since they share no file.

---

## Parallel Example: Kicking Off All Three Stories

```bash
# After T001 (Setup baseline) passes, launch all three stories' test-writing tasks together:
Task: "T002 [US1] Write failing tests in migration/test/cli-run-phase-exit-code.test.ts"
Task: "T005 [US2] Write failing tests in migration/test/registry-serve-ui-dir.test.ts"
Task: "T009 [US3] Write failing tests in migration/test/artifacts-release-pending.test.ts"
```

---

## Implementation Strategy

### MVP Scope

Per `plan.md`'s "MVP vs Incremental Boundaries": **all three user stories are P1 and together constitute the entire MVP for this spec** — "There is no incremental/deferred slice — US1, US2, and US3 together constitute the MVP, gated by SC-001..SC-004." Unlike a typical multi-priority feature where US1 alone is a shippable MVP and US2/US3 are deferrable increments, this feature's three sub-issues (#122, #123, #124) were scoped together as the entirety of tracking issue #133, and SC-004 requires all three regression suites to pass together as the completion gate.

### Recommended Delivery / Review Order (risk sequencing, not scope deferral)

Because the three stories are file-disjoint and independently testable, they may be implemented in any order or in parallel. For staged code review and risk management, follow spec.md's stated priority rationale:

1. **US1 (#122) first** — "the most dangerous of the three because it hides failure broadly" (spec.md): a `0` exit on a failed phase silently breaks every `&&`-chained and CI caller.
2. **US2 (#123) second** — blocks the documented "Monitor progress" workflow in GETTING-STARTED.md; deterministic, reproducible defect.
3. **US3 (#124) third** — blocks the documented crash-recovery escape hatch; strand-locks an operator who trusts the docs.

### Incremental Validation

1. Complete Setup (T001) → baseline established.
2. Complete US1 (T002–T004) → **STOP and VALIDATE**: `guildctl run inventory` against a failing fixture exits non-zero; a passing fixture still exits `0`.
3. Complete US2 (T005–T008) → **STOP and VALIDATE**: `npm run build:dist` on a clean checkout completes without `ENOENT` and its packaged `serve` returns `200` at `/` and real JSON at `/api/artifacts`, with no manual `ui-dist` copy.
4. Complete US3 (T009–T012) → **STOP and VALIDATE**: `release --id "<id>" --agent operator --reason "crashed"` against `status='pending', claimed_by='crashed-agent'` succeeds.
5. Complete Polish (T013–T014) → full-suite confirmation (SC-004) and documentation cross-check.
6. Only once all three stories and Polish are complete is this feature (#133) done — none of the three is independently "the deliverable" per plan.md's stated MVP framing, even though each is independently testable along the way.

---

## Notes

- [P] tasks touch different files and have no dependency on an incomplete task.
- [Story] label maps each task to its user story (US1/US2/US3) for traceability; Setup/Foundational/Polish tasks carry no story label per the task-format rules.
- Every implementation task (T003, T006, T007, T010, T011) is preceded in its phase by a test task (T002, T005, T009) that must exist and fail (for the new-behavior case) first — Constitution Principle V.
- This task list makes **no source changes itself** — it is a planning artifact. Do not run `/speckit.implement` or `/speckit.analyze` from this conversation; task execution is a separate, later step.
- Avoid: vague tasks, same-file conflicts marked [P], cross-story dependencies that would break independent testability.
