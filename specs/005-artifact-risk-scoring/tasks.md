# Tasks: Automated Risk Scoring for Legacy Artifacts at Inventory Time

**Input**: Design documents from `/specs/005-artifact-risk-scoring/`
**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: Included. Constitution Principle V ("Tests Before Production Code") explicitly
scopes this feature in — it touches claim eligibility (`claimNextTask`/`claimArtifactById`)
and introduces a new evidence gate (`risk_confirmations`), both named in the Principle's
"claims, evidence gates, ... phase control flow MUST ship with regression tests" clause. Every
implementation task below is preceded by a task that adds a failing test for the same behavior,
using `migration/test/*.test.ts` (`node --import tsx --test`, real in-memory `better-sqlite3`,
no mocking framework, per existing convention). Sole exception: T014 (a one-line CLI summary
addition) — pure output surface, not a claim/evidence-gate/phase-control-flow change, so
Principle V's scoped test mandate does not apply to it.

**Organization**: Tasks are grouped by user story per `spec.md`'s priorities. Spec has two
P1 stories (US1 and US3); they are sequenced US1 → US3 because scoring must exist before
there is anything to gate on.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: US1/US2/US3/US4 — omitted for Setup, Foundational, and Polish tasks
- Every task names exact repository file path(s)

---

## Phase 1: Setup

**Purpose**: Confirm the working environment and design-doc references are current before
any edit begins. No new project scaffolding is needed — this is an existing single-project
TypeScript CLI kit (`migration/`), extended in place, per plan.md's Structure Decision.

- [x] T001 Run `npm install` at the repository root (installs both the root workspace and,
  per existing convention, `migration/`'s dependencies — `package.json`,
  `migration/package.json`) to confirm the toolchain installs cleanly (quickstart.md
  Prerequisites).
- [x] T002 [P] Run `npm run build` and `npm run test` from the repository root and confirm
  the current commit is green before starting (quickstart.md §1: `npm run build` = `tsup
  setup.ts`; `npm run test` = `npm --prefix migration test && npm --prefix migration/ui
  test`). Record any pre-existing failures so they are not misattributed to this feature.
- [x] T003 [P] Verify the file/line references cited in `specs/005-artifact-risk-scoring/plan.md`
  and `specs/005-artifact-risk-scoring/research.md` still match current source before editing:
  `migration/registry_schema.sql` (`artifact_classifications` block ~409-421),
  `migration/guildctl/classification.ts` (`loadClassificationSpec`, `validateSpec`,
  `coerceEvidence`/`parseEvidence`), `migration/guildctl/commands/inventory.ts`
  (classification batch loop ~300-405, `validateInventoryQuality` call ~420),
  `migration/guildctl/commands/plan.ts` (`confirmMappings` ~20-76, `runPlan` ~275-508,
  Planner phase ~476-507), `migration/registry/commands/claim.ts` (`claimArtifactById`
  ~463-610, `claimNextTask` ~676-732). Flag any drift found before proceeding.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The registry schema and the new `migration/guildctl/risk.ts` module (spec
loader/validator, scanner, score formula, persistence) that every user story depends on.
Mirrors `migration/guildctl/classification.ts`'s three-part shape (load/validate spec →
compute record → persist record), per plan.md's Structure Decision.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [x] T004 [P] Add a schema test asserting `applySchema(db)` creates
  `artifact_risk_assessments` (columns `artifact_id`, `risk_score`, `high_risk`,
  `reason_codes_json`, `signals_json`, `updated_at`; CHECK constraints on `risk_score >= 0`
  and `high_risk IN (0,1)`) and `risk_confirmations` (columns `artifact_id`, `decision`
  defaulting to `'pending'`, `decided_by`, `decided_at`, `created_at`; CHECK on
  `decision IN ('pending','confirmed','declined')`), plus the
  `idx_artifact_risk_assessments_high_risk` and `idx_risk_confirmations_decision` indexes —
  new file `migration/test/risk-schema.test.ts`, modeled on the `createDb()`/`applySchema`
  pattern in `migration/test/claim-ordering.test.ts`. Confirm the test fails against current
  `migration/registry_schema.sql`.
