# Feature Specification: Agent-First Migration Output

**Feature Branch**: `spec/issue-59`

**Created**: 2026-08-14

**Status**: Draft

**Input**: User description: "Proposal (issue #59): Agent-first interface as primary migration output. Hard rule: legacy view-handling modules (JSP, JSF, etc.) are transformed into structured API contracts (OpenAPI / MCP tool schemas), not UI components. The pipeline discards layout/styling and focuses on extracting business logic into tool schemas. Nothing enforces this today: the java-spring stack pack maps web frameworks to Spring MVC, and the post-migration audit only greps for leftover javax.servlet-era imports — there is no rule preventing an agent from regenerating view-layer UI. Implement as stack-pack mapping rules + audit.rules.yaml checks (e.g. 'no JSP-derived UI components in modern/'), not a new phase. Update the migration-review skill checklist to verify API-contract output for view modules. Risk: view handlers carry routing/validation logic worth keeping — 'discard layout' must not mean 'discard behavior'."

**Source issue**: #59 — Proposal: Agent-first interface as primary migration output (no UI components from legacy views).

**Governing document**: `.specify/memory/constitution.md` — principally VII (Pluggable Stacks, Neutral Providers: per-stack mapping and audit rules live in stack packs, not core runtime), V (Tests Before Production Code: behavior must be preserved and pinned, not discarded with the presentation layer), and the Repository Source-of-Truth Boundaries (shipped agent artifacts live in `package/`).

## User Scenarios & Testing *(mandatory)*

Primary persona: the **operator** running a migration, who needs the kit to produce agent-consumable API contracts from legacy view modules rather than regenerated UI. Secondary persona: the **migration agent**, which needs unambiguous stack-pack rules telling it what a view module becomes. Tertiary persona: the **reviewer** (human or critic agent), who needs the audit and review checklist to catch view-layer UI regeneration instead of allowing it silently.

### User Story 1 - View modules map to API contracts, never UI components (Priority: P1)

An operator runs the migration pipeline against a workspace whose legacy codebase contains view-handling modules (JSP pages, JSF views, Struts/JSP-bound actions, servlet-based page renderers). When those modules are migrated, the output under `modern/` is structured API contract definitions and the business behavior those views carried (routing, validation, request handling), expressed as contract-backed endpoints/tool schemas — never regenerated UI components (no JSP files, no JSF/Facelets, no server-side template rendering, no component trees, no CSS/layout assets ported from the view layer).

**Why this priority**: this is the core hard rule of the proposal. Every other story exists to enforce or verify this mapping. If this mapping rule does not exist, the rest of the feature has nothing to check.

**Independent Test**: migrate a workspace containing at least one legacy view-handling module. Delivers value if the resulting `modern/` output for that module consists of API contract definitions plus behavior-preserving endpoint/handler code, and contains zero regenerated view-layer UI artifacts.

**Acceptance Scenarios**:

1. **Given** a legacy view-handling module (e.g. a JSP page with an associated controller/action), **When** the migration pipeline processes it, **Then** the module's output in `modern/` is a structured API contract (OpenAPI-style or tool-schema-style contract) plus the extracted business behavior, and no UI component artifact is produced for it.
2. **Given** a legacy view module that mixes presentation with routing and validation logic, **When** it is migrated, **Then** the routing and validation behavior is preserved in the migrated output while the layout, markup, and styling are dropped — behavior extraction and presentation discard happen together, not as an either/or.
3. **Given** a legacy module that is purely presentational (no routing, validation, or business logic — e.g. a static layout template), **When** it is migrated, **Then** it is recorded as intentionally dropped (with a stated reason) rather than regenerated as UI, and the drop decision is visible in migration state rather than being silently absent.
4. **Given** any migrated workspace, **When** an observer inspects `modern/`, **Then** it contains no JSP files, no JSF/Facelets files, no server-side view templates derived from legacy views, and no ported legacy CSS/layout assets.

---

### User Story 2 - Audit flags view-layer UI regeneration in `modern/` (Priority: P2)

The post-migration audit gains rules that detect view-layer UI regeneration in the `modern/` output tree — JSP-derived artifacts, JSF/Facelets views, server-side template-engine view files, and legacy view-framework imports/usages in migrated code — and reports them as findings on the same terms as the existing audit rules (legacy servlet-era imports, EOL dependencies, etc.).

