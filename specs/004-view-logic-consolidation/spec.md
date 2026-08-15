# Feature Specification: Consolidate Extracted View Logic into Dedicated Modules

**Feature Branch**: `spec/issue-100`

**Created**: 2026-08-15

**Status**: Draft

**Input**: User description: "Amendment to #59 (issue #100): #59's rule maps legacy view-handling modules (JSP/JSF/Struts) to structured API contracts, preserving routing/validation/business logic while discarding presentation — but leaves the *destination* of extracted logic unconstrained, so validation/business logic can end up inlined in the new controller/handler or duplicated per-endpoint. Require: (1) a mapping rule (java-spring mappings.md) that extracted business/validation logic from a migrated view-handling module MUST be consolidated into dedicated, named service/validator modules (e.g. *Service, *Validator), not left inline in the API-contract handler and not duplicated per-endpoint; (2) a new audit rule (audit.rules.yaml) that flags handlers/controllers backing a migrated view module that contain non-trivial validation/business-rule logic inline rather than delegating to a service/validator — checking *placement*, not just presence/absence of view-layer artifacts; (3) a review checklist item (migration-review SKILL.md) verifying extracted logic for a migrated view module lives in a dedicated module, alongside the existing 'no regenerated UI' check."

**Source issue**: #100 — Amendment to #59: require consolidation of extracted view-module logic into dedicated service/validator modules. Follow-up to #59 (spec/plan in `specs/003-agent-first-migration-output/`, merged via PR #101).

**Governing document**: `.specify/memory/constitution.md` — principally V (Tests Before Production Code: behavior must not only survive but remain maintainable and pinned by target-side tests), VII (Pluggable Stacks, Neutral Providers: mapping and audit rules live in stack packs, not core runtime), IV (Separation of Powers: the review checklist must let an independent critic catch placement violations), and the Repository Source-of-Truth Boundaries (shipped agent artifacts live in `package/`).

## User Scenarios & Testing *(mandatory)*

Primary persona: the **operator** running a migration, who needs extracted view-module behavior to land in maintainable, named modules rather than fat handlers. Secondary persona: the **migration agent**, which needs an unambiguous placement rule telling it where extracted validation/business logic goes. Tertiary persona: the **reviewer** (human or critic agent), who needs the audit and review checklist to catch inline-logic handlers that technically preserved behavior but scattered it.

### User Story 1 - Extracted view-module logic lands in dedicated service/validator modules (Priority: P1)

An operator runs the migration pipeline against a workspace whose legacy codebase contains view-handling modules carrying validation and business logic (e.g. a Struts action with request validation and business rules, a JSP-backed controller with embedded decision logic). When those modules are migrated, the extracted validation logic is consolidated into dedicated, named validator modules and the extracted business logic into dedicated, named service modules — the contract-backed endpoint/handler delegates to them and contains no non-trivial inline validation or business rules, and the same logic is never duplicated across multiple endpoints.

**Why this priority**: this is the core requirement of the amendment. #59 already guarantees behavior survives extraction (its FR-002, behavior preservation); this story determines *where* it lives. Without it, behavior survives in name but lands inline in handlers — unmaintainable, untestable in isolation, and prone to per-endpoint duplication — which is behavior loss one layer down, exactly what #59's scope note warned against.

**Independent Test**: migrate a workspace containing at least one legacy view-handling module that carries non-trivial validation and business logic. Delivers value if the resulting `modern/` output places that logic in dedicated, named service/validator modules, the endpoint/handler merely delegates, and no extracted rule is duplicated across endpoints.

**Acceptance Scenarios**:

1. **Given** a legacy view-handling module carrying validation and business logic, **When** the migration pipeline processes it, **Then** the validation logic lands in a dedicated, named validator module (e.g. `*Validator`) and the business logic in a dedicated, named service module (e.g. `*Service`), and the contract-backed endpoint/handler delegates to them rather than implementing the rules inline.
2. **Given** a legacy view module whose behavior spans several request paths (multiple endpoints backing the same migrated view module), **When** it is migrated, **Then** the shared validation/business logic is consolidated into one shared service/validator module used by all those endpoints — never copied per-endpoint.
3. **Given** a migrated view module's endpoint/handler, **When** an observer reads it, **Then** it contains only contract-binding and delegation code (routing, parameter binding, calling the service/validator, shaping the response) — no non-trivial inline validation or business-rule logic.
4. **Given** a legacy view module carrying only trivial pass-through behavior (no validation, no business rules beyond delegation), **When** it is migrated, **Then** no artificial empty service/validator module is required; the handler may delegate directly to an existing domain service, and the mapping rule does not force ceremony for its own sake.

---

### User Story 2 - Audit flags inline logic in handlers backing migrated view modules (Priority: P2)