- [x] T005 Add the `artifact_risk_assessments` and `risk_confirmations` tables plus their two
  indexes to `migration/registry_schema.sql`, appended to the base
  (`CREATE TABLE IF NOT EXISTS`) section immediately after the existing
  `artifact_classifications` block (~line 421), exactly as specified in
  `specs/005-artifact-risk-scoring/contracts/registry-schema.md`. No `ensureColumn` guard
  or migration-section entry is needed — both tables are new. Confirm T004 passes.
- [x] T006 [P] Add a `risk:` spec validation/defaults test covering: `god_method_max_lines`/
  `cyclomatic_complexity_limit` must be finite `> 0` if present, `high_risk_score_cutoff`
  must be finite `>= 0` if present, `method_boundary.style` must be `"brace"` or `"indent"`,
  `method_boundary.start_pattern` and every `reflection_patterns[].match` must compile as a
  `RegExp`, duplicate `reflection_patterns[].id` within one pack is rejected, and an absent
  `risk:` block (or absent individual fields within it) falls back to built-in defaults
  (80 / 15 / 50 per research.md §3) without throwing — new file
  `migration/test/risk-spec-validation.test.ts`, modeled on `validateSpec`'s error-message
  style already tested implicitly via `loadClassificationSpec` in
  `migration/guildctl/classification.ts`. Confirm it fails (module doesn't exist yet).
- [x] T007 Implement the `RiskSpec` interface, built-in default constants, and
  `loadRiskSpec`/`validateRiskSpec` (or an equivalent extension of
  `loadClassificationSpec`/`validateSpec`) in new file `migration/guildctl/risk.ts`, per
  `specs/005-artifact-risk-scoring/data-model.md` Entity 2 and
  `specs/005-artifact-risk-scoring/contracts/risk-spec-yaml.md`. Extend
  `ClassificationSpec` in `migration/guildctl/classification.ts` with an optional
  `risk?: RiskSpec` field so `risk:` parses through the existing
  `loadClassificationSpec`/`parse(yaml)` call at `migration/guildctl/classification.ts:98-107`.
  Errors must identify the stack pack id/source and offending field, matching
  `validateSpec`'s `"${source}: ..."` style. Confirm T006 passes.
- [x] T008 [P] Add scanner-heuristic tests covering: reflection-pattern detection reusing
  line-scoped regex matching (evidence string produces a `reflection-usage:<pattern-id>`
  reason code), God-method detection via `method_boundary` brace-depth tracking AND
  indent-depth tracking (`god-method:<name>@L<n> (<lines> lines > <limit>)` reason code),
  cyclomatic-complexity detection via `complexity_keywords` counting +1 McCabe baseline
  (`cyclomatic-complexity:<name>@L<n> (complexity <v> > <limit>)` reason code), the
  `heuristic-skipped:<heuristic>` reason code when a heuristic can't evaluate (spec Edge
  Case: unparseable/no method matches found), a plain artifact producing `risk_score` ≈ 0
  and an empty reason-code list, and the score formula's independent per-term caps +
  overall `[0,100]` clamp from research.md §7 — new file
  `migration/test/risk-scanner.test.ts`. Confirm it fails.
- [x] T009 Implement the scanner core in `migration/guildctl/risk.ts`: method-boundary line-
  range detection (`"brace"` depth-tracking and `"indent"` depth-tracking strategies),
  `detectReflection` (reusing `collectLineMatches`'s line-scoped-regex approach from
  `migration/guildctl/audit.ts:41-55`, generalized to accept `risk.reflection_patterns[]`),
  `detectGodMethod`, `detectCyclomaticComplexity`, the weighted-sum score formula from
  `specs/005-artifact-risk-scoring/research.md` §7, and an orchestrating `scoreArtifact`
  function producing a `RiskAssessmentRecord` (`data-model.md` Entity 1 in-process shape).
  Confirm T008 passes.
- [x] T010 [P] Add persistence tests covering: `applyRiskAssessment`/
  `applyBatchRiskAssessment` upserts via `INSERT ... ON CONFLICT(artifact_id) DO UPDATE`
  (FR-015 — a second call for the same artifact replaces, never accumulates, the prior
  `risk_score`/`reason_codes_json`/`signals_json`), `reason_codes_json`/`signals_json` are
  always valid JSON via the same coercion discipline as `coerceEvidence`/`parseEvidence`
  in `migration/guildctl/classification.ts:236-277`, and `high_risk` is set correctly
  against the effective `high_risk_score_cutoff` — new file
  `migration/test/risk-assessment-persistence.test.ts`. Confirm it fails.
