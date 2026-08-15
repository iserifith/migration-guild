# Tasks: Consolidate Extracted View Logic into Dedicated Modules

**Input**: Design documents from `/specs/004-view-logic-consolidation/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Test tasks are INCLUDED — the plan's Testing section and constitution Principle V
(kit-behavior changes ship with `migration/test` regression coverage) explicitly require them,
and quickstart.md Scenario 4 names the test files.

**Organization**: Tasks are grouped by user story (US1 = consolidation mapping rule +
naming declaration, P1; US2 = placement audit rules, P2; US3 = review checklist, P3) so each
story can be implemented and tested independently. All stack-pack edits are applied to BOTH
`stacks/java-spring/` and `package/stacks/java-spring/` to preserve the mirror parity
constraint (plan.md Constraints).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)
- Every task names its exact file path(s)

## Path Conventions

- Stack packs (mirrored pair): `stacks/java-spring/<file>` + `package/stacks/java-spring/<file>`
- Shipped agent artifacts: `package/prompts/`, `package/agents/`, `package/skills/`
- Kit regression tests: `migration/test/`
- Findings vocabulary: `migration/registry/types.ts`
- Maintainer docs: `CHANGELOGS.MD`, `DEVELOPMENT.md` at repository root

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: No project initialization is needed — this is a policy/content change to an
existing CLI + stack-pack monorepo (plan.md, Project Type). Setup is limited to confirming the
baseline is green so later failures are attributable to this feature.

- [ ] T001 Run the existing test suite with `npm test` from the repository root and record the baseline result for `migration/test/stack-pack-engine.test.ts` and `migration/test/audit-view-regeneration.test.ts` before any pack edits

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Declare the findings-vocabulary literal that US2's audit rules require. The
`view-logic-placement` category must exist in `migration/registry/types.ts` before the pack's
`audit.rules.yaml` can reference it (research.md Decision 8; FR-005). This is a one-line
vocabulary addition — not a coordination-code change — but it blocks US2's rule files and
tests, which will not type-check or load without it. US1 and US3 do not depend on it, but the
skill's phase structure treats it as shared vocabulary, so it lands before any story work.

**⚠️ CRITICAL**: US2 cannot begin until this phase is complete

- [ ] T002 Add the `"view-logic-placement"` literal to the `JvmAuditCategory` union in `migration/registry/types.ts` (sibling to `"view-regeneration"`), keeping the union's existing members unchanged — findings vocabulary only, no schema or coordination-code change (FR-005; research.md Decision 8)

**Checkpoint**: Foundation ready — the findings category vocabulary exists; user story
implementation can now begin in parallel

---

## Phase 3: User Story 1 - Extracted view-module logic lands in dedicated service/validator modules (Priority: P1) 🎯 MVP

**Goal**: The java-spring stack pack declares that validation/business logic extracted from a
migrated view-handling module is consolidated into dedicated, named `*Validator` / `*Service`
modules — never inline in the contract-backed handler, never duplicated per-endpoint — via (a)
a `logic_extraction` naming declaration in `stack.yaml` and (b) a placement subsection in the
existing "View modules → API contracts" section of `mappings.md` (FR-001, FR-002, FR-003,
FR-008).

**Independent Test**: migrate a workspace containing at least one legacy view-handling module
carrying non-trivial validation and business logic; the `modern/` output places validation in a
dedicated `*Validator`, business logic in a dedicated `*Service`, the handler only binds and
delegates, and no extracted rule is duplicated across endpoints (spec US1 Independent Test;
quickstart.md Scenario 1).

### Implementation for User Story 1

- [ ] T003 [US1] Add the `logic_extraction:` block to `stacks/java-spring/stack.yaml` per contracts/logic-extraction-declaration.md — `service_suffix: Service`, `validator_suffix: Validator`, `handler_roles: [rest-endpoint]` — as a sibling to the existing `view_contract:` block (data-only pack declaration, no runtime consumer) (FR-008; research.md Decision 2)
- [ ] T004 [US1] Add a "Placement of extracted logic" subsection to the existing "View modules → API contracts" section of `stacks/java-spring/mappings.md` implementing research.md Decision 4: (1) extracted validation logic consolidates into a dedicated, named `*Validator` module and extracted business logic into a dedicated, named `*Service` module; (2) the contract-backed endpoint/handler only binds and delegates (routing, parameter binding, invoking the service/validator, response shaping) — non-trivial validation or business-rule logic MUST NOT appear inline; (3) rules shared across multiple endpoints live in one shared module used by all of them (workspace-wide deduplication, never per-endpoint copies); (4) logic used by exactly one endpoint still gets its own named module (isolation for testing, not only dedup); (5) trivial pass-through views carrying no validation/business rules beyond delegation need no empty `*Service` shell and may delegate directly to an existing domain service (FR-001, FR-002, FR-003)
- [ ] T005 [US1] Mirror T003–T004 into `package/stacks/java-spring/stack.yaml` and `package/stacks/java-spring/mappings.md` and verify parity with `diff -r stacks/java-spring package/stacks/java-spring` (plan.md Constraints; mirror parity)

**Checkpoint**: User Story 1 complete — the pack now declares the consolidation mapping rule
and naming vocabulary. Independently testable via quickstart.md Scenario 1.

---

## Phase 4: User Story 2 - Audit flags inline logic in handlers backing migrated view modules (Priority: P2)

**Goal**: The post-migration audit detects handlers/controllers backing migrated view modules
that contain non-trivial inline validation or business-rule logic instead of delegating to a
dedicated `*Service`/`*Validator`, reporting them as `view-logic-placement` warning findings
through the existing findings path — complementing the `view-regeneration-*` presence/absence
rules (FR-004, FR-005).

**Independent Test**: introduce a deliberately inlined handler (valid API contract, non-trivial
validation/business logic inline, no `*Service`/`*Validator` collaborator) backing a migrated
view module into a `modern/` tree and run the audit; the handler is reported as a placement
finding with severity and remediation on the same terms as existing audit findings, and a
properly consolidated tree produces zero placement findings (spec US2 Independent Test;
quickstart.md Scenario 2).

### Tests for User Story 2 ⚠️

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation** (constitution V:
> rules ship with regression coverage; plan.md Testing section)

- [ ] T006 [P] [US2] Extend `migration/test/stack-pack-engine.test.ts` with assertions that the java-spring pack loads with the two new `view-logic-placement-*` rules present in `audit.rules.yaml`, that the pack's total rule count reflects the additions, that the `logic_extraction` block is present in `stack.yaml` with the declared `service_suffix`/`validator_suffix`/`handler_roles` values, and that all rule templates pass the existing `validateTemplates` closed-placeholder check (`{symbol, line, text, version, target}` only)
- [ ] T007 [P] [US2] Create `migration/test/audit-view-logic-placement.test.ts` mirroring `migration/test/audit-view-regeneration.test.ts`, covering: (a) positive detection — a fixture workspace with a handler-named class (`*Controller`/`*Resource`/`*Endpoint`) carrying inline validation signals (null/empty guards with throw/BindingResult branching, `matches(` pattern guards) or multi-branch business-rule logic and no `*Service`/`*Validator` collaborator reference produces `warning` findings with `category: view-logic-placement`, correct rule id, offending file, and remediation directing extraction (quickstart.md Scenario 2 shape); (b) negative detection — a fixture with a properly consolidated handler referencing a `*Service`/`*Validator` collaborator produces zero `view-logic-placement` findings (SC-003 false-positive requirement)

### Implementation for User Story 2

- [ ] T008 [US2] Add the two placement rules to `stacks/java-spring/audit.rules.yaml` exactly per contracts/audit-placement-rules.md: `view-logic-placement-inline-validation` (warning; match on inline validation signals — `if (... == null)`, `isEmpty`, `throw new IllegalArgumentException`, `BindingResult` branching, `matches(` guards — in handler-named classes without a `*Validator` collaborator reference) and `view-logic-placement-inline-business-rule` (warning; match on multi-branch business decision logic — `if/else if` chains over domain state, computation/accumulation — in handler-named classes without a `*Service` collaborator reference); both `finding: jvm`, `category: view-logic-placement`, `flags: g`, with `summary_template`/`remediation`/`details_template` using only the closed placeholder vocabulary and remediation directing extraction into a dedicated `*Validator` / `*Service` module plus deduplication of any per-endpoint copies (FR-004, FR-005; research.md Decision 3)
- [ ] T009 [US2] Mirror the two rules into `package/stacks/java-spring/audit.rules.yaml` and verify parity with `diff -r stacks/java-spring package/stacks/java-spring`
- [ ] T010 [US2] Add a placement scan step to `package/prompts/post-migration-audit.prompt.md` (as a sibling step alongside the existing Step 9 view-regeneration scan): grep the `modern/` tree for handler-named classes lacking any `*Service`/`*Validator` collaborator reference while containing validation/business-rule signal patterns, and for duplicated rule blocks across endpoints (same validation predicate in 2+ handlers); report hits in the same structured findings format and create registry remediation entries with `category "view-logic-placement"` via the existing `create-artifact` commands the prompt already documents; add a matching "View-logic placement" section to the prompt's report format (research.md Decision 3, layer 2; FR-005)
- [ ] T011 [P] [US2] Add the matching placement scan step to `package/agents/audit-agent.agent.md` so the audit agent performs the same holistic `modern/`-tree placement + per-endpoint duplication scan and routes hits through the standard findings/remediation path (FR-004, FR-005)

**Checkpoint**: User Story 2 complete — `npm test` passes with the new tests green; the audit
catches inlined-logic handlers with no false positives on consolidated output. Independently
testable via quickstart.md Scenario 2 and the kit-level regression suite.

---

## Phase 5: User Story 3 - Review checklist verifies dedicated-module placement (Priority: P3)

**Goal**: The migration-review checklist and review-agent explicitly direct reviewers to
verify, for every migrated view-handling module, that extracted validation/business logic lives
in dedicated, named `*Service`/`*Validator` modules and the handler only delegates — alongside
the existing "no regenerated UI" checks — with a placement failure recorded as Critical
(FR-006).

**Independent Test**: review a migrated view module using the updated checklist; the checklist
contains an explicit placement-verification step, and a reviewer following it flags an inlined
handler as a finding rather than approving it (spec US3 Independent Test; quickstart.md
Scenario 3).

### Implementation for User Story 3

- [ ] T012 [P] [US3] Add a placement bullet to the "View modules" checklist in `package/skills/migration-review/SKILL.md` requiring the reviewer to confirm, for any migrated view-handling module: (a) extracted validation/business logic lives in dedicated, named `*Service`/`*Validator` modules; (b) the handler contains only contract-binding and delegation code (routing, parameter binding, invoking the service/validator, response shaping); and (c) no extracted rule is duplicated across endpoints — with quick-scan commands alongside the existing view-regeneration greps (list handler-named classes, check each for a `*Service`/`*Validator` collaborator reference and for inline validation/business signal patterns), and any failure recorded as **Critical** (a finding, not an approval), matching the section's existing severity convention (FR-006; research.md Decision 5)
- [ ] T013 [P] [US3] Add the corresponding bullet to review priority 7 ("View-module review") in `package/agents/review-agent.agent.md`: migrated view modules must be checked for dedicated-module placement of extracted logic and handler-delegates-only, and an inlined handler must be reported as a Critical finding (artifact set to `needs-rework` with an event describing the required extraction) rather than approved — matching the automated audit rule so the critic pass reinforces it (spec US3 Scenario 2; constitution Principle IV)

**Checkpoint**: All user stories complete — reviewer checklist and critic agent both catch
inlined handlers the automated audit might be bypassed for. Independently testable via
quickstart.md Scenario 3.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Kit-level regression, parity verification, and maintainer documentation.

- [ ] T014 Run the full test suite with `npm test` from the repository root and confirm all tests pass, including the extended `migration/test/stack-pack-engine.test.ts` and new `migration/test/audit-view-logic-placement.test.ts`
- [ ] T015 [P] Verify `stacks/` ↔ `package/stacks/` mirror parity with `diff -r stacks/java-spring package/stacks/java-spring` (must be empty; any pre-existing python drift is out of scope)
- [ ] T016 [P] Add a CHANGELOGS.MD entry under Unreleased summarizing the feature: `logic_extraction` pack declaration, mappings.md placement subsection, two `view-logic-placement-*` audit rules, prompt/agent placement scan steps, review checklist/agent placement items, and the `view-logic-placement` findings-category literal (FR-007: no new pipeline phase, no core runtime coordination changes)
- [ ] T017 [P] Update DEVELOPMENT.md only if the mirror-parity or pack-authoring workflow notes need to mention the new `logic_extraction` block and `view-logic-placement` rule family; skip if the existing checklist already covers the mirrored files
- [ ] T018 Walk through quickstart.md Scenarios 1–4 against a scratch workspace per the quickstart's Prerequisites and confirm each scenario's Expected outcome, recording the results

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS US2 (the `view-logic-placement`
  category literal must exist before the pack rules and tests reference it)
- **User Stories (Phases 3–5)**: US1 and US3 can start after Setup; US2 can start after
  Foundational completion
  - US1 and US2 both touch `stacks/java-spring/stack.yaml` (T003 vs the existing
    `view_contract` region) and the pack directory — sequence them or rebase carefully; US1's
    `logic_extraction` declaration is conceptually referenced by US2's rule remediation text
  - US3 touches only `package/` skills/agents and is fully independent of US1/US2 file-wise
  - Within US2: tests (T006, T007) MUST be written and FAIL before rules are implemented (T008)
- **Polish (Phase 6)**: Depends on all desired user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Setup — no dependencies on other stories
- **User Story 2 (P2)**: Can start after Foundational (T002) — its remediation text references
  US1's `logic_extraction` vocabulary, but it is independently testable via the fixture tests
  and quickstart Scenario 2
- **User Story 3 (P3)**: Can start after Setup — content references US1's mapping and US2's
  findings, but the files are disjoint; independently testable via quickstart Scenario 3

### Within Each User Story

- US2: tests first (T006, T007), confirm they fail, then implement rules (T008, T009), then
  prompt/agent steps (T010, T011)
- Commit after each task or logical group (a pack edit + its mirror is one logical group)

### Parallel Opportunities

- T006 and T007 (US2 tests) can run in parallel — different test files
- T010 and T011 can run in parallel — different files
- T012 and T013 (US3) can run in parallel — different files
- T015, T016, T017 (Polish) can run in parallel — different files
- US3 as a whole can run in parallel with US1/US2 — disjoint files (`package/skills/`,
  `package/agents/` vs `stacks/`/`package/stacks/`)

---

## Parallel Example: User Story 2

```bash
# Write both US2 test tasks together (they fail until T008 lands):
Task: "Extend stack-pack-engine.test.ts with view-logic-placement rule presence/count and logic_extraction manifest assertions"
Task: "Create audit-view-logic-placement.test.ts with positive/negative placement fixtures"

# Then mirror + prompt/agent steps in parallel:
Task: "Mirror view-logic-placement rules into package/stacks/java-spring/audit.rules.yaml"
Task: "Add placement scan step to package/prompts/post-migration-audit.prompt.md"
Task: "Add matching placement scan step to package/agents/audit-agent.agent.md"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (baseline `npm test`)
2. Complete Phase 2: Foundational (findings-category literal)
3. Complete Phase 3: User Story 1 (`logic_extraction` declaration + mappings placement rule)
4. **STOP and VALIDATE**: quickstart.md Scenario 1 in a scratch workspace
5. The consolidation requirement now exists as pack policy — the gap named in issue #100 is
   closed at the mapping layer

### Incremental Delivery

1. Setup + Foundational → findings vocabulary ready
2. Add US1 → mapping + naming declared (MVP) → validate independently
3. Add US2 → audit enforcement + regression tests → validate independently (`npm test`)
4. Add US3 → review/critic reinforcement → validate independently
5. Polish → full suite green, parity verified, docs updated

### Parallel Team Strategy

With multiple agents:

1. Complete Setup + Foundational together (T002 is a shared vocabulary file)
2. Once Foundational is done:
   - Agent A: User Story 1 (`stack.yaml` + `mappings.md`, both mirror trees)
   - Agent B: User Story 2 (tests first, then `audit.rules.yaml` + prompt/agent) — coordinate
     with Agent A on `stack.yaml` since T003 touches the same file
   - Agent C: User Story 3 (`package/skills/migration-review/SKILL.md`, `review-agent`) —
     fully independent
3. Stories complete and integrate independently; Polish verifies parity and full-suite green

---

## Notes

- [P] tasks = different files, no dependencies on incomplete tasks
- [US1]/[US2]/[US3] labels map tasks to spec.md user stories for traceability
- Every stack-pack edit has a paired mirror task — never edit one tree without the other
- Tests are included because plan.md Testing and constitution Principle V require them, not
  because the spec requests TDD generally; only US2 (the deterministic rule behavior) gets
  test tasks
- The only `migration/` production-code task is the one-literal `JvmAuditCategory` extension
  (T002) — findings vocabulary, not coordination code (research.md Decision 8)
- Verify tests fail before implementing the audit rules (T006/T007 before T008)
- Stop at any checkpoint to validate a story independently

## Assumptions (documented per autonomous operation)

- **Tests included for US2 only**: the plan and constitution mandate regression coverage for
  the new audit rules and manifest declaration; US1 and US3 are prose/declaration content whose
  validation is the quickstart walkthrough (T018), so no unit-test tasks were generated for
  them.
- **Mirror edits modeled as explicit tasks**: the plan's parity constraint makes each pack
  edit a pair; mirroring is a separate task (not folded into the primary edit) so a partial
  application is visible as an unchecked box.
- **Foundational phase carries only the type-literal addition**: the skill's phase structure
  requires shared prerequisites before story work; the `view-logic-placement` category literal
  is the single cross-story prerequisite (US2's rules/tests cannot type-check without it). US1
  and US3 have no hard dependency on it but are ordered after it for simplicity.
- **Python pack untouched**: research.md Decision 7 documents that the python pack has no
  view-handling-module vocabulary and receives no placement rules in this feature.
- **No human was available**: choices above (US2-only test tasks, mirror-as-task modeling,
  foundational scoping) follow the 003 feature's tasks.md precedent and are recorded here as
  explicit assumptions rather than clarification markers because reasonable defaults exist for
  each.