The post-migration audit gains a rule that detects the *placement* failure: a handler/controller backing a migrated view module that contains non-trivial validation or business-rule logic inline instead of delegating to a dedicated service/validator module. This complements the existing `view-regeneration-*` rules, which only detect the *presence* of legacy view artifacts in `modern/` — the new rule fires even when the output is a perfectly valid API contract whose behavior was extracted but inlined.

**Why this priority**: the audit is the mechanical enforcement seam. Today an agent can satisfy every #59 rule — contract produced, behavior preserved, zero view artifacts — while still inlining all extracted logic in the handler. Story 1 declares the rule; this story makes violations detectable without a human reading every handler.

**Independent Test**: introduce a deliberately inlined handler (valid API contract, non-trivial validation/business logic inline, no service/validator delegation) backing a migrated view module into a `modern/` tree and run the audit. Delivers value if the audit reports the placement violation as a finding with severity and remediation, on the same terms as existing audit findings.

**Acceptance Scenarios**:

1. **Given** a `modern/` tree containing a handler backing a migrated view module with non-trivial validation/business logic inline and no delegation to a service/validator, **When** the post-migration audit runs, **Then** the handler is reported as a finding identifying the placement violation, with a remediation directing extraction into a dedicated service/validator module.
2. **Given** a `modern/` tree where migrated view-module handlers delegate to dedicated service/validator modules, **When** the post-migration audit runs, **Then** no placement findings are produced (no false positives on properly consolidated output).
3. **Given** a placement finding, **When** an operator inspects it, **Then** it identifies the offending handler, the rule that fired, and the remediation, in the same structured form as existing audit findings.

---

### User Story 3 - Review checklist verifies dedicated-module placement (Priority: P3)

A reviewer (human or critic agent) using the migration-review checklist on a migrated view module is explicitly directed to verify that extracted validation/business logic lives in dedicated service/validator modules and that the handler only delegates — alongside the existing "no regenerated UI" verification — so the human-facing review loop matches the new mapping rule and audit rule.

**Why this priority**: the automated audit (Story 2) catches mechanical violations, but review is the independent critic pass (constitution Principle IV); the checklist must ask the placement question so a reviewer does not wave through an inlined handler that happens to expose a valid contract.

**Independent Test**: review a migrated view module using the updated checklist. Delivers value if the checklist contains an explicit verification step for dedicated-module placement of extracted logic, and a reviewer following it would flag an inlined handler.

**Acceptance Scenarios**:

1. **Given** a migrated view module under review, **When** the reviewer follows the migration-review checklist, **Then** the checklist requires confirming that extracted validation/business logic lives in dedicated, named service/validator modules and that the handler only delegates.
2. **Given** a migrated view module whose handler contains non-trivial inline validation/business logic, **When** the reviewer follows the checklist, **Then** the checklist leads the reviewer to report it as a finding rather than approve it.

---

### Edge Cases

