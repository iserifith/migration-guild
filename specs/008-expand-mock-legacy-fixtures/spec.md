# Feature Specification: Expand Mock Legacy Fixtures

**Feature Branch**: `008-expand-mock-legacy-fixtures`

**Created**: 2026-08-16

**Status**: Draft

**Input**: User description: "Our mock legacy code (`package/mock/`) is too thin. `legacy-customer-utils` is ~359 lines across four Java files with no cross-module dependency, and `legacy-python-utils` is a single module. Recent audit-rule work (view-regeneration, view-logic-placement, #59/#100) and a known review gap (agents shipping cosmetically-renamed copies of legacy code with no real modernization) have no fixture that exercises them end-to-end. Expand the mock fixtures so the pipeline's newest gates and known blind spots get real coverage before the next run, without displacing the existing lightweight smoke-test fixtures."

**Source context**: Identified during a pre-run review of the July→August changelog (`CHANGELOGS.MD`) against `package/mock/README.md`. Three concrete gaps drove this spec: (1) no fixture contains a JSP/JSF/Struts view module, so the `view-regeneration-*` and `view-logic-placement-*` audit rules (added Aug 14–15, specs 003/004) have unit-test coverage but no real-fixture coverage; (2) no fixture has a genuine multi-module dependency, so `plan`'s wave-graph logic degrades to a single-wave, single-artifact path on every mock run; (3) no fixture is designed to bait a low-effort "renamed but not modernized" migration, so the review/audit gap flagged in retrospective has no regression fixture to validate a future detection rule against.

**Governing document**: `.specify/memory/constitution.md` — principally II (Legacy Is Read-Only; `modern/` Is the Only Write Target — fixtures live under `legacy/`-equivalent read-only fixture roots and must never be mutated by a pipeline run), V (Tests Before Production Code — new fixtures must ship with their own legacy-side tests so migrated output has a behavior baseline to compare against), and VII (Pluggable Stacks, Neutral Providers — fixture additions must stay stack-pack-shaped, not hardcode java-spring specifics into core runtime).

## User Scenarios & Testing *(mandatory)*