- [x] T011 Implement `applyRiskAssessment`/`applyBatchRiskAssessment` in
  `migration/guildctl/risk.ts`: the transactional upsert against
  `artifact_risk_assessments` per `specs/005-artifact-risk-scoring/data-model.md` Entity 1
  "Write path", reusing/adapting `coerceEvidence`-style coercion for
  `reason_codes_json`/`signals_json`. Confirm T010 passes.

**Checkpoint**: `migration/guildctl/risk.ts` exists with a full load→scan→score→persist
pipeline, backed by passing unit tests. No caller wires it in yet — that begins in Phase 3.

---

## Phase 3: User Story 1 - See risk scores for every inventoried artifact (Priority: P1) 🎯 MVP (part 1/2)

**Goal**: Every artifact registered during Inventory gets a risk score and reason codes,
persisted and queryable without re-scanning (FR-001, FR-002, FR-003, FR-004, FR-005,
FR-006, FR-015, FR-016).

**Independent Test**: Run Inventory against a codebase with a planted reflection call, a
planted God method, and a planted cyclomatic-complexity hotspot alongside a plain artifact;
confirm the registry shows matching non-zero scores/reason codes for the three risky
artifacts and a zero score/empty reason-code list for the plain one (spec.md Independent
Test for US1; quickstart.md §2).