- **What counts as "non-trivial" logic?** The placement rule targets validation rules and business decisions extracted from the legacy view module — not the mechanical contract-binding code (routing annotations, parameter deserialization, response shaping) that is the handler's legitimate job. Where the line is genuinely ambiguous, the audit rule errs toward the lower-severity end and the review checklist makes the final call — consistent with the existing audit severity model (critical for hard violations, warning for judgment calls).
- **Multiple view modules with overlapping rules.** If two migrated view modules carried the same validation rule, the rule lands in one shared validator used by both — the consolidation requirement is workspace-wide deduplication, not one service per view module.
- **Behavior entangled with a single endpoint.** Even logic used by exactly one endpoint still gets its own named module: the point is isolating extracted behavior for testing and change, not only deduplication.
- **Trivial pass-through views.** A view module with no validation or business rules beyond delegation does not force an empty `*Service` shell (Story 1, Scenario 4); the rule requires consolidation of *extracted logic*, not ceremony.
- **Low-confidence separation (inherited from #59).** When the agent cannot confidently separate behavior from presentation, the #59 fail-closed rule still applies (artifact marked `blocked` with `blocked-human-decision`); this amendment does not change that path, it only constrains where confidently-extracted logic lands.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Each stack pack whose framework mapping rules cover legacy view-handling modules (starting with java-spring `mappings.md`) MUST declare that business and validation logic extracted from a migrated view-handling module is consolidated into dedicated, named service/validator modules (e.g. `*Service`, `*Validator`), and MUST NOT be left inline in the API-contract endpoint/handler.
- **FR-002**: The mapping MUST prohibit per-endpoint duplication: validation/business logic shared across multiple endpoints backing migrated view modules MUST live in one shared module used by all of them, never copied.
- **FR-003**: The mapping MUST scope the endpoint/handler's responsibility to contract binding and delegation (routing, parameter binding, invoking the service/validator, response shaping); non-trivial validation or business-rule logic MUST NOT appear inline in the handler.
- **FR-004**: The stack pack's audit rules MUST include a check that detects handlers/controllers backing migrated view modules that contain non-trivial inline validation/business-rule logic rather than delegating to a dedicated service/validator module, and reports them as findings with severity and remediation, using the existing audit-rule mechanism (`audit.rules.yaml` or its equivalent in the pack).
- **FR-005**: Placement audit findings MUST flow through the same findings/remediation path as existing audit findings (structured finding with rule id, offending file, severity, remediation) — this feature MUST NOT introduce a parallel reporting mechanism.
- **FR-006**: The migration-review checklist MUST direct reviewers to verify, for any migrated view module, that extracted validation/business logic lives in dedicated, named service/validator modules and that the handler only delegates — alongside the existing "no regenerated UI" verification.
- **FR-007**: This feature MUST be implemented as stack-pack mapping rules, stack-pack audit rules, and review-checklist updates — it MUST NOT add a new pipeline phase or change core runtime coordination code (registry, claims, evidence gates, arbitration).
- **FR-008**: The naming convention for the dedicated modules (the `*Service` / `*Validator` suffix vocabulary and how a handler's collaborator is recognized) MUST be a stack-pack-level declaration, so the consolidation convention stays behind the stack-pack interface per constitution Principle VII.

### Key Entities

- **View-handling module**: As defined by feature 003 — a legacy source unit classified by a stack pack as part of the view layer, carrying presentation responsibility alongside routing/validation/business behavior.
- **Dedicated service/validator module**: A target-side module with a single, named responsibility (`*Service` for business logic, `*Validator` for validation logic, per the pack's declared convention) that holds behavior extracted from a migrated view module and is invoked by one or more contract-backed handlers.
- **Placement finding**: An audit finding produced when a handler backing a migrated view module carries non-trivial inline validation/business logic instead of delegating, carrying rule id, offending file, severity, and remediation, flowing through the existing audit findings path.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of migrated view-handling modules that carried non-trivial validation/business logic place that logic in dedicated, named service/validator modules — zero leave it inline in the contract-backed handler.
- **SC-002**: For 100% of validation/business rules shared across multiple endpoints backing migrated view modules, exactly one shared module implements the rule — zero per-endpoint copies.
- **SC-003**: A deliberately inlined handler (valid contract, non-trivial inline logic, no service/validator delegation) backing a migrated view module is caught by the audit in 100% of cases, and properly consolidated output produces zero false-positive placement findings.
- **SC-004**: A reviewer following the updated review checklist identifies an inlined-logic handler backing a migrated view module in 100% of cases where it exists.
- **SC-005**: The feature lands without any new pipeline phase and without changes to core runtime coordination code — 100% of the enforcement lives in stack packs and shipped agent artifacts.

## Assumptions

- **"Non-trivial" is deliberately judgment-bounded**: a hard mechanical definition (e.g. a line count) would produce false positives on legitimate binding code and false negatives on compact rules. The audit rule fires on declared inline-logic signals the stack pack defines; borderline cases are warning-severity and resolved by the reviewer (constitution Principle IV). The plan phase may refine the exact signals; the spec fixes only the principle that placement — not just presence — is checked.
- **Naming convention is per-stack-pack**: the issue names `*Service` / `*Validator` as the java-spring examples. Rather than fix one convention globally (which would contradict constitution Principle VII's stable-interface rule), each stack pack declares its service/validator naming vocabulary, which the audit rule and review checklist then reference. java-spring's reasonable default is the `*Service` / `*Validator` suffix convention already idiomatic in Spring.
- **This amends, not replaces, the #59 rules**: the `view-regeneration-*` absence checks and the existing "no regenerated UI" review items stay as-is; this feature adds the placement layer on top. Where #59's artifacts say extracted logic is "carried into the contract-backed endpoint/handler" (research.md Decision 6), this amendment narrows that destination to "delegated to dedicated modules from the handler."
- **Enforcement seam is stack packs + audit + review checklist, as the issue specifies**: no new phase, no core runtime changes. The audit rules extend the existing `audit.rules.yaml` mechanism; the review checklist update lands in the `migration-review` skill — all within `package/`, consistent with the repository source-of-truth boundaries.
- **This repo is the kit, not a workspace**: per the constitution, this specification describes kit behavior; validation of the rules happens in a fresh migration workspace outside this repository (using `package/mock/` or operator-supplied legacy code), not against this repo's root.
- **Scope excludes non-view modules and already-clean handlers**: plain REST controllers/endpoints not derived from view-handling modules are governed by existing pack rules; this feature's mapping and audit requirements apply to output backing migrated *view-handling* modules. Whether the placement principle should later generalize to all migrated endpoints is a separate proposal.
- **No human was available during authoring**: this spec was written autonomously from the issue body; choices above (judgment-bounded "non-trivial", per-pack naming, view-module-only scope) are recorded here as explicit assumptions rather than clarification markers because reasonable defaults exist for each.