Primary persona: the **maintainer**, who runs the pipeline against `package/mock/` fixtures to validate kit changes before a real run. Secondary persona: the **audit/review rule author**, who needs a real fixture to prove a new rule fires (and doesn't false-positive) rather than relying solely on synthetic unit-test strings. Tertiary persona: the **operator preparing for a real migration**, who uses a fixture run as a dry-run rehearsal and needs it to resemble a real brownfield shape (multiple modules, at least one view layer) closely enough to catch pipeline problems before they hit a customer repo.

### User Story 1 - A view-bearing legacy module exercises view-regeneration and view-logic-placement end-to-end (Priority: P1)

A maintainer runs the full pipeline (`inventory` → `plan` → `migrate` → `review`) against the mock fixtures and gets real, non-synthetic coverage of the `view-regeneration-*` and `view-logic-placement-*` audit rules: a JSP or Struts-action module with embedded validation and business logic, migrated to an API contract with extracted logic landing in dedicated service/validator modules.

**Why this priority**: these rule families were added Aug 14–15 and are currently proven only by handcrafted unit-test fixtures inside `migration/test/`. A kit-level regression (e.g. a prompt change that stops the audit agent from scanning `.jsp` files, or a stack-pack merge that drops a signal) would not be caught by any fixture-driven run. This is the single biggest coverage gap relative to the newest, least-battle-tested part of the pipeline.

**Independent Test**: run `guildctl inventory && guildctl plan && guildctl migrate && guildctl review` against a workspace containing only the new view-bearing fixture module. Delivers value if inventory classifies it with `jsp-view`/`jsf-view` signals, migration produces a contract-backed endpoint with logic extracted into named service/validator modules, and the audit reports zero `view-regeneration-*` findings and zero `view-logic-placement-*` findings on a correctly-migrated result — with findings appearing when the fixture's expected-bad companion (Story 3) is substituted in.

**Acceptance Scenarios**:

1. **Given** the new view-bearing fixture module (a Struts action or JSP-backed controller with non-trivial validation and business logic, committed under `package/mock/`), **When** `guildctl inventory` runs against it, **Then** the artifact is classified with view-framework signals per `stacks/java-spring/classification.yaml`.
2. **Given** the fixture is migrated by a code-writer agent, **When** the post-migration audit runs, **Then** no `.jsp`/`.jspx`/`.xhtml` artifacts, JSP scriptlet syntax, or JSF/Struts imports appear anywhere in the migrated output.
3. **Given** the fixture carries validation and business logic used by more than one legacy request path, **When** it is migrated correctly, **Then** the logic is consolidated into one shared, named service/validator module rather than duplicated per-endpoint.
4. **Given** the fixture, **When** run through the full pipeline unmodified, **Then** the run completes through `review` with an approvable result — the fixture is solvable, not a trap.

---

### User Story 2 - A cross-module dependency fixture exercises real wave planning (Priority: P2)

A maintainer runs `guildctl plan` against a fixture set with a genuine inter-module dependency (e.g. a service module that depends on a utility module already in `package/mock/`), and gets a real multi-wave plan rather than the current single-artifact, single-wave degenerate case.

**Why this priority**: wave planning is a core pipeline phase (README.md pipeline table: "Dependency graph resolved; artifacts assigned to executable waves") but every existing mock fixture is dependency-free, so a maintainer dry-running the kit never actually exercises wave sequencing, tier-aware claiming, or dependency-blocked queue behavior before a real run does it for the first time on customer code.

**Independent Test**: run `guildctl plan` against a workspace containing the existing `legacy-customer-utils` fixture plus a new fixture module that depends on it. Delivers value if the plan output shows two waves with the dependent module correctly assigned after its dependency, and `guildctl auto-run` correctly defers claiming the dependent module until the dependency reaches an unlocking status (`reviewed`, `completed`, or `skipped`, per README.md's auto-run semantics).

**Acceptance Scenarios**:

1. **Given** a new fixture module with a compile-time dependency on `legacy-customer-utils`, **When** `guildctl plan` runs, **Then** the two modules are assigned to different waves with the dependency ordered first.
2. **Given** the two-module fixture set, **When** `guildctl auto-run` executes, **Then** the dependent module is not claimed until its dependency reaches an unlocking status.
3. **Given** the dependent module's dependency is only `migrated` (not yet `reviewed`/`completed`/`skipped`), **When** the auto-run queue evaluates readiness, **Then** the dependent module stays blocked, exercising the same tier-aware gating a real multi-module migration would hit.

---

### User Story 3 - A verbatim-copy fixture baits and exposes shallow, non-modernized migration (Priority: P2)

A maintainer or rule author has a fixture specifically shaped to reward a low-effort migration if one is produced: legacy code with an obvious modernization opportunity (e.g. `SimpleDateFormat` and raw collections that map cleanly to `java.time` and generics under the existing stack-pack mapping rules) that a shallow migration could satisfy by copying the legacy body, renaming identifiers, and adding comments without adopting the target idioms. This fixture exists to validate a future modernization-depth check (tracked separately) and, in the meantime, to give reviewers something concrete to manually spot-check against the "not really modernized" failure mode observed in the July run.

**Why this priority**: this is P2 rather than P1 because no detection rule exists yet (see Assumptions) — the fixture's value today is manual review and as a target for the detection work, not automated gating. It is still in this spec because the fixture itself is cheap to build now and blocks nothing else, while building it later means retrofitting a "does this look copy-pasted" fixture after the detection rule already exists, backwards from how the other two stories validate rules that already ship.

**Independent Test**: migrate the fixture manually or via the kit, then compare legacy and migrated source. Delivers value if a structural/token-similarity comparison (manual today, automated once the detection rule referenced in Assumptions exists) can clearly distinguish a "renamed but not modernized" migration of this fixture from a properly modernized one, because the fixture's legacy code contains unambiguous outdated idioms with a well-known modern equivalent under the stack pack's own mapping rules.

**Acceptance Scenarios**:

1. **Given** the verbatim-copy-bait fixture (a module using `SimpleDateFormat`, raw `Map`/`List`, and manual null-checks that the java-spring `mappings.md` already prescribes modern replacements for), **When** migrated properly, **Then** the outdated idioms are replaced with their prescribed modern equivalents, not merely renamed.
2. **Given** a deliberately shallow "migration" of the fixture is produced for testing purposes (legacy logic copied with renamed identifiers and added comments, outdated idioms left in place), **When** compared against the properly-modernized version, **Then** the difference is structurally obvious enough for a human reviewer — and, once built, an automated rule — to flag it as non-modernized.
3. **Given** the fixture, **When** run through the existing pipeline and audit unmodified, **Then** no existing audit rule currently flags the shallow version (documenting the known gap, not silently fixing it) — this scenario is expected to start failing once the detection rule from the Assumptions section ships, at which point this spec's fixture becomes that rule's regression test.

---

### Edge Cases

- What happens if a new fixture accidentally makes `package/mock/` too large or slow for routine CI smoke runs? Fixtures MUST stay small enough (see SC-002) that the full mock-fixture pipeline run remains a fast local/CI smoke test, not a stand-in for a real brownfield stress suite (that is separately tracked on the README.md roadmap as "pinned-fixture stress suite against real brownfield repos").
- What happens if the view-bearing fixture (Story 1) is solvable in a way that also satisfies the wave-dependency fixture (Story 2) — should they be merged into one fixture module? No: each fixture isolates one pipeline concern so a regression in one area doesn't mask or get masked by another; keep them as separate mock modules even if a combined fixture would be more "realistic."
- How is the Story 3 fixture prevented from being "fixed" by a well-meaning contributor who notices the shallow-migration output and patches the fixture instead of building the detection rule? The shallow/bait migration output is never committed as the fixture's expected state — only the legacy source and its test are committed; the shallow-migration comparison is a manual or CI-scratch artifact, not part of the fixture tree.
- What happens to existing regression tests that assert on today's fixture set (e.g. any test hardcoding "2 files" or a specific classification count against `package/mock/`)? Existing fixtures (`legacy-customer-utils`, `legacy-python-utils`) MUST be left unmodified in place; new fixtures are additive siblings, not edits to existing fixture files, so no existing test needs updating as a side effect of this spec.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: `package/mock/` MUST gain a new java-spring fixture module containing at least one legacy view-handling artifact (JSP, JSF/Facelets, or Struts action) with non-trivial validation and business logic spanning more than one request path, alongside its legacy-side test(s).
- **FR-002**: The view-bearing fixture MUST be solvable end-to-end by the existing pipeline — inventory classifies it correctly, migration can produce a passing result, and audit/review report zero findings against a correctly-migrated output (User Story 1, Scenario 4).
- **FR-003**: `package/mock/` MUST gain a new fixture module with a real compile-time dependency on the existing `legacy-customer-utils` fixture, sized so `guildctl plan` produces at least two waves when both are inventoried together.
- **FR-004**: `package/mock/` MUST gain a new fixture module ("verbatim-copy bait") whose legacy code contains outdated idioms with an unambiguous modern equivalent already prescribed by `stacks/java-spring/mappings.md` (e.g. `SimpleDateFormat` → `java.time`, raw collections → generics), sized to make a "renamed-only" shallow migration and a properly modernized migration visibly different in structure.
- **FR-005**: Every new fixture MUST ship with its own legacy-side tests (mirroring `legacy-customer-utils`'s existing `LegacyCustomerKeyServiceTest.java` pattern), so a migrated equivalent has a behavior baseline to be checked against, per constitution Principle V.
- **FR-006**: `package/mock/README.md` MUST be updated to document each new fixture: what pipeline concern it exercises, what "intentionally dated" or "intentionally bait" properties it has, and which story/spec it traces to.
- **FR-007**: New fixtures MUST NOT modify or replace `legacy-customer-utils/` or `legacy-python-utils/` — they are additive sibling directories under `package/mock/`.
- **FR-008**: New fixtures MUST stay within the existing stack packs (java-spring; Python fixture expansion is out of scope per Assumptions) — no fixture may require a new, unshipped stack pack or classification signal to be inventoried correctly.
- **FR-009**: This feature MUST NOT add or change core runtime code (registry, claims, evidence gates, arbitration, audit-rule engine) — it is fixture content plus documentation only. Any new audit rule needed to detect Story 3's shallow-migration pattern is explicitly out of scope for this spec (see Assumptions) and will be specified separately.

### Key Entities

- **View-bearing fixture module**: a new `package/mock/` Java project containing a legacy view-handling artifact (JSP/JSF/Struts) with embedded validation and business logic across multiple request paths, used to exercise `view-regeneration-*` and `view-logic-placement-*` audit rules against a real fixture rather than only unit-test strings.
- **Dependent fixture module**: a new `package/mock/` Java project with a genuine compile-time dependency on `legacy-customer-utils`, used to exercise multi-wave planning and dependency-gated claiming.
- **Verbatim-copy-bait fixture module**: a new `package/mock/` Java project whose legacy code contains outdated idioms with well-known modern equivalents under the existing stack-pack mapping rules, sized so a shallow rename-only migration is structurally distinguishable from a properly modernized one — intended as the regression fixture for a not-yet-built modernization-depth detection rule.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Running the full pipeline (`inventory` → `plan` → `migrate` → `review`) against each new fixture individually completes with an approvable result for the view-bearing fixture (Story 1) and the dependent-module pair (Story 2), with zero manual intervention required beyond what any other mock fixture run requires today.
- **SC-002**: Total added fixture size stays under roughly 1,500 lines across all new fixtures combined, keeping the full `package/mock/` pipeline run fast enough for routine local/CI use (not a stand-in for the separately-tracked brownfield stress suite).
- **SC-003**: `guildctl plan` against the dependent-module pair (Story 2) produces 2+ waves with correct dependency ordering, verified by a regression test in `migration/test/`.
- **SC-004**: The view-bearing fixture (Story 1), migrated correctly, produces zero `view-regeneration-*` and zero `view-logic-placement-*` audit findings; a deliberately-inlined or deliberately-view-leaking variant of the same fixture (used only in the audit rules' own test suite, not committed as fixture output) produces the expected findings — closing the "unit-test-only coverage" gap named in the Input.
- **SC-005**: `package/mock/README.md` accurately documents 100% of fixtures present in `package/mock/` (existing and new) with what each is for, verified by a maintainer read-through matching directory contents to documentation.

## Assumptions

- Automated detection of "shallow, renamed-only, not-really-modernized" migrations (the mechanism that would consume the Story 3 fixture as a regression test) is **out of scope for this spec** and is expected to be specified separately, likely as a new audit rule plus review-checklist item analogous to `view-logic-placement-*`. This spec only builds the bait fixture; User Story 3's Scenario 3 documents the gap as currently open rather than closing it.
- New fixtures target the java-spring stack pack only. `legacy-python-utils` stays as-is; Python fixture expansion is deferred until the Python stack pack reaches parity with java-spring (per the README.md roadmap), so investing in richer Python fixtures now would outpace what the Python pack can currently classify/migrate.
- "Real compile-time dependency" (Story 2) means a Maven/Gradle dependency relationship discoverable by the same static classification/dependency-resolution logic already used for Java sources — it does not require introducing a new build-graph analysis capability.
- The view-bearing fixture (Story 1) is deliberately solvable — it exists to prove the pipeline handles a realistic view-module case correctly, not to serve as an additional adversarial/bait fixture the way Story 3's fixture is.
- Existing mock-fixture regression tests referencing `package/mock/` by fixture count or specific file lists (if any exist in `migration/test/`) may need a new test added for the new fixtures, but no existing test's assertions about `legacy-customer-utils`/`legacy-python-utils` should need to change, since those directories are untouched (FR-007).