- [x] T012 [P] [US1] Add an integration test that runs `runInventory` against a fixture
  workspace (java-spring stack) containing one artifact with a `Class.forName(...)` call,
  one with a method longer than the default `god_method_max_lines` (80), one with a method
  whose branching exceeds the default `cyclomatic_complexity_limit` (15), and one plain
  artifact; then asserts, via direct `SELECT ... FROM artifact_risk_assessments`, that each
  planted artifact has the matching reason-code prefix and a higher score than the plain
  artifact, and the plain artifact has `risk_score` ≈ 0 / `reason_codes_json = "[]"`
  (spec.md Acceptance Scenarios 1.1-1.5) — new file
  `migration/test/inventory-risk-scoring.test.ts`, modeled on the `fixtureRoot`/`writeJava`/
  `register` helpers already in `migration/test/inventory-classification.test.ts`. Confirm
  it fails (risk pass isn't wired into `runInventory` yet).
- [x] T013 [US1] Wire the risk-assessment pass into `runInventory` in
  `migration/guildctl/commands/inventory.ts`: after the classification batch loop
  completes (~line 405: `stopPolling();`) and before `validateInventoryQuality` is called
  (~line 420), load the active pack's `RiskSpec` (T007) and call `risk.ts`'s scan+score+
  `applyBatchRiskAssessment` (T009/T011) over the same `firstClassIds` artifact set used by
  classification (per `specs/005-artifact-risk-scoring/research.md` §1). Confirm T012 passes.
- [x] T014 [US1] Add a high-risk-artifact-count summary line to `guildctl inventory`'s output
  in `migration/guildctl/commands/inventory.ts`, alongside the existing classification
  summary (~line 397-398: `Classification summary: ...`), following the repo's
  "silence-first, one final summary" convention (`specs/005-artifact-risk-scoring/contracts/cli-surface.md`,
  Constitution Principle VI).
- [x] T015 [P] [US1] Add a re-registration test: run `runInventory` once, mutate a fixture's
  planted God-method artifact so it's no longer a God method (or vice versa), re-run
  `runInventory`, and assert `artifact_risk_assessments` reflects only the latest scan —
  the row is replaced in place, not accumulated, and stale reason codes from the first run
  are gone (FR-015; spec.md Edge Case "re-scanned after a legacy-side change") — extend
  `migration/test/inventory-risk-scoring.test.ts`.

**Checkpoint**: `guildctl inventory` now computes, persists, and surfaces risk data for
every artifact. US1 is independently demonstrable via quickstart.md §2.

---

## Phase 4: User Story 3 - Route high-risk artifacts to mandatory human review before migration (Priority: P1) 🎯 MVP (part 2/2)

**Goal**: An artifact scoring above its stack pack's `high_risk_score_cutoff` cannot be
claimed for migration until an operator confirms it, with no silent unattended bypass
(FR-010, FR-011, FR-012, FR-013).

**Independent Test**: Run Inventory and Plan against one above-threshold and one
below-threshold artifact; confirm the below-threshold artifact proceeds to planning and is
claimable normally, while the above-threshold artifact is held pending and only becomes
claimable after an operator confirms it, or stays blocked if declined (spec.md Independent
Test for US3; quickstart.md §4).

**Depends on**: Phase 3 (T013) — the pending-confirmation row is created by the same write
path that persists the risk assessment.

- [x] T016 [P] [US3] Add a test for `risk_confirmations` row creation semantics: a fresh
  `applyRiskAssessment`/`applyBatchRiskAssessment` call whose computed `high_risk = 1` and
  no existing `risk_confirmations` row creates one with `decision = 'pending'`; a
  subsequent recompute of the same artifact (still high-risk) does NOT reset an existing
  `confirmed`/`declined` row back to `pending` (`data-model.md` Entity 3 state transitions;
  spec.md Edge Case on threshold tightening) — extend
  `migration/test/risk-assessment-persistence.test.ts`. Confirm it fails.
- [x] T017 [US3] Inside the same transaction as `applyRiskAssessment`'s upsert in
  `migration/guildctl/risk.ts` (T011), insert a `risk_confirmations` row with
  `decision = 'pending'` only when the freshly computed `high_risk = 1` AND no
  `risk_confirmations` row already exists for that artifact
  (`specs/005-artifact-risk-scoring/data-model.md` Entity 1 "Relationships"). Confirm T016
  passes.
- [x] T018 [P] [US3] Add a claim-gate test: with a `risk_confirmations` row present and
  `decision = 'pending'` or `'declined'`, `claimNextTask` must not select that artifact as a
  candidate and `claimArtifactById` must reject claiming it; with `decision = 'confirmed'`
  or no `risk_confirmations` row at all, both claim paths must succeed normally — new file
  `migration/test/risk-confirmation-claim-gate.test.ts`, modeled on the
  `createDb`/`registerPlanned`/`claimNextTask` pattern in
  `migration/test/claim-ordering.test.ts`. Confirm it fails.
- [x] T019 [US3] Add
  `AND NOT EXISTS (SELECT 1 FROM risk_confirmations rc WHERE rc.artifact_id = a.id AND rc.decision != 'confirmed')`
  to `claimNextTask`'s candidate query in `migration/registry/commands/claim.ts` (~lines
  709-732, inside the existing `db.transaction`) and add the equivalent check to
  `claimArtifactById`'s pre-update logic in `migration/registry/commands/claim.ts` (~lines
  463-610, before its optimistic-concurrency `UPDATE`), per
  `specs/005-artifact-risk-scoring/contracts/registry-schema.md`'s claim-eligibility
  contract. Confirm T018 passes.
- [x] T020 [P] [US3] Add a Plan-phase confirmation test covering: the interactive
  confirm/decline `readline` loop records `decision='confirmed'`/`'declined'` with
  `decided_by='operator'` and `decided_at` set; `GUILDCTL_AUTO_CONFIRM_RISK=1` bulk-confirms
  every pending row with `decided_by='benchmark-runner'` and no prompt; and with the env
  var unset and no interactive stdin, pending artifacts remain `pending` (not claimable,
  not hung) per FR-012 — new file `migration/test/plan-risk-confirmation.test.ts`, modeled
  on the `runPlan`/fake-`spawnAgent` harness in
  `migration/test/plan-invariant-verification.test.ts`. Confirm it fails.
- [x] T021 [US3] Implement `confirmHighRiskArtifacts(db)` in
  `migration/guildctl/commands/plan.ts`, structurally mirroring `confirmMappings`
  (`migration/guildctl/commands/plan.ts:20-76`) — same y/n `readline` loop shape, reading
  `GUILDCTL_AUTO_CONFIRM_RISK` (`specs/005-artifact-risk-scoring/contracts/cli-surface.md`)
  in place of `GUILDCTL_AUTO_CONFIRM_MAPPINGS`. Call it from `runPlan` immediately after
  the Planner phase completes (`migration/guildctl/commands/plan.ts:~507`, after
  `console.log("\n  ✓ Planning complete\n");`) — deliberately after, not before, the
  Planner agent phase (per `specs/005-artifact-risk-scoring/research.md` §5, so pending
  high-risk work doesn't block wave assignment for everything else, per US4's non-goal).
  Confirm T020 passes.