**Why this priority**: the audit is the existing enforcement seam the proposal names, and today it has a gap — it greps for `javax.servlet`-era imports but has no rule preventing regenerated view-layer UI. This closes that gap through the mechanism the constitution mandates for stack-specific rules: stack-pack audit rules, not core runtime changes.

**Independent Test**: introduce a deliberately regenerated view-layer UI artifact (e.g. a `.jsp` file or a JSF import) into a `modern/` tree and run the audit. Delivers value if the audit reports the artifact as a finding with a severity and remediation, on the same terms as existing audit findings.

**Acceptance Scenarios**:

1. **Given** a `modern/` tree containing a JSP-derived or JSF-derived UI artifact, **When** the post-migration audit runs, **Then** the artifact is reported as a finding identifying it as prohibited view-layer UI regeneration, with a remediation directing replacement by an API contract.
2. **Given** a `modern/` tree with no view-layer UI artifacts, **When** the post-migration audit runs, **Then** no view-regeneration findings are produced (no false positives on legitimate contract/handler code).
3. **Given** a view-regeneration finding, **When** an operator inspects it, **Then** it identifies the offending file, the rule that fired, and the remediation, in the same structured form as existing audit findings.

---

### User Story 3 - Review checklist verifies API-contract output for view modules (Priority: P3)

A reviewer (human or critic agent) using the migration-review checklist on a migrated view module is explicitly directed to verify that the module's output is an API contract plus preserved business behavior, and that no view-layer UI was regenerated — so the human-facing review loop matches the automated audit rule.

**Why this priority**: the automated audit (Story 2) catches mechanical violations, but review is the independent critic pass (constitution Principle IV); the checklist must ask the right question so a reviewer does not wave through regenerated UI that happens to compile.

**Independent Test**: review a migrated view module using the updated checklist. Delivers value if the checklist contains an explicit verification step for API-contract output and behavior preservation for view modules, and a reviewer following it would flag regenerated UI.

**Acceptance Scenarios**:

1. **Given** a migrated view module under review, **When** the reviewer follows the migration-review checklist, **Then** the checklist requires confirming the module produced an API contract and preserved routing/validation behavior.
2. **Given** a migrated view module that regenerated UI, **When** the reviewer follows the checklist, **Then** the checklist leads the reviewer to report it as a finding rather than approve it.

---

### Edge Cases

