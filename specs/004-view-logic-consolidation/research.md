# Phase 0 Research: Consolidate Extracted View Logic into Dedicated Modules

No `[NEEDS CLARIFICATION]` markers remained in the Technical Context — every design question
is resolvable from the issue body, the spec's recorded Assumptions, the constitution, and the
stack-pack/audit architecture established by feature 003. This document records each
decision, its rationale, and the alternatives considered.

## Decision 1: Enforcement seam — stack-pack content + shipped agent artifacts only

**Decision**: Implement the consolidation requirement as (a) a placement subsection in the
java-spring pack's `mappings.md` "View modules → API contracts" section, (b) a pack-declared
naming vocabulary in `stack.yaml`, (c) new placement audit rules in the pack's
`audit.rules.yaml`, (d) a placement scan step in `package/prompts/post-migration-audit.prompt.md`
and `package/agents/audit-agent.agent.md`, and (e) a placement checklist item in
`package/skills/migration-review/SKILL.md` mirrored into `package/agents/review-agent.agent.md`.
No changes to `migration/` production code; only its test suite gains coverage.

**Rationale**: FR-007 and constitution Principle VII mandate this seam — identical to the
003 feature's Decision 1. The audit engine (`migration/guildctl/audit.ts`) is data-driven over
pack rules; the post-migration audit prompt/agent owns the holistic `modern/`-tree review;
the review skill/agent is the independent critic pass (Principle IV).