- [x] T022 [P] [US3] Add an end-to-end test exercising the full spec.md Independent Test for
  US3: register one above-threshold and one below-threshold artifact, run `runInventory`
  then `runPlan` (with `GUILDCTL_AUTO_CONFIRM_MAPPINGS`/`GUILDCTL_AUTO_KEEP_SCOPE` set as
  existing tests already do), assert the below-threshold artifact is claimable via
  `claimNextTask` while the above-threshold one is not, then confirm it (interactively or
  via `GUILDCTL_AUTO_CONFIRM_RISK=1`) and assert it becomes claimable with no other change
  (spec.md Acceptance Scenarios 3.1-3.5) — extend
  `migration/test/plan-risk-confirmation.test.ts`.

**Checkpoint**: High-risk artifacts are structurally unclaimable until confirmed, through
every code path that can claim (`claimNextTask`, `claimArtifactById`), with no silent
automated bypass. **US1 + US3 together are the MVP** — see Implementation Strategy below.

---

## Phase 5: User Story 2 - Configure risk thresholds per stack pack (Priority: P2)

**Goal**: Stack packs can override God-method length, cyclomatic-complexity limit, and the
high-risk cutoff; packs that don't override get sane defaults (FR-007, FR-008, FR-009).

**Independent Test**: Configure two stack packs with different God-method thresholds for
equivalent-length fixtures; confirm the stricter pack flags high-risk and the looser pack
doesn't (spec.md Independent Test for US2; quickstart.md §3).

**Depends on**: Phase 2 (T007's `RiskSpec` loader already supports per-pack overrides and
defaults) and Phase 3 (T013's inventory wiring reads the pack's spec).

- [ ] T023 [P] [US2] Add a test proving override precedence and per-field fallback: a
  synthetic `ClassificationSpec` with a `risk:` block overriding only
  `god_method_max_lines` uses that value for God-method detection while still falling back
  to the built-in default `cyclomatic_complexity_limit`/`high_risk_score_cutoff`; two specs
  with different `god_method_max_lines` scoring the same fixture produce different
  `high_risk` outcomes (spec.md Acceptance Scenarios 2.1-2.3); ALSO assert the disable
  path from spec.md's Edge Cases ("stack packs must be able to tune or disable individual
  heuristics"): a spec whose `reflection_patterns` is explicitly emptied (or an equivalent
  pack-level opt-out) contributes zero reflection score and emits no reflection reason
  codes even for a fixture containing `Class.forName(...)` — extend
  `migration/test/risk-spec-validation.test.ts`. This exercises the override path
  specifically — distinct from T006, which only covers the defaults-and-validation path.
  Confirm it fails against T007's current defaults-only exercised behavior.
- [ ] T024 [P] [US2] Add a `risk:` block to `stacks/java-spring/classification.yaml` per the
  example in `specs/005-artifact-risk-scoring/contracts/risk-spec-yaml.md` (brace
  `method_boundary`, `Class.forName`/`.getMethod().invoke()` `reflection_patterns`), and
  mirror the identical block into `package/stacks/java-spring/classification.yaml` to
  preserve the `stacks/*/classification.yaml` ↔ `package/stacks/*/classification.yaml`
  parity DEVELOPMENT.md requires for shipped stack packs.