- What happens when a legacy view module's presentation and behavior are so entangled they cannot be cleanly separated (e.g. a JSP with heavy embedded scriptlet logic)? The rule must still drop the presentation; the embedded behavior is extracted into the contract-backed handler. If extraction confidence is too low, the artifact is flagged for review rather than silently regenerated as UI — fail-closed, consistent with constitution Principle VI.
- What happens when a stack pack targets a framework whose legitimate output includes server-rendered views (e.g. a Thymeleaf template in a Spring MVC app)? The rule distinguishes *legacy-derived* view regeneration (prohibited) from the target stack's own conventions. The default for this feature is agent-first: API contracts are the primary output, and any target-side server-rendered view must be an explicit, reviewable exception rather than the default mapping. (See Assumptions.)
- What happens when a legacy view has no behavior worth keeping? It is recorded as dropped with a stated reason (Story 1, Scenario 3) rather than producing an empty contract or a regenerated UI shell.
- What happens to view-adjacent static assets (images, legacy CSS)? They are presentation; the default is drop. Business-meaningful assets (e.g. downloadable files served by the app) are out of scope for this rule and handled by existing asset classification.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Each stack pack whose target platform supports web output MUST declare that legacy view-handling modules (JSP, JSF, servlet-based page renderers, and equivalent view technologies in the pack's classification vocabulary) map to structured API contracts — not to UI components — as part of its framework mapping rules.
- **FR-002**: The mapping MUST require behavior preservation: routing, request-parameter binding, validation, and business logic carried by a legacy view module MUST be extracted into the contract-backed output. Dropping presentation MUST NOT entail dropping behavior.
- **FR-003**: The mapping MUST require presentation discard: layout, markup, styling, and view-template structure of the legacy module MUST NOT be carried into `modern/` output.
- **FR-004**: Legacy view modules that are purely presentational (no extractable routing/validation/business behavior) MUST be recorded as intentionally dropped, with the drop decision and reason visible in migration state, rather than regenerated or silently omitted.
- **FR-005**: The stack pack's audit rules MUST include checks that detect view-layer UI regeneration in the `modern/` tree — legacy view-technology file types (e.g. `.jsp`, `.xhtml`/Facelets), legacy view-framework imports/usages, and server-side view-template rendering derived from legacy views — and report them as findings with severity and remediation, using the existing audit-rule mechanism (`audit.rules.yaml` or its equivalent in the pack).
- **FR-006**: View-regeneration audit findings MUST flow through the same findings/remediation path as existing audit findings (structured finding with rule id, offending file, severity, remediation) — this feature MUST NOT introduce a parallel reporting mechanism.
- **FR-007**: The migration-review checklist MUST direct reviewers to verify, for any migrated view module, that (a) the output is an API contract, (b) routing/validation/business behavior was preserved, and (c) no view-layer UI was regenerated.
- **FR-008**: This feature MUST be implemented as stack-pack mapping rules, stack-pack audit rules, and review-checklist updates — it MUST NOT add a new pipeline phase or change core runtime coordination code (registry, claims, evidence gates, arbitration).
- **FR-009**: The specific API contract format (OpenAPI document, MCP tool schema, or both) produced for a migrated view module MUST be a stack-pack-level declaration, so the agent-first output convention stays behind the stack-pack interface per constitution Principle VII.

### Key Entities

- **View-handling module**: A legacy source unit classified by a stack pack as part of the view layer (JSP page, JSF view, servlet page renderer, view-bound action) — distinguished from plain controllers/endpoints by carrying presentation responsibility.
- **API contract output**: The agent-first replacement for a migrated view module — a structured, machine-consumable interface definition (OpenAPI-style or tool-schema-style, as declared by the stack pack) plus the behavior-preserving endpoint/handler code backing it.
- **View-regeneration finding**: An audit finding produced when view-layer UI appears in `modern/`, carrying rule id, offending file, severity, and remediation, flowing through the existing audit findings path.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of legacy view-handling modules in a migrated workspace produce API contract output or a recorded intentional drop — zero produce regenerated UI components as their primary output.
- **SC-002**: For 100% of migrated view modules that carried routing or validation behavior, that behavior is present in the migrated output — no behavior is lost together with the discarded presentation.
- **SC-003**: A deliberately regenerated view-layer UI artifact placed in `modern/` is caught by the audit in 100% of cases, and a clean `modern/` tree produces zero false-positive view-regeneration findings.
- **SC-004**: A reviewer following the updated review checklist identifies regenerated view-layer UI in a migrated view module in 100% of cases where it exists.
- **SC-005**: The feature lands without any new pipeline phase and without changes to core runtime coordination code — 100% of the enforcement lives in stack packs and shipped agent artifacts.

## Assumptions

- **Contract format choice is per-stack-pack**: the issue names OpenAPI / MCP tool schemas as examples. Rather than fix one format globally (which would contradict constitution Principle VII's stable-interface rule), each stack pack declares which contract format(s) its view-module mapping produces. The java-spring pack's reasonable default is OpenAPI-style REST contracts; MCP tool-schema emission is an acceptable pack-level alternative or addition.
- **"Primary output" means default mapping, not a ban on all target-side views**: the rule prohibits *regenerating legacy-derived* UI. If a target stack legitimately uses server-rendered views, those are an explicit, reviewable exception — not the default mapping for a legacy view module. The default is always the API contract.
- **Enforcement seam is stack packs + audit + review checklist, as the issue specifies**: no new phase, no core runtime changes. The audit rules extend the existing `audit.rules.yaml` mechanism; the post-migration audit prompt may need to reference the new checks, and the review checklist update lands in the `migration-review` skill — all within `package/`, consistent with the repository source-of-truth boundaries.
- **This repo is the kit, not a workspace**: per the constitution, this specification describes kit behavior; validation of the rules happens in a fresh migration workspace outside this repository (using `package/mock/` or operator-supplied legacy code), not against this repo's root.
- **Scope excludes non-view web modules**: plain REST controllers/endpoints already map to API-style output under existing pack rules; this feature changes the treatment of modules that carry *presentation* responsibility. Asset handling (images, downloads) is unchanged.
- **Low-confidence extraction fails closed**: where a view module's behavior cannot be separated from presentation with reasonable confidence, the artifact is flagged for review rather than regenerated as UI — consistent with constitution Principle VI (Fail-Closed Automation).
