# Phase 0 Research: Agent-First Migration Output

No `[NEEDS CLARIFICATION]` markers remained in the Technical Context — every design question
is resolvable from the issue body, the constitution, and the existing stack-pack/audit
architecture. This document records each decision, its rationale, and the alternatives
considered.

## Decision 1: Enforcement seam — stack-pack content only, no runtime changes

**Decision**: Implement the hard rule as (a) stack-pack mapping rules in `mappings.md`, (b) a
`view_contract` declaration in `stack.yaml`, (c) new audit rules in each pack's
`audit.rules.yaml`, and (d) prompt/skill checklist updates under `package/`. No changes to
`migration/` production code.

**Rationale**: FR-008 and constitution Principle VII explicitly mandate this seam. The audit
engine (`migration/guildctl/audit.ts:refreshCompatibilityAudits`) already loads rules from the
active pack's `audit.rules.yaml` and applies every rule's regex to the content of **every
registered artifact**, returning findings through `replaceJvmAuditFindings` /
`replaceDependencyFindings`. It is entirely data-driven — new rules need no engine change.

**Alternatives considered**:
- *A new pipeline phase*: rejected by the issue itself ("not a new phase") and FR-008.
- *A dedicated view-regeneration scanner in `migration/guildctl`*: rejected — duplicates the
  existing audit engine and violates VII (stack-specific vocabulary in core runtime).
- *Prompt-only guidance (no audit rules)*: rejected — prompts are advisory; the issue's core
  complaint is "nothing enforces this today." Regex audit rules are the kit's deterministic
  enforcement mechanism.

## Decision 2: How legacy view files enter the registry

**Decision**: Extend java-spring `stack.yaml` `source_globs` with `**/*.jsp`, `**/*.jspx`,
`**/*.xhtml` so JSP/JSF view files are registered as first-class `legacy-source` artifacts by
inventory, and add corresponding classification signals (`jsp`, `jsf` frameworks; role
`rest-endpoint` for view-bound handlers per the existing role vocabulary) to
`classification.yaml`.

**Rationale**: Today `source_globs: ["**/*.java"]`, so a `.jsp` file is invisible — it is
never registered, never classified, never audited. The hard rule cannot be enforced against an
artifact the registry does not know about. Registering view files makes them (1) scannable by
the audit engine, (2) plannable/migratable like any other artifact, (3) able to carry a
recorded drop decision (status `skipped` + tag + event) per FR-004. The registry role
vocabulary (constitution VII: "Classification MUST use the registry's role vocabulary") has no
view-specific role; view-bound handlers map to the existing `rest-endpoint` role (the role the
migrated contract-backed endpoint will carry), and purely-presentational views classify via
the pack's existing fallback/ambiguity handling.

**Alternatives considered**:
- *Leave view files unregistered and only grep for them in the audit prompt*: rejected —
  unregistered files leave no registry trail, so a drop decision would be invisible (violates
  FR-004 and Principle III).
- *Add a new registry role `view`*: rejected — would change `migration/registry/types.ts`
  (core runtime) for vocabulary that the constitution says packs must not invent; the
  `rest-endpoint` + framework tag combination carries the needed meaning.
- *Broad glob `**/*` with exclusions*: rejected — would sweep in resources, images, and build
  output; explicit view-technology extensions are precise and fail closed.

## Decision 3: Audit rule shape for view regeneration

**Decision**: Add rules to `audit.rules.yaml` in two families, following the existing rule
schema (`id`, `finding`, `category`, `severity`, `match`, `flags`, `summary_template`,
`remediation`, optional `details_template`):

- `view-regeneration-jsp` (finding `jvm`, category `view-regeneration`, severity **critical**):
  matches JSP file extensions and JSP directives/tags (`<%@`, `<jsp:`, `${`-EL in `.jsp`
  files is covered by the file-content scan once the artifact is registered).
- `view-regeneration-jsf` (critical): matches JSF/Facelets imports and namespaced tags
  (`javax.faces`, `jakarta.faces`, `<h:`, `<f:` prefixes in `.xhtml`).
- `view-regeneration-legacy-view-imports` (critical): legacy view-framework imports in
  migrated code — `org.apache.struts` view tags, `javax.servlet.jsp`, `JspException`,
  `PageContext`, `TagSupport`, etc.
- `view-regeneration-template-engine` (warning): target-side server-template usage that
  *renders legacy-derived views* (e.g. Thymeleaf `TemplateEngine` processing a migrated legacy
  template). Warning rather than critical because target-native views are a reviewable
  exception (spec Assumptions), so this finding routes to review instead of hard-blocking.

Rules use only the closed placeholder vocabulary (`{symbol}`, `{line}`, `{text}`,
`{version}`, `{target}`) — validated by `validateTemplates` at pack load.