- [ ] T025 [P] [US2] Add a `risk:` block to `stacks/python/classification.yaml` per the
  example in `specs/005-artifact-risk-scoring/contracts/risk-spec-yaml.md` (indent
  `method_boundary`, `getattr(...)`/`importlib.import_module(...)` `reflection_patterns`,
  looser/python-appropriate thresholds than java-spring's), and mirror the identical block
  into `package/stacks/python/classification.yaml` for the same parity requirement.
- [ ] T026 [US2] Add an end-to-end test that runs `runInventory` twice — once against a
  java-spring fixture workspace, once against a python fixture workspace — each with an
  artifact whose method length sits between the two packs' `god_method_max_lines` values
  (from T024/T025); assert the stricter pack's fixture is flagged `high_risk = 1` and the
  looser pack's equivalent fixture is not (spec.md Acceptance Scenario 2.3) — extend
  `migration/test/inventory-risk-scoring.test.ts`.

**Checkpoint**: Stack-pack maintainers can tune thresholds by editing one YAML file and
re-running Inventory, satisfying SC-004, without any code change.

---

## Phase 6: User Story 4 - Planner orders work using risk visibility (Priority: P3)

**Goal**: Risk score/reason codes are available to the planning step, and a wave-ordering
property (pending high-risk work not placed ahead of confirmed lower-risk work with no
dependency requiring otherwise) is checkable (FR-014).

**Independent Test**: Run planning against a mixed-risk artifact set and confirm low-risk
artifacts are assigned to earlier waves than unresolved high-risk artifacts, without
changing the US3 confirmation gate (spec.md Independent Test for US4; quickstart.md §5).

**Depends on**: Phase 3 (risk data must exist) and Phase 4 (confirmation status must exist
to distinguish "pending" from "confirmed" high-risk work).

- [ ] T027 [P] [US4] Add a test for a risk-visible query helper: given artifacts with mixed
  `artifact_risk_assessments`/`risk_confirmations` rows, the helper returns each artifact's
  `wave`, `status`, `risk_score`, `high_risk`, and confirmation `decision` (or `null` if
  never scored high-risk) in one call (FR-014) — new file
  `migration/test/risk-planning-visibility.test.ts`. Confirm it fails.
- [ ] T028 [US4] Add a `listArtifactsWithRisk`-style query helper to
  `migration/registry/commands/queries.ts` (alongside existing helpers like `wavePlan` at
  ~line 402 and `listArtifacts` at ~line 55) that left-joins `artifacts` with
  `artifact_risk_assessments` and `risk_confirmations`, satisfying FR-014's "available to
  the planning step" requirement via the registry query surface documented in
  `specs/005-artifact-risk-scoring/contracts/cli-surface.md`. Confirm T027 passes.
- [ ] T029 [P] [US4] Add a wave-ordering property test: given a fixture where waves are
  assigned respecting "no pending-high-risk artifact precedes confirmed/low-risk work with
  no dependency forcing otherwise," an ordering check passes; given a fixture that violates
  it, the same check fails with a message identifying the offending artifact (spec.md
  Acceptance Scenarios 4.1-4.2) — new file `migration/test/risk-wave-ordering.test.ts`,
  modeled on `verifyPlannerInvariant`'s `{ passed, message }` shape in
  `migration/guildctl/commands/plan.ts:153-165`. Confirm it fails.
- [ ] T030 [US4] Implement `verifyRiskAwareWaveOrdering(db)` in
  `migration/guildctl/commands/plan.ts`, mirroring `verifyPlannerInvariant`'s shape, and
  call it as an advisory warning (printed via `process.stdout.write`, never thrown as a
  `PlanInvariantError`) immediately after the Planner phase completes
  (`migration/guildctl/commands/plan.ts:~507`, alongside T021's `confirmHighRiskArtifacts`
  call) — advisory only, because US4 explicitly must not block the run the way
  `confirmMappings` blocks the Planner phase. Confirm T029 passes.

**Checkpoint**: All four user stories are independently functional; risk data now
influences what operators see about wave assignment without gating it.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Documentation and full-suite validation across all stories.

- [ ] T031 [P] Add an entry under `Unreleased` in `CHANGELOGS.MD` describing the risk-
  scoring scanner, the `risk:` stack-pack config block, and the high-risk confirmation
  gate, per Constitution "Development Workflow and Quality Gates".
- [ ] T032 [P] Update `DEVELOPMENT.md`'s maintainer checklist / architecture notes section
  to record this feature's answers (repo-only vs. shipped; `migration/` changes;
  `package/stacks/*/classification.yaml` parity from T024/T025; no `package/agents/`
  changes), matching the existing pattern at `DEVELOPMENT.md:238-242`.