**Alternatives considered**:
- *A new pipeline phase or runtime placement analyzer*: rejected by FR-007 ("MUST NOT add a
  new pipeline phase or change core runtime coordination code") and by the issue itself.
- *Prompt-only guidance with no audit rules*: rejected — the issue's core complaint is that
  nothing checks placement; advisory text without a deterministic signal repeats the #59 gap
  one layer down.

## Decision 2: Naming vocabulary is a pack-level declaration (`logic_extraction` in stack.yaml)

**Decision**: java-spring `stack.yaml` gains a declaration naming the dedicated-module
vocabulary and the handler-collaborator recognition rule:

```yaml
logic_extraction:
  service_suffix: Service        # business-logic modules: *Service
  validator_suffix: Validator    # validation modules: *Validator
  handler_roles: [rest-endpoint] # contract-backed handlers that must only bind + delegate
```

Consumed as pack content (prompts/skills reference it alongside `view_contract`), not by new
runtime code. The `*Service` / `*Validator` suffixes are the idiomatic Spring convention the
issue names; per FR-008 the vocabulary stays behind the pack interface so another stack can
declare its own.

**Rationale**: FR-008 explicitly requires the naming convention to be a stack-pack-level
declaration. Co-locating it with `view_contract:` in `stack.yaml` keeps all view-migration
policy in one manifest, readable by the same agents.

**Alternatives considered**:
- *Hardcode `*Service`/`*Validator` in the audit rule regexes and checklist prose only*:
  rejected — leaks a stack convention into stack-neutral artifacts and gives the audit rule no
  declared vocabulary to reference (violates the spirit of Principle VII / FR-008).
- *Global convention in `.specify` or core docs*: rejected — contradicts VII's stable-interface
  rule; one stack's idiom is not every stack's.

## Decision 3: Audit rule shape — two-layer placement detection

**Decision**: Placement is checked at two layers, mirroring how 003 split presence/absence
detection:

1. **Pack regex rules** (`audit.rules.yaml`, deterministic, registry-backed). New category
   `view-logic-placement` with rules that fire on declared inline-logic signals in migrated
   handler/controller source:
   - `view-logic-placement-inline-validation` (**warning**): field/parameter validation
     statements (`if (... == null)`, `isEmpty`, `throws IllegalArgumentException`,
     `BindingResult` branching, regex `matches(` guards) appearing inline in a class whose
     name ends in the handler vocabulary (`*Controller`, `*Resource`, `*Endpoint`) without a
     `*Validator` collaborator reference.
   - `view-logic-placement-inline-business-rule` (**warning**): multi-branch business
     decision logic (`if/else if` chains over domain state, computation/accumulation) inline
     in a handler-named class without a `*Service` collaborator reference.

   Severity is **warning**, not critical, per the spec's Edge Cases: "non-trivial" is
   judgment-bounded; the deterministic layer surfaces candidates and the reviewer makes the
   final call. Regexes operate on the content of registered artifacts exactly like the
   existing `view-regeneration-*` rules and use only the closed placeholder vocabulary
   (`{symbol, line, text, version, target}`) validated by `validateTemplates`.

2. **Prompt/agent layer** (`post-migration-audit.prompt.md` step, `audit-agent.agent.md`
   step): a holistic `modern/`-tree scan that greps for handler-named classes lacking any
   `*Service`/`*Validator` collaborator while containing validation/business-rule signal
   patterns, and for duplicated rule blocks across endpoints (same validation predicate in 2+
   handlers). Findings are reported through the same structured findings + registry-entry
   path as existing audit output (FR-005).

**Rationale**: The regex layer gives a deterministic, testable signal that runs through the
existing engine with zero runtime changes; the prompt/agent layer supplies the judgment the
spec assigns to review (cross-file duplication and "non-trivial" assessment are not
line-regex-decidable). This is exactly the two-layer split 003 used for view regeneration
(engine rules + modern/ tree scan), keeping the enforcement model consistent.

**Alternatives considered**:
- *Critical severity on the regex rules*: rejected — inline-binding-adjacent code (e.g. a
  one-line null guard on a required path parameter) would false-positive at blocking severity;
  the spec fixes the principle that borderline cases are warnings resolved by review.
- *Single catch-all "fat handler" regex*: rejected — separate rule ids give precise
  remediation text (extract to `*Validator` vs extract to `*Service`) and let tests assert
  each signal independently.
- *AST-based analysis in the runtime*: rejected — runtime change (FR-007) and grossly
  disproportionate to the signal needed.

## Decision 4: Mapping rule content — consolidation, no inline logic, no duplication

**Decision**: java-spring `mappings.md` "View modules → API contracts" section gains a
placement subsection stating, for view-handling modules:

1. **Extracted validation logic consolidates into a dedicated, named validator module**
   (`*Validator` per the pack's `logic_extraction` declaration); **extracted business logic
   into a dedicated, named service module** (`*Service`).
2. **The contract-backed endpoint/handler only binds and delegates**: routing, parameter
   binding, invoking the service/validator, shaping the response. Non-trivial validation or
   business-rule logic MUST NOT appear inline in the handler.
3. **No per-endpoint duplication**: validation/business rules shared across multiple
   endpoints backing migrated view modules live in one shared module used by all of them —
   workspace-wide deduplication, not one module per view.
4. **Single-use logic still gets its own module**: isolation for testing and change is the
   point, not only deduplication.
5. **Trivial pass-through views need no ceremony**: a view module with no validation or
   business rules beyond delegation does not force an empty `*Service` shell; the handler may
   delegate directly to an existing domain service (spec Story 1 Scenario 4).

Where 003's research.md Decision 6 said extracted logic is "carried into the contract-backed
endpoint/handler," this subsection narrows the destination: carried to the handler's
*collaborators*, with the handler delegating.

**Rationale**: Implements FR-001, FR-002, FR-003 verbatim at the mapping seam the issue
names. Keeping it inside the existing "View modules" section (which already declares "this
section wins" precedence) means the placement rule inherits the same hard-rule status.

**Alternatives considered**:
- *A separate `placement.md` instruction file*: rejected — splits one rule across two files;
  the mappings section is where agents already read the view-module rule.
- *Amending 003's artifacts instead*: rejected — the issue explicitly tracks this as its own
  amendment cycle; 003 is merged and closed.

## Decision 5: Review checklist content — one explicit placement item

**Decision**: `package/skills/migration-review/SKILL.md` "View modules" checklist gains a
bullet requiring the reviewer to confirm, for every migrated view-handling module: extracted
validation/business logic lives in dedicated, named `*Service`/`*Validator` modules; the
handler contains only contract-binding and delegation code; and no extracted rule is
duplicated across endpoints. Failure is **Critical** (a finding, not an approval), matching
the section's existing severity convention. Quick-scan commands are added alongside the
existing view-regeneration greps: list handler-named classes, check each for a
`*Service`/`*Validator` collaborator reference and for inline validation/business signal
patterns. `package/agents/review-agent.agent.md` priority 7 gains the corresponding bullet so
the automated critic applies the same check.

**Rationale**: FR-006, and constitution Principle IV — the human/critic pass must ask the
placement question explicitly so an inlined handler with a valid contract is not waved
through.

**Alternatives considered**:
- *Folding placement into the existing "behavior preserved" bullet*: rejected — that bullet
  checks presence of behavior, not its placement; the issue's gap is precisely that a handler
  can satisfy it while inlining everything.

## Decision 6: Test coverage approach

**Decision**: Extend `migration/test/stack-pack-engine.test.ts` (rule-count and
`logic_extraction` manifest assertions) and add
`migration/test/audit-view-logic-placement.test.ts` mirroring
`audit-view-regeneration.test.ts`: fixture workspaces with (a) an inlined-logic handler
backing a migrated view module → expect `view-logic-placement` warning findings; (b) a
properly consolidated handler + `*Service`/`*Validator` → expect zero placement findings
(no false positives). Tests run the real pack loader and audit engine per the existing
convention.

**Rationale**: Constitution V's kit-behavior clause — new pack rules are kit behavior and
ship with regression coverage through the same test seam 003 used.

**Alternatives considered**: *Prompt-layer-only tests*: rejected — prompt content is not
unit-testable; the deterministic rules are the testable seam.

## Decision 7: Python pack scope

**Decision**: The python pack receives no placement rules in this feature, matching 003's
Decision 7 — it has no legacy view-handling-module vocabulary (no JSP/JSF/Struts analogue),
so there is no extracted-view-logic placement failure mode to constrain. Per FR-001 the
requirement binds "each stack pack whose framework mapping rules cover legacy view-handling
modules (starting with java-spring)"; python does not today.

**Alternatives considered**: *Mirroring the rules into python*: rejected as speculative
generality without a demonstrated gap (Principle VII: each pack carries its own vocabulary).

## Decision 8: Registry category vocabulary

**Decision**: Placement findings use a new JvmAuditCategory value `view-logic-placement`.
The category union (`migration/registry/types.ts`) is part of the findings-vocabulary seam
that 003 already extended with `view-regeneration`; adding one literal to that union is the
same class of change — findings vocabulary, not coordination logic — and is the minimal way
for placement findings to flow through the existing `jvm_audit_findings` path with a
distinguishing category (FR-005). No schema, claim, evidence-gate, or arbitration change.

**Rationale**: FR-005 requires findings to flow through the existing path; reusing the
`view-regeneration` category for placement findings would conflate two different rules and
confuse remediation triage.

**Alternatives considered**:
- *Reuse `deprecated-api` or a generic category*: rejected — miscategorizes the finding and
  breaks category-level triage/reporting.
- *Stringly-typed category with no union extension*: rejected — the union is the type-level
  contract; bypassing it is worse than extending it.