**Rationale**: These rules slot into the existing findings path unchanged (FR-005, FR-006).
Severity `critical` for direct regeneration matches how the kit treats other prohibited-output
categories (e.g. internal-API, EOL dependency are critical); the template-engine case is
`warning` to preserve the "explicit, reviewable exception" path the spec's Assumptions
require.

**Alternatives considered**:
- *Single catch-all regex*: rejected — separate ids give findings a precise rule id and
  remediation (spec Story 2, Scenario 3) and let severity differ per case.
- *Severity `warning` for all*: rejected — the spec calls this a hard rule; a warning would
  allow silent progression inconsistent with SC-003's 100% catch requirement at blocking
  severity.

## Decision 4: Where the "modern/ tree scan" for regenerated UI lives

**Decision**: Two layers, both existing seams:

1. **Registry-backed**: view artifacts registered under `legacy/` are scanned by
   `refreshCompatibilityAudits` (Decision 1). For the `modern/` side, the audit *prompt*
   (`package/prompts/post-migration-audit.prompt.md`) and `audit-agent` gain a scan step that
   greps the `modern/` tree for view-technology traces (`.jsp`/`.xhtml` files, JSF/JSP
   imports, legacy CSS/asset copies) and reports them in the same structured findings format,
   creating registry remediation entries via the existing `create-artifact` commands the
   prompt already documents.
2. **Human/critic layer**: `migration-review` SKILL.md checklist + review-agent priorities.

**Rationale**: The runtime audit engine scans registered `legacy/` artifacts; the
post-migration prompt/agent scans the `modern/` output tree — that division already exists
today (the prompt's Step 4 greps `modern/` for legacy imports). The feature extends both
rather than inverting either.

**Alternatives considered**:
- *Extend the runtime engine to also walk `modern/`*: rejected — that is a runtime change
  (FR-008) and the prompt/agent layer already owns `modern/`-tree holistic review.

## Decision 5: Contract format declaration

**Decision**: A new optional `view_contract:` block in `stack.yaml`, e.g. for java-spring:

```yaml
view_contract:
  format: openapi          # pack-declared primary contract format
  style: rest              # REST endpoints for view-bound handlers
  alternates: [mcp-tools]  # acceptable pack-level additions
```

Consumed as pack *content* (read by prompts/skills via `readStackInstruction`-style access or
simple manifest reference), not by new runtime code. java-spring's declared default is
OpenAPI-style REST contracts, matching the spec's Assumptions; MCP tool schemas remain an
acceptable pack-level alternate.

**Rationale**: FR-009 requires the contract format to be a stack-pack-level declaration.
Putting it in `stack.yaml` keeps it behind the pack interface (Principle VII) and visible to
agents alongside the pack's other manifest data.

**Alternatives considered**:
- *Hardcode OpenAPI in the review checklist*: rejected — would leak a stack choice into a
  stack-neutral artifact.
- *New file `view-contract.yaml` per pack*: rejected — `stack.yaml` is already the pack's
  manifest; a separate file adds indirection with no benefit.

## Decision 6: Behavior preservation vs. presentation discard mechanics

**Decision**: `mappings.md` gains an explicit "View modules → API contracts" section stating:
(1) view-bound handlers (Struts actions, servlet page renderers, JSP-backed controllers) map
to contract-backed endpoints carrying their routing, parameter binding, validation, and
business logic; (2) layout/markup/styling/template structure is dropped, not ported; (3)
purely-presentational views are recorded as intentionally dropped (status `skipped` +
meaningful tag + event with reason), never regenerated; (4) low-confidence separation fails
closed to review (blocked/`blocked-human-decision` tag), consistent with constitution VI.

**Rationale**: Directly implements FR-001 through FR-004 and the issue's core risk note
("'discard layout' must not mean 'discard behavior'").

**Alternatives considered**:
- *Treat every view module as droppable*: rejected — violates FR-002 / SC-002 (behavior must
  survive).
- *Attempt automated layout extraction*: rejected — out of scope; the rule forbids porting
  presentation, it does not require transforming it.

## Decision 7: Python pack scope

**Decision**: The python pack receives no view-regeneration rules in this feature. Its
vocabulary (Flask/Django templates) has no legacy-view-UI regeneration failure mode analogous
to JSP/JSF, and its `mappings.md` already constrains framework changes. If a future python
view-layer gap is demonstrated, it lands as that pack's own rules — per Principle VII each pack
carries its own vocabulary.

**Rationale**: Avoids inventing rules with no evidence base in the pack's classification
vocabulary; keeps the change minimal and evidence-driven.

**Alternatives considered**: *Mirroring the java rules into python* — rejected as speculative
generality without a demonstrated gap.