- [ ] T033 Run `npm run build` and `npm run test` from the repository root and confirm the
  full suite (`migration` + `migration/ui`) is green with all new tests from T004-T030
  and T035 included.
- [ ] T034 Execute `specs/005-artifact-risk-scoring/quickstart.md` scenarios 1-5 manually
  against a scratch workspace seeded from `package/mock/` (per Constitution: "Migration
  phases MUST NOT be run against this repository root"), confirming the CLI-level
  behavior (summary line, `sqlite3` queries, interactive/auto-confirm prompts) matches
  what the automated tests assert.
- [ ] T035 [US1] Add a benchmark-corpus test satisfying SC-002's statistical bar: generate a
  mixed fixture corpus of at least 20 planted-risky artifacts (spread across reflection,
  God-method, and cyclomatic-complexity constructs, at least 5 of each) and at least 20
  planted-simple artifacts (programmatically synthesized Java sources under a temp fixture
  root, varying method names/lengths/branch counts so the corpus isn't the same exemplar
  copied N times); run `runInventory` over it and assert the measured flag rate on the
  risky set is ≥ 95% with matching reason codes AND the zero-reason-code rate on the
  simple set is ≥ 95% — assert the computed percentages, not individual exemplars —
  new file `migration/test/inventory-risk-benchmark.test.ts`, reusing the
  `fixtureRoot`/`writeJava` helpers from `migration/test/inventory-risk-scoring.test.ts`.
  This validates US1's SC-002 (general scanner accuracy), not US2's threshold-override
  behavior; it sits in Phase 7 because it depends on the full scanner + inventory wiring
  being complete and is not part of the MVP.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies.
- **Foundational (Phase 2)**: Depends on Setup. Blocks every user story — `risk.ts` is the
  shared engine every story wires into or reads from.
- **US1 (Phase 3)**: Depends on Foundational. No dependency on other stories.
- **US3 (Phase 4)**: Depends on Foundational AND US1's T013 (the write path US3's pending-row
  logic hooks into is created there). This is why US3 is sequenced after US1 despite both
  being P1.
- **US2 (Phase 5)**: Depends on Foundational (T007) and US1 (T013, so the override actually
  takes effect during a real `runInventory` run in T026). Independent of US3.
- **US4 (Phase 6)**: Depends on US1 (risk data must exist) and US3 (confirmation status must
  exist to distinguish pending from confirmed high-risk work in the ordering check).
- **Polish (Phase 7)**: Depends on all stories in scope for the given release being complete.

### Shared-File Sequencing (not parallelizable across these pairs)

- `migration/registry_schema.sql`: touched only by T005. No other task edits it.
- `migration/guildctl/risk.ts`: built incrementally by T007 → T009 → T011 (spec loader,
  then scanner, then persistence) and later extended by T017 (pending-row creation) — these
  four tasks touch the same file and MUST run in this sequence, never in parallel with each
  other.
- `migration/guildctl/classification.ts`: T007 adds the optional `risk?: RiskSpec` field.
  No other task edits this file.
- `migration/registry/commands/claim.ts`: touched only by T019 (`claimNextTask` and
  `claimArtifactById` in the same task, since both need the identical clause).
- `migration/guildctl/commands/plan.ts`: T021 (`confirmHighRiskArtifacts` + call site) then
  T030 (`verifyRiskAwareWaveOrdering` + call site) — sequential, same file.
- `migration/guildctl/commands/inventory.ts`: T013 then T014 — sequential, same file.
- `migration/test/risk-spec-validation.test.ts`: T006 then T023 — sequential (T023 extends
  the file T006 creates).
- `migration/test/risk-assessment-persistence.test.ts`: T010 then T016 — sequential.
- `migration/test/inventory-risk-scoring.test.ts`: T012 → T015 → T026 — sequential.
- `migration/test/plan-risk-confirmation.test.ts`: T020 then T022 — sequential.
- `stacks/java-spring/classification.yaml` / `package/stacks/java-spring/classification.yaml`:
  T024 only. `stacks/python/classification.yaml` / `package/stacks/python/classification.yaml`:
  T025 only — T024 and T025 touch disjoint file sets and ARE parallelizable with each other.

### Parallel Opportunities

