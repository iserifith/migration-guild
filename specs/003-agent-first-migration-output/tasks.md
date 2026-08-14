# Tasks: Agent-First Migration Output

**Input**: Design documents from `/specs/003-agent-first-migration-output/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Test tasks are INCLUDED — the plan's Testing section and constitution Principle V
(kit-behavior changes ship with `migration/test` regression coverage) explicitly require them,
and quickstart.md's "Kit-level regression" section names the test files.

**Organization**: Tasks are grouped by user story (US1 = view→API-contract mapping, P1;
US2 = audit rules, P2; US3 = review checklist, P3) so each story can be implemented and tested
independently. All stack-pack edits are applied to BOTH `stacks/java-spring/` and
`package/stacks/java-spring/` to preserve the mirror parity required by DEVELOPMENT.md
(plan.md Constraints).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)
- Every task names its exact file path(s)

## Path Conventions

- Stack packs (mirrored pair): `stacks/java-spring/<file>` + `package/stacks/java-spring/<file>`
- Shipped agent artifacts: `package/prompts/`, `package/agents/`, `package/skills/`
- Kit regression tests: `migration/test/`
- Maintainer docs: `CHANGELOGS.MD`, `DEVELOPMENT.md` at repository root

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: No project initialization is needed — this is a policy/content change to an
existing CLI + stack-pack monorepo (plan.md, Project Type). Setup is limited to confirming the
baseline is green so later failures are attributable to this feature.

- [ ] T001 Run the existing test suite with `npm test` from the repository root and record the baseline result for `migration/test/stack-pack-engine.test.ts` and the audit tests before any pack edits

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Make legacy view files first-class, registered artifacts. Without this, no user
story can work: view modules would be neither migratable (US1) nor auditable (US2), and a drop
decision would be invisible (FR-004). Blocks ALL user stories.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [ ] T002 Widen `source_globs` in `stacks/java-spring/stack.yaml` by adding `**/*.jsp`, `**/*.jspx`, and `**/*.xhtml` so legacy view files are registered as `legacy-source` artifacts by inventory (research.md Decision 2)
- [ ] T003 [P] Add `jsp` and `jsf` to `frameworks.allowed` in `stacks/java-spring/classification.yaml` (with aliases `jspx: jsp`, `facelets: jsf`), and add the priority-ordered view signals from data-model.md: `jsp-view` (matches `<%@`, `<jsp:`, or `.jsp` extension → framework `jsp`, role `rest-endpoint`, confidence ~0.9) and `jsf-view` (matches `javax.faces`/`jakarta.faces`/`<h:`/`<f:` → framework `jsf`, role `rest-endpoint`, confidence ~0.9), ordered before plain-servlet signals so view technologies classify distinctly
- [ ] T004 [P] Add the meaningful tag `view-dropped-presentational` to `tags.meaningful` in `stacks/java-spring/classification.yaml` so purely-presentational view drops are recordable via existing artifact state (status `skipped` + tag + event) per FR-004 and data-model.md
- [ ] T005 Mirror T002–T004 into `package/stacks/java-spring/stack.yaml` and `package/stacks/java-spring/classification.yaml` and verify parity with `diff -r stacks/java-spring package/stacks/java-spring` (plan.md Constraints; DEVELOPMENT.md mirror checklist)

**Checkpoint**: Foundation ready — view files now enter the registry and classify; user story implementation can now begin in parallel

---

## Phase 3: User Story 1 - View modules map to API contracts, never UI components (Priority: P1) 🎯 MVP

**Goal**: Legacy view-handling modules (JSP, JSF/Facelets, servlet page renderers, view-bound
Struts actions) map to structured API contracts plus behavior-preserving handlers — never to
regenerated UI. Presentation is dropped; routing, parameter binding, validation, and business
logic are extracted (FR-001–FR-004, FR-009).

**Independent Test**: migrate a workspace containing at least one legacy view-handling module;
the `modern/` output for it consists of API contract definitions plus behavior-preserving
endpoint/handler code, with zero regenerated view-layer UI artifacts (spec US1 Independent
Test; quickstart.md Scenarios 1 and 4).

### Implementation for User Story 1

- [ ] T006 [US1] Add the `view_contract:` block to `stacks/java-spring/stack.yaml` per contracts/stack-view-contract.md: `format: openapi`, `style: rest`, `alternates: [mcp-tools]`, `drop_rule: presentational` — data-only pack declaration, no runtime consumer (FR-001, FR-009)
- [ ] T007 [US1] Add a "View modules → API contracts" section to `stacks/java-spring/mappings.md` implementing research.md Decision 6: (1) view-bound handlers (Struts actions, servlet page renderers, JSP-backed controllers) map to contract-backed endpoints carrying their routing, parameter binding, validation, and business logic; (2) layout/markup/styling/template structure is dropped, not ported; (3) purely-presentational views are recorded as intentionally dropped (`status: skipped` + `view-dropped-presentational` tag + event with stated reason), never regenerated; (4) low-confidence presentation/behavior separation fails closed to review (`blocked` + `blocked-human-decision` tag) rather than regenerating UI (FR-001–FR-004)
- [ ] T008 [US1] Mirror T006–T007 into `package/stacks/java-spring/stack.yaml` and `package/stacks/java-spring/mappings.md` and verify parity with `diff -r stacks/java-spring package/stacks/java-spring`

**Checkpoint**: User Story 1 complete — the pack now declares the view→contract mapping,
behavior preservation, presentation discard, intentional-drop, and fail-closed rules.
Independently testable via quickstart.md Scenarios 1 and 4.

---

## Phase 4: User Story 2 - Audit flags view-layer UI regeneration in `modern/` (Priority: P2)

**Goal**: The post-migration audit detects JSP-derived artifacts, JSF/Facelets views, legacy
view-framework imports/usages, and legacy-derived server-template rendering in migrated
output, reporting them as findings through the existing findings path (FR-005, FR-006).

**Independent Test**: introduce a deliberately regenerated view-layer UI artifact (e.g. a
`.jsp` file or a JSF import) into a `modern/` tree and run the audit; the artifact is reported
as a finding with severity and remediation on the same terms as existing audit findings, and a
clean tree produces zero findings (spec US2 Independent Test; quickstart.md Scenarios 2–3).

### Tests for User Story 2 ⚠️

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation** (constitution V:
> rules ship with regression coverage; plan.md Testing section)

- [ ] T009 [P] [US2] Extend `migration/test/stack-pack-engine.test.ts` with assertions that the java-spring pack loads with the four new `view-regeneration-*` rules present in `audit.rules.yaml`, that the pack's total rule count reflects the additions, and that all rule templates pass the existing `validateTemplates` closed-placeholder check (`{symbol, line, text, version, target}` only)
- [ ] T010 [P] [US2] Create `migration/test/audit-view-regeneration.test.ts` covering: (a) positive detection — a fixture workspace with a `.jsp` artifact and a JSF-import artifact produces `critical` findings with `category: view-regeneration`, correct rule id, offending file, and remediation (quickstart.md Scenario 2 shape); (b) negative detection — a fixture with a legitimate Spring `@RestController` contract/handler produces zero `view-regeneration` findings (Scenario 3 shape); (c) registration — a `.jsp` file is registered as a `legacy-source` artifact by inventory via the widened `source_globs` (Scenario 1 shape)

### Implementation for User Story 2

- [ ] T011 [US2] Add the four view-regeneration rules to `stacks/java-spring/audit.rules.yaml` exactly per contracts/audit-view-regeneration-rules.md: `view-regeneration-jsp` (critical, match `<%@|<jsp:|<%[!=]`), `view-regeneration-jsf` (critical, match `\b(?:javax\.faces|jakarta\.faces)\b|<[hf]:[A-Za-z]`), `view-regeneration-legacy-view-imports` (critical, match `\b(?:javax\.servlet\.jsp|JspException|PageContext|TagSupport|org\.apache\.struts\.taglib)\b`), and `view-regeneration-template-engine` (warning, match `\b(?:TemplateEngine|thymeleaf|freemarker|velocity)\b.*(?:process|render)`) — all `finding: jvm`, `category: view-regeneration`, `flags: g`, templates using only the closed placeholder vocabulary (FR-005, FR-006)
- [ ] T012 [US2] Mirror the four rules into `package/stacks/java-spring/audit.rules.yaml` and verify parity with `diff -r stacks/java-spring package/stacks/java-spring`
- [ ] T013 [US2] Add a view-regeneration scan step to `package/prompts/post-migration-audit.prompt.md` (as "Step 4b" alongside the existing legacy-import grep of `modern/`): grep the `modern/` tree for `.jsp`/`.jspx`/`.xhtml` files, JSF/JSP imports and taglib usage, and legacy CSS/asset copies; report hits in the same structured findings format and create registry remediation entries via the existing `create-artifact` commands the prompt already documents; add a matching "View regeneration" section to the prompt's report format (research.md Decision 4)
- [ ] T014 [P] [US2] Add the matching view-regeneration scan step to `package/agents/audit-agent.agent.md` so the audit agent performs the same `modern/`-tree scan and routes hits through the standard findings/remediation path (FR-005, FR-006)

**Checkpoint**: User Story 2 complete — `npm test` passes with the new tests green; audit
catches regenerated view UI with no false positives on clean contract output. Independently
testable via quickstart.md Scenarios 2–3 and the kit-level regression suite.

---

## Phase 5: User Story 3 - Review checklist verifies API-contract output for view modules (Priority: P3)

**Goal**: The migration-review checklist and review-agent explicitly direct reviewers to
verify that a migrated view module produced an API contract, preserved its routing/validation
behavior, and regenerated no view-layer UI (FR-007).

**Independent Test**: review a migrated view module using the updated checklist; the checklist
contains an explicit verification step for API-contract output and behavior preservation, and
a reviewer following it would flag regenerated UI (spec US3 Independent Test; quickstart.md
Scenario 5).

### Implementation for User Story 3

- [ ] T015 [P] [US3] Add a view-module section to the checklist in `package/skills/migration-review/SKILL.md` requiring the reviewer to confirm, for any migrated view-handling module: (a) the output is an API contract in the pack's declared `view_contract.format`; (b) routing, parameter binding, validation, and business behavior were preserved in the contract-backed handlers; (c) no view-layer UI was regenerated (no `.jsp`/`.xhtml`, no legacy view-framework imports, no ported layout/CSS); and (d) any purely-presentational view carries a visible intentional-drop record (`status: skipped` + `view-dropped-presentational` tag + event with reason) (FR-007)
- [ ] T016 [P] [US3] Add a corresponding review priority to `package/agents/review-agent.agent.md`: migrated view modules must be checked for API-contract output plus preserved behavior, and regenerated view-layer UI must be reported as a finding rather than approved — matching the automated audit rule so the critic pass reinforces it (spec US3 Scenario 2)

**Checkpoint**: All user stories complete — reviewer checklist and critic agent both catch
regenerated UI that the automated audit might be bypassed for. Independently testable via
quickstart.md Scenario 5.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Kit-level regression, parity verification, and maintainer documentation.

- [ ] T017 Run the full test suite with `npm test` from the repository root and confirm all tests pass, including the extended `migration/test/stack-pack-engine.test.ts` and new `migration/test/audit-view-regeneration.test.ts`
- [ ] T018 [P] Verify `stacks/` ↔ `package/stacks/` mirror parity with `diff -r stacks/java-spring package/stacks/java-spring` (must be empty; the pre-existing python drift is out of scope per plan.md Constraints)
- [ ] T019 [P] Add a CHANGELOGS.MD entry summarizing the feature: view→API-contract mapping rules, `view_contract` pack declaration, four `view-regeneration-*` audit rules, widened `source_globs`, classification signals/tag, and prompt/skill/agent checklist updates (FR-008: no new phase, no core runtime changes)
- [ ] T020 [P] Update DEVELOPMENT.md only if the mirror-parity or pack-authoring workflow notes need to mention the new `view_contract` block and view-regeneration rule family; skip if the existing checklist already covers the mirrored files
- [ ] T021 Walk through quickstart.md Scenarios 1–5 against a scratch workspace per the quickstart's Prerequisites and confirm each scenario's Expected outcome, recording the results

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS all user stories (view files must be registered/classified before they can be mapped, audited, or reviewed)
- **User Stories (Phases 3–5)**: All depend on Foundational completion
  - US1 and US2 both touch `stacks/java-spring/stack.yaml` (T002/T006) and the pack directory — sequence them or rebase carefully; US3 touches only `package/` skills/agents and is fully independent of US1/US2 file-wise
  - Within US2: tests (T009, T010) MUST be written and FAIL before rules are implemented (T011)
- **Polish (Phase 6)**: Depends on all desired user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational — no dependencies on other stories
- **User Story 2 (P2)**: Can start after Foundational — its `modern/`-tree prompt/agent steps (T013/T014) conceptually reference the contract output US1 declares, but it is independently testable via the fixture tests and quickstart Scenarios 2–3
- **User Story 3 (P3)**: Can start after Foundational — content references US1's mapping and US2's findings, but the files are disjoint; independently testable via quickstart Scenario 5

### Within Each User Story

- US2: tests first (T009, T010), confirm they fail, then implement rules (T011, T012), then prompt/agent steps (T013, T014)
- Commit after each task or logical group (pack edit + its mirror is one logical group)

### Parallel Opportunities

- T003 and T004 can run in parallel with each other (same file, different sections — or combine into one edit)
- T009 and T010 (US2 tests) can run in parallel — different test files
- T013 and T014 can run in parallel — different files
- T015 and T016 (US3) can run in parallel — different files
- T018, T019, T020 (Polish) can run in parallel — different files
- US3 as a whole can run in parallel with US1/US2 — disjoint files (`package/skills/`, `package/agents/` vs `stacks/`/`package/stacks/`)

---

## Parallel Example: User Story 2

```bash
# Write both US2 test tasks together (they fail until T011 lands):
Task: "Extend stack-pack-engine.test.ts with view-regeneration rule presence/count assertions"
Task: "Create audit-view-regeneration.test.ts with positive/negative/registration fixtures"

# Then mirror + prompt/agent steps in parallel:
Task: "Mirror view-regeneration rules into package/stacks/java-spring/audit.rules.yaml"
Task: "Add Step 4b view-regeneration scan to package/prompts/post-migration-audit.prompt.md"
Task: "Add matching scan step to package/agents/audit-agent.agent.md"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (baseline `npm test`)
2. Complete Phase 2: Foundational (view files registered + classified)
3. Complete Phase 3: User Story 1 (mapping rules + `view_contract` declaration)
4. **STOP and VALIDATE**: quickstart.md Scenarios 1 and 4 in a scratch workspace
5. The hard rule now exists as pack policy — the gap named in the issue is closed at the
   mapping layer

### Incremental Delivery

1. Setup + Foundational → view artifacts visible in the registry
2. Add US1 → mapping declared (MVP) → validate independently
3. Add US2 → audit enforcement + regression tests → validate independently (`npm test`)
4. Add US3 → review/critic reinforcement → validate independently
5. Polish → full suite green, parity verified, docs updated

### Parallel Team Strategy

With multiple agents:

1. Complete Setup + Foundational together (pack globs/classification are shared files)
2. Once Foundational is done:
   - Agent A: User Story 1 (`stack.yaml` + `mappings.md`, both mirror trees)
   - Agent B: User Story 2 (tests first, then `audit.rules.yaml` + prompt/agent) — coordinate
     with Agent A on `stack.yaml` since T002 and T006 touch the same file
   - Agent C: User Story 3 (`package/skills/migration-review/SKILL.md`, `review-agent`) —
     fully independent
3. Stories complete and integrate independently; Polish verifies parity and full-suite green

---

## Notes

- [P] tasks = different files, no dependencies on incomplete tasks
- [US1]/[US2]/[US3] labels map tasks to spec.md user stories for traceability
- Every stack-pack edit has a paired mirror task — never edit one tree without the other
- Tests are included because plan.md Testing and constitution Principle V require them, not
  because the spec requests TDD generally; only US2 (the rule behavior) gets test tasks
- No `migration/` production-code tasks exist by design (FR-008); only its test suite changes
- Verify tests fail before implementing the audit rules (T009/T010 before T011)
- Stop at any checkpoint to validate a story independently

## Assumptions (documented per autonomous operation)

- **Tests included for US2 only**: the plan and constitution mandate regression coverage for
  the new audit rules and glob/classification changes; US1 and US3 are prose/declaration
  content whose validation is the quickstart walkthrough (T021), so no unit-test tasks were
  generated for them.
- **Mirror edits modeled as explicit tasks**: the plan's parity constraint makes each pack
  edit a pair; mirroring is a separate task (not folded into the primary edit) so a partial
  application is visible as an unchecked box.
- **Python pack untouched**: research.md Decision 7 documents that the python pack has no
  analogous view-layer vocabulary and receives no rules in this feature.
