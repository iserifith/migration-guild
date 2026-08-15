---

description: "Task list for feature 006-dependency-disposition"
---

# Tasks: Planner-Emitted Dependency Disposition Records

**Input**: Design documents from `/specs/006-dependency-disposition/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/ (registry-schema.md, cli-surface.md, disposition-pack-yaml.md), quickstart.md — all present and complete.

**Tests**: Included and sequenced before their implementation tasks. Constitution Principle V ("Tests Before Production Code") is flagged non-negotiable in plan.md's Constitution Check for this feature ("this feature changes Plan-phase control flow and a readiness gate, squarely inside §V's ... phase control flow MUST ship with regression tests"), and quickstart.md's "Regression coverage" section enumerates the required `migration/test/*.test.ts` additions this file sequences.

**Organization**: Phase 3 = US1 (P1), Phase 4 = US2 (P1), Phase 5 = US3 (P2). Spec lists US1 and US2 as tied P1; they are ordered US1 → US2 here because disposition records must exist (US1) before they can be confirmed/locked (US2), per plan.md's Summary and research.md §2/§5.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no unmet same-batch dependency)
- **[Story]**: US1, US2, or US3 — omitted for Setup/Foundational/Polish tasks
- Every task names exact repository file paths

---

## Phase 1: Setup

**Purpose**: Establish a clean baseline. No new npm dependency, no new top-level directory, no project scaffolding is required (plan.md Technical Context / Constraints) — this feature extends existing modules in place.

- [x] T001 Run `npm run build && npm run test` from the repository root and confirm both succeed on the current `dev`-derived branch tip, establishing the green baseline that Phase 2 onward must not regress.

**Checkpoint**: Baseline green. No project structure changes needed before Foundational work begins.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Registry schema and shared types that every user story's implementation code depends on.

**⚠️ CRITICAL**: No user story implementation task may start until T002–T004 are complete.

- [x] T002 [P] Write the schema-delta test in `migration/test/disposition-schema.test.ts`, mirroring `migration/test/registry-schema-delta.test.ts`'s PRAGMA-introspection approach: after `applySchema(db)`, assert `dependency_dispositions` exists with all columns and CHECK constraints from `specs/006-dependency-disposition/contracts/registry-schema.md` (`disposition IN ('keep','replace-with-native','inline')`, `status IN ('proposed','confirmed')`, `pending_disposition` CHECK, `library_name UNIQUE`), assert `dependency_disposition_history` exists with its `change_kind` CHECK, and assert indexes `idx_dependency_dispositions_status`, `idx_dependency_dispositions_pending`, `idx_dependency_disposition_history_library` exist. This test MUST fail until T003 lands.
- [x] T003 Add the `dependency_dispositions` and `dependency_disposition_history` `CREATE TABLE`/`CREATE INDEX` DDL verbatim from `specs/006-dependency-disposition/contracts/registry-schema.md` to `migration/registry_schema.sql` (new tables — no `ensureColumn` guard needed in `migration/registry/db/schema.ts` per the contract, since `CREATE TABLE IF NOT EXISTS` covers both fresh and existing databases). Makes T002 pass. (depends on T002)
- [x] T004 [P] Add `DependencyDisposition` and `DependencyDispositionHistoryEntry` TypeScript interfaces (fields per `specs/006-dependency-disposition/data-model.md` Entity 1 and Entity 2) to `migration/registry/types.ts`, following the existing `JvmAuditFinding`-style interface convention in that file.

**Checkpoint**: Schema exists and is typed. User story implementation can begin.

---

## Phase 3: User Story 1 — Every declared dependency gets a planner-emitted disposition record (Priority: P1) 🎯 MVP part 1

**Goal**: A deterministic collector plus a `propose-disposition` write path ensure every third-party library used by in-scope legacy artifacts gets exactly one queryable disposition record — no user diligence required for completeness (FR-001, FR-004, FR-012, SC-001).

**Independent Test**: quickstart.md Scenario 1 — run `inventory` then `plan` (with `GUILDCTL_AUTO_CONFIRM_DISPOSITIONS=1` and the other auto-approve vars set) against a fixture with a native-equivalent library, a minimal-use helper library, a keep-only library, and one declared-but-unused library; `list-dispositions` shows one row per library with the correct proposed disposition kind, including a scan-limitation note on the unused library.

### Tests for User Story 1

- [x] T005 [P] [US1] Write the stack-pack loader test in `migration/test/disposition-pack-yaml.test.ts` covering `specs/006-dependency-disposition/contracts/disposition-pack-yaml.md`'s validation rules: a valid `dependencies:` block (`manifest_globs`/`library_prefixes`/`native_equivalents`) parses correctly; an unknown top-level key inside `dependencies:` raises a load error naming the pack and key; an empty-string `manifest_globs` entry errors; a non-string-array `library_prefixes` value errors; a `native_equivalents` entry with an empty `native` errors; a `native_equivalents` key absent from `library_prefixes` produces a load-time WARNING (not an error); and a pack with no `dependencies:` block loads successfully with a degraded/empty result.
- [x] T006 [P] [US1] Write the collector test in `migration/test/disposition-collector.test.ts` covering: the library universe equals `dependency_findings` (grouped by `dependency_name`, MAX `current_version`) UNION regex-extracted manifest declarations; a declared-but-unused library still receives a row carrying a usage/scan-limitation note with disposition kind `keep` (spec edge case #1 — dead declarations default to `keep`; the non-keep decision belongs to the operator at confirmation, never to the collector); an unparseable manifest section produces a `scan_notes` limitation rather than failing the collector run (FR-012); a library present in the pack's `native_equivalents` seeds a `replace-with-native` proposal; a library with no pack mapping defaults to `keep` — never an invented replacement (spec edge case #2); and when two manifest declarations carry conflicting versions for one library, the collector resolves the locked target version per research.md §9 (MAX across findings/manifests) and records the conflict narrative in the proposal's `rationale` (FR-008).
- [x] T007 [P] [US1] Write the upsert/validation test in `migration/test/disposition-upsert.test.ts` covering: `upsertProposedDisposition` INSERTs when no row exists for `library_name` (`status='proposed'`, history `change_kind='propose'`); UPDATEs proposal fields in place when the existing row is `status='proposed'` (history `change_kind='refine'`); rejects `disposition='replace-with-native'` without `nativeReplacement`; rejects `disposition='inline'` without `inlineNote`; rejects an empty `rationale`; and `listDispositions` returns rows `ORDER BY library_name ASC`, filterable by `status` and `pendingOnly`.
- [x] T008 [P] [US1] Write the registry CLI test in `migration/test/disposition-cli.test.ts`, spawning `migration/registry/cli.ts` via `tsx` (mirroring `migration/test/evidence-cli.test.ts`'s `spawnSync(process.execPath, ["--import", "tsx", ...])` fixture), covering `propose-disposition` (required-flag enforcement, JSON output on success) and `list-dispositions` (`--status`, `--pending-only` filters) per `specs/006-dependency-disposition/contracts/cli-surface.md`.

### Implementation for User Story 1

- [x] T009 [US1] Implement `upsertProposedDisposition` and `listDispositions` in `migration/registry/commands/dispositions.ts` (NEW file), following `approveDependencyStrategy`'s shape in `migration/registry/commands/modernization.ts:280-356`: `RegistryError` on validation failure and `db.transaction(...)` wrapping the history-snapshot-then-write. Per `contracts/registry-schema.md`'s "Decision-evidence trail", the history row written in the same transaction is the sole audit record — do NOT emit an `events` row (the `events` table requires a non-null `artifact_id` and dispositions are workspace-wide per-library; a declared-but-unused library has no artifact). Makes T007 pass. (depends on T004, T007)
- [x] T010 [P] [US1] Add the `list-dispositions` and `propose-disposition` subcommands to `migration/registry/cli.ts` (commander, alongside `approve-dependency-strategy` at `cli.ts:962`) per `specs/006-dependency-disposition/contracts/cli-surface.md`. Makes T008 pass. (depends on T009, T008)
- [x] T011 [P] [US1] Implement the stack-pack `dependencies:` block loader (`manifest_globs`/`library_prefixes`/`native_equivalents` parsing plus the T005 validation rules) in `migration/guildctl/dispositions.ts` (NEW file), reusing the YAML parsing path used by `loadClassificationSpec` in `migration/guildctl/classification.ts:100`. Makes T005 pass. (depends on T004, T005)
- [x] T012 [US1] Implement the collector in `migration/guildctl/dispositions.ts` (same file as T011 — sequential): library universe from `dependency_findings` ∪ regex-level manifest extraction (mirroring `collectLineMatches`-style heuristics in `migration/guildctl/audit.ts`), import/usage analysis producing the `usage_json` used-surface summary, and proposal seeding from `native_equivalents` (default `keep` when unmapped) — writing one row per library via `upsertProposedDisposition`. Makes T006 pass. (depends on T009, T011, T006)
- [x] T013 [P] [US1] Add the `dependencies:` block (`manifest_globs`, `library_prefixes`, `native_equivalents`) to `stacks/java-spring/classification.yaml`, using the exact content shown in `specs/006-dependency-disposition/contracts/disposition-pack-yaml.md`'s YAML example.
- [x] T014 [P] [US1] Mirror the identical `dependencies:` block to `package/stacks/java-spring/classification.yaml` — content MUST match T013 byte-for-byte (DEVELOPMENT.md parity requirement).
- [x] T015 [US1] Wire the collector into `runPlan` in `migration/guildctl/commands/plan.ts`: invoke it immediately after the existing dependency-readiness gate (`plan.ts:534-552`) and before the "Phase 2b · Planner" spawn (`plan.ts:554-555`), and extend the planner `basePrompt` (`plan.ts:565`, currently `"Run planning: build the dependency graph and assign wave numbers..."`) with disposition-refinement instructions directing the agent to the `propose-disposition` CLI command using AST-level usage evidence. (depends on T012, T013, T014)

**Checkpoint**: quickstart.md Scenario 1 passes — every manifest-declared library has exactly one disposition row after a Plan run, independently of US2/US3.

---

## Phase 4: User Story 2 — Dispositions are confirmed before they lock (Priority: P1) 🎯 MVP part 2

**Goal**: Planner-proposed dispositions go through a `confirmMappings`-shaped human confirmation step with override and an explicit auto-approve bypass; unattended runs without the bypass never silently confirm and planning sign-off blocks on unresolved rows (FR-005, FR-006, FR-007, FR-011).

**Independent Test**: quickstart.md Scenario 2 (interactive confirm/override), Scenario 3 (fail-closed unattended run), and Scenario 4 (re-run never silently overwrites a confirmed decision).

### Tests for User Story 2

- [x] T016 [P] [US2] Write the confirm/override/re-propose test in `migration/test/disposition-confirm.test.ts` covering: `confirmDisposition` sets `confirmed_by` + `confirmed_at` in the same statement as the `status` flip (never a bare flip); any override arg present replaces the proposal fields and records history `change_kind='override'`; confirming a row with `pending_disposition` set and no override args folds the `pending_*` group into the primary columns and NULLs the pending group (history `change_kind='confirm'`); confirming `disposition='keep'` without `locked_target_version` is rejected; and re-running the T012 collector against an already-`status='confirmed'` row writes ONLY the `pending_*` column group (history `change_kind='re-propose'`), leaving the primary/current columns untouched (FR-011, quickstart Scenario 4).
- [x] T017 [P] [US2] Write the readiness-gate test in `migration/test/disposition-readiness.test.ts` covering: `PlanningReadiness.unconfirmedDispositions` includes rows with `status='proposed'` and rows with non-NULL `pending_disposition`; `formatPlanningBlockMessage` returns the disposition-blocked message (summary "Planning blocked by unconfirmed dependency dispositions.", command `list-dispositions --status proposed`) evaluated AFTER the existing scope → JVM → dependency branches; and a `dependency_findings` row whose `dependency_name` has a confirmed non-`keep` disposition is excluded from `unresolvedDependencyFindings` (the `NOT EXISTS` extension in `evaluatePlanningReadiness`).
- [x] T018 [P] [US2] Write the auto-confirm/fail-closed test in `migration/test/disposition-auto-confirm.test.ts`, mirroring `migration/test/plan-risk-confirmation.test.ts`'s `runPlan`-driven fixture style, covering: `GUILDCTL_AUTO_CONFIRM_DISPOSITIONS=1` bulk-confirms every pending proposal and folds every pending re-proposal, recording `confirmed_by='benchmark-runner'` and history `change_kind='auto-confirm'`; with the env var unset and non-interactive stdin, rows stay `proposed`, a silence-first warning is printed, the process does not hang, and `runPlan` exits non-zero via the end-of-Plan disposition readiness gate (quickstart Scenario 3); and a bare `runPlan()` call against a fixture with NO pre-seeded disposition rows results in disposition rows existing BEFORE the Planner phase spawns — proving the T015 collector invocation actually ran at its documented point in `runPlan` (Constitution Principle V control-flow coverage).

### Implementation for User Story 2

- [x] T019 [US2] Implement `confirmDisposition` in `migration/registry/commands/dispositions.ts` (same file as T009/T011/T012 — sequential): override-args-replace-proposal semantics, pending-fold-on-confirm, `confirmed_by` + `confirmed_at` set atomically with the status flip, `keep` + confirm requires `locked_target_version`, history snapshot before every mutation. Makes T016 pass. (depends on T009, T016)
- [x] T020 [US2] Add the `confirm-disposition` subcommand to `migration/registry/cli.ts` (same file as T010 — sequential) per `specs/006-dependency-disposition/contracts/cli-surface.md`. (depends on T019, T010)
- [x] T021 [P] [US2] Extend `PlanningReadiness`, `evaluatePlanningReadiness`, and `formatPlanningBlockMessage` in `migration/guildctl/readiness.ts` with `unconfirmedDispositions` and the disposition branch (ordered after scope → JVM → dependency, per `specs/006-dependency-disposition/contracts/registry-schema.md`'s "Readiness integration"), plus the `unresolvedDependencyFindings` filter's `NOT EXISTS`-against-confirmed-non-keep-dispositions extension. Makes T017 pass. (depends on T019, T017)
- [x] T022 [US2] Add `confirmDispositions(db)` to `migration/guildctl/commands/plan.ts` (same file as T015 — sequential), mirroring `confirmMappings` (`plan.ts:20-76`) and `confirmHighRiskArtifacts` (`plan.ts:95`): interactive y/n/e readline loop with override (`e` prompts for new kind/target/rationale, recorded as `change_kind='override'`), `GUILDCTL_AUTO_CONFIRM_DISPOSITIONS=1` bulk-confirm as `benchmark-runner`, non-interactive-stdin silence-first warning. Call it immediately after the existing `confirmHighRiskArtifacts(db)` call at `plan.ts:591`. Makes T018's auto-confirm/interactive assertions pass. (depends on T019, T015, T018)
- [x] T023 [US2] Add the end-of-Plan disposition readiness gate to `runPlan` in `migration/guildctl/commands/plan.ts` (same file as T022 — sequential), mirroring the existing `dependencyBlock` gate (`plan.ts:534-552`): after the `confirmDispositions(db)` call, re-evaluate readiness and, on a non-null disposition block, `setNext` + stderr output + `process.exit(1)`. Makes T018's fail-closed assertion pass. (depends on T021, T022, T018)

**Checkpoint**: quickstart.md Scenarios 2, 3, and 4 pass. **MVP complete** — Setup + Foundational + US1 + US2 deliver the full "confirmed, auditable, fail-closed disposition record" per the issue's core complaint.

---

## Phase 5: User Story 3 — Disposition set is consumed downstream as the locked dependency target (Priority: P2)

**Goal**: The confirmed disposition set is retrievable as a deterministic locked dependency set, and migration-agent code-writer prompts surface pruned-library guidance so generated code doesn't re-declare replaced/inlined libraries (FR-009, FR-010).

**Independent Test**: quickstart.md Scenario 5 (deterministic locked set) and Scenario 6 (migration agents see pruned-library guidance).

### Tests for User Story 3

- [x] T024 [P] [US3] Write the locked-set determinism test in `migration/test/disposition-locked-set.test.ts` covering: `getLockedDependencySet` returns only `status='confirmed'` rows `ORDER BY library_name ASC`; identical output (byte-for-byte JSON) across repeated calls with no intervening writes; every `keep` entry carries a non-null `locked_target_version`; `replace-with-native` entries carry `native_replacement`; `inline` entries carry `inline_note`; and a row with a non-NULL `pending_disposition` still contributes its CURRENT confirmed decision to the set (FR-011/FR-009, quickstart Scenario 5).
- [x] T025 [P] [US3] Write the migration-agent context test in `migration/test/disposition-context.test.ts` covering: `dispositionContextForArtifact` returns prompt text naming the native replacement or inline note for confirmed non-`keep` dispositions on libraries used by the artifact (matched via `usage_json.using_artifacts`, falling back to `dependency_findings.dependency_name` match), returns `null` when the artifact only uses `keep` libraries, and `migrate.ts`'s `codePrompt` construction appends this text (when non-null) to spawned code-writer sessions (quickstart Scenario 6, FR-010).

### Implementation for User Story 3

- [x] T026 [US3] Implement `getLockedDependencySet` and `dispositionContextForArtifact` in `migration/registry/commands/dispositions.ts` (same file as T009/T019 — sequential). Makes T024 and T025's registry-level assertions pass. (depends on T019, T024, T025)
- [x] T027 [US3] Add the `locked-dependency-set` subcommand to `migration/registry/cli.ts` (same file as T010/T020 — sequential) per `specs/006-dependency-disposition/contracts/cli-surface.md`. (depends on T026)
- [x] T028 [P] [US3] Append the `dispositionContextForArtifact` suffix to the code-writer pool's `codePrompt` in `migration/guildctl/commands/migrate.ts` (~`migrate.ts:204-206`), mirroring the existing `readStackInstruction(pack, "tests")` suffix already applied to `testPrompt` (`migrate.ts:201-203`). Makes T025's `migrate.ts` assertion pass. (depends on T026, T025)

**Checkpoint**: quickstart.md Scenarios 5 and 6 pass. All three user stories independently functional.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Full-suite regression confirmation and end-to-end validation against the documented quickstart.

- [x] T029 [P] Run `npm run build && npm run test` from the repository root and confirm no regressions in pre-existing suites, in particular `migration/test/registry-schema-delta.test.ts`, `migration/test/planning-gates.test.ts`, and `migration/test/plan-risk-confirmation.test.ts`.
- [x] T030 Execute `specs/006-dependency-disposition/quickstart.md` Scenarios 1–6 end-to-end against a scratch workspace (`/tmp/disp-ws`, per the quickstart's Prerequisites), confirming every documented "Expected" outcome.
- [x] T031 [P] Write the SC-003 benchmark test in `migration/test/disposition-benchmark.test.ts`: plant 10 known libraries in a scratch workspace fixture (4 with obvious native equivalents, 3 minimal-use helper libraries, 3 must-keep libraries), run the T012 collector, and assert the seeded proposal kind matches the expected disposition for at least 9 of the 10 planted cases (spec SC-003's ≥90% criterion realized as ≥9/10); every miss must still be resolvable through confirmation (assert a miss, if any, accepts `confirmDisposition` with an override). (depends on T012)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies.
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS all user stories.
- **US1 (Phase 3)**: Depends on Foundational only.
- **US2 (Phase 4)**: Depends on Foundational; its implementation tasks additionally depend on US1's `dispositions.ts`/`plan.ts` groundwork (see Shared-File Sequencing below) — so in practice US2 implementation starts after US1 implementation, even though both are P1.
- **US3 (Phase 5)**: Depends on Foundational; its implementation tasks depend on US2's `confirmDisposition` (a locked set has no confirmed rows to show until confirmation exists).
- **Polish (Phase 6)**: Depends on US1 + US2 + US3 all complete.

### Shared-File Sequencing

Several files are touched by more than one task across stories and must be edited in the order below (same-file edits are never parallel, even when both tasks carry the same `[P]`-eligible file-disjointness from *other* files):

- **`migration/registry_schema.sql`**: T003 only (Foundational) — prerequisite for every story's registry commands (T009, T019, T026).
- **`migration/registry/commands/dispositions.ts`**: created in T009 (US1: `upsertProposedDisposition`, `listDispositions`) → extended in T019 (US2: `confirmDisposition`) → extended in T026 (US3: `getLockedDependencySet`, `dispositionContextForArtifact`). Strict sequential order: T009 → T019 → T026.
- **`migration/registry/cli.ts`**: T010 (US1) → T020 (US2) → T027 (US3), same strict order, tracking the commands-module sequence above.
- **`migration/guildctl/commands/plan.ts`**: T015 (US1: collector wiring pre-Planner) → T022 (US2: `confirmDispositions` post-Planner) → T023 (US2: end-of-run readiness gate). T015 must land before T022/T023 since both touch the same `runPlan` function body.
- **`migration/guildctl/dispositions.ts`**: T011 (US1: pack-yaml loader) → T012 (US1: collector, same file, sequential).
- **`migration/guildctl/readiness.ts`**: T021 (US2 only) — single-story, but every story's end-state (planning sign-off) depends on it being correct.
- **`stacks/java-spring/classification.yaml`** and **`package/stacks/java-spring/classification.yaml`**: T013 and T014 (both US1) are independent files but MUST carry byte-for-byte identical `dependencies:` blocks — treat as a paired edit even though marked `[P]`.

### Within Each User Story

- Tests are written first and MUST fail before their paired implementation task lands (Constitution Principle V).
- Registry commands-module functions before the CLI subcommands that expose them.
- Collector/loader before the `plan.ts` wiring that invokes them.

### Parallel Opportunities

- Foundational: T002 and T004 (disjoint files).
- US1 tests: T005, T006, T007, T008 (four disjoint test files) — launch together.
- US1 implementation: T010, T011, T013, T014 are file-disjoint from each other once their individual dependencies (T009, T004/T005) are satisfied.
- US2 tests: T016, T017, T018 (three disjoint test files) — launch together.
- US2 implementation: T021 is disjoint from the T019→T020→T022→T023 `dispositions.ts`/`cli.ts`/`plan.ts` chain.
- US3 tests: T024, T025 (two disjoint test files) — launch together.
- US3 implementation: T028 is disjoint from the T026→T027 chain.
- Polish: T029 is independent of T030 (T030 is a manual/scripted end-to-end run best done after T029 is green, but touches no shared file).

---

## Parallel Example: User Story 1

```bash
# Tests — four disjoint files, launch together:
Task: "Write disposition-pack-yaml loader test in migration/test/disposition-pack-yaml.test.ts"
Task: "Write collector test in migration/test/disposition-collector.test.ts"
Task: "Write upsert/validation test in migration/test/disposition-upsert.test.ts"
Task: "Write registry CLI test in migration/test/disposition-cli.test.ts"

# After T009 (dispositions.ts) and T011 (pack-yaml loader) land, these are file-disjoint:
Task: "Add list-dispositions/propose-disposition subcommands to migration/registry/cli.ts"
Task: "Add dependencies: block to stacks/java-spring/classification.yaml"
Task: "Mirror dependencies: block to package/stacks/java-spring/classification.yaml"
```

---

## Implementation Strategy

### MVP First (Setup + Foundational + US1 + US2)

1. Complete Phase 1 (Setup) and Phase 2 (Foundational).
2. Complete Phase 3 (US1) — validate with quickstart.md Scenario 1.
3. Complete Phase 4 (US2) — validate with quickstart.md Scenarios 2, 3, 4.
4. **STOP and VALIDATE**: run `npm run test` plus quickstart.md Scenarios 1–4. This is the MVP — every library gets a confirmed, auditable disposition, and unattended runs are fail-closed, satisfying the issue's core complaint end-to-end.

### Incremental Delivery

1. Setup + Foundational → schema and types exist.
2. + US1 → dispositions are proposed and queryable (records exist, not yet confirmable as a locked decision).
3. + US2 → dispositions are confirmed/overridden/auto-approved and gate planning sign-off (**MVP**).
4. + US3 (P2, downstream consumption) → the confirmed set becomes a deterministic locked dependency set and migration agents receive pruned-library guidance. This phase is separable per spec ("wiring every consumer is separable... migration agents honoring dispositions builds on the record set existing first") and can ship after the MVP without blocking it.
5. Polish → full-suite regression pass and end-to-end quickstart validation.

---

## Notes

- `[P]` = different files, no unmet dependency within the current batch.
- `[US#]` maps every user-story-phase task to its story for traceability; Setup/Foundational/Polish carry no story label per the format rules.
- Constitution Principle V is satisfied by pairing every behavior-class test (schema, pack-yaml loader, collector, upsert, CLI, confirm/override/re-propose, readiness, auto-confirm, locked set, migration context) with its implementation task, tests first.
- Avoid: touching `migration/registry/commands/dispositions.ts`, `migration/registry/cli.ts`, or `migration/guildctl/commands/plan.ts` out of the sequential order documented above — each is a single shared file edited across multiple tasks/stories.