- Setup: T002, T003 in parallel (after T001).
- Foundational: T004, T006, T008, T010 (the four *-test.ts files) can each be written in
  parallel with the others, since they're independent new files — but each must still
  precede its own paired implementation task (T005/T007/T009/T011 respectively).
- US1: T012 and T015 are both test-file edits to the same file, so not mutually parallel;
  T012 can run in parallel with Foundational's later tasks only if this story is staffed
  separately, but per Phase Dependencies above, US1 cannot start until Foundational is done.
- US3: T016, T018, T020 (three independent new/extended test files) can run in parallel with
  each other; T022 depends on T021 so is not parallel with it.
- US2: T024 and T025 are parallel (disjoint stack packs); T023 (spec-level) can run in
  parallel with either.
- US4: T027 and T029 (independent new test files) are parallel.
- Polish: T031 and T032 are parallel (different docs).

---

## Parallel Example: Foundational Phase

```bash
# Launch all four Foundational test-authoring tasks together:
Task: "Schema test for artifact_risk_assessments/risk_confirmations in migration/test/risk-schema.test.ts"
Task: "RiskSpec validation/defaults test in migration/test/risk-spec-validation.test.ts"
Task: "Scanner heuristic tests in migration/test/risk-scanner.test.ts"
Task: "applyRiskAssessment upsert-replace test in migration/test/risk-assessment-persistence.test.ts"
```

## Parallel Example: User Story 3

```bash
# Launch the three independent US3 test-authoring tasks together:
Task: "risk_confirmations pending-row creation test (extend migration/test/risk-assessment-persistence.test.ts)"
Task: "Claim-gate exclusion test in migration/test/risk-confirmation-claim-gate.test.ts"
Task: "confirmHighRiskArtifacts interactive/auto-confirm test in migration/test/plan-risk-confirmation.test.ts"
```

---

## Implementation Strategy

### MVP Scope: Setup + Foundational + US1 + US3

The MVP is **Setup (T001-T003) + Foundational (T004-T011) + US1 (T012-T015) + US3
(T016-T022)** — 22 tasks. This is the point at which the feature is coherent per spec.md's
own framing: US1 alone is "decoration" (a score nobody acts on); US3 is "the reason risk
scoring exists." Stopping before US3 does not satisfy the originating GitHub issue #60's
stated intent ("flagged for mandatory human review before the Migrate phase proceeds").

1. Complete Phase 1 (Setup) and Phase 2 (Foundational) — the shared `risk.ts` engine and
   registry tables.
2. Complete Phase 3 (US1) — risk scores become visible after Inventory.
   **STOP and VALIDATE**: quickstart.md §2 against a scratch workspace.
3. Complete Phase 4 (US3) — high-risk artifacts are gated at claim time.
   **STOP and VALIDATE**: quickstart.md §4. This is the MVP checkpoint.

### Incremental Delivery Beyond MVP

4. Add US2 (Phase 5) — per-stack-pack threshold tuning. Validate: quickstart.md §3.
5. Add US4 (Phase 6) — planner-visible risk data and the advisory wave-ordering check.
   Validate: quickstart.md §5.
6. Phase 7 (Polish) — docs and a final full-suite run, once all desired stories are in.

Each story after the MVP is additive: US2 only changes which threshold values are read
(the read path already exists from Foundational/US1); US4 only adds a query helper and an
advisory warning, touching neither the scanner nor the claim gate US3 already hardened.

---

## Notes

- [P] tasks touch disjoint files and have no unmet dependency at the time they'd run.
- Every implementation task has a preceding test task for the same behavior (Constitution
  Principle V) — write the test, confirm it fails, then implement, per the file-by-file
  ordering in "Shared-File Sequencing" above.
- US1 and US3 are both P1; they are sequenced (not parallel) because US3's gating logic is
  physically added to the write path US1 builds (`applyRiskAssessment` in `risk.ts`).
- Avoid: editing `legacy/` or `modern/` anywhere (Constitution Principle II — this feature
  is entirely registry- and stack-pack-config-side); adding a new npm dependency (research.md
  §2 rejected AST/complexity libraries); adding a new CLI flag for risk confirmation
  (contracts/cli-surface.md — env-var parity with `GUILDCTL_AUTO_CONFIRM_MAPPINGS` only).
