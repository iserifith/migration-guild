# Implementation Plan: Consolidate Extracted View Logic into Dedicated Modules

**Branch**: `spec/issue-100` | **Date**: 2026-08-15 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/004-view-logic-consolidation/spec.md`

## Summary

Amend #59's agent-first migration output rule so that validation/business logic extracted
from a migrated view-handling module lands in **dedicated, named service/validator modules**
— never inline in the contract-backed handler, never duplicated per-endpoint. Like #59, all
enforcement lives inside stack packs and shipped agent artifacts, with zero core-runtime
coordination changes:

1. **Mapping rule** (java-spring `mappings.md`): a placement subsection in the existing
   "View modules → API contracts" section — extracted validation consolidates into
   `*Validator`, business logic into `*Service`; the handler only binds and delegates;
   shared rules are deduplicated workspace-wide; trivial pass-through views need no
   ceremony. This narrows 003 research.md Decision 6's "carried into the contract-backed
   endpoint/handler" to "delegated to dedicated modules from the handler."
2. **Naming declaration** (java-spring `stack.yaml`): a new `logic_extraction:` block
   (sibling to `view_contract:`) declaring the `*Service` / `*Validator` suffix vocabulary
   and the handler roles that must only delegate — keeping the convention behind the pack
   interface (FR-008, Principle VII).
3. **Audit rules** (java-spring `audit.rules.yaml`): two `view-logic-placement-*` rules
   (category `view-logic-placement`, severity `warning`) firing on inline
   validation/business-rule signals in handler-named classes lacking a `*Service`/`*Validator`
   collaborator — checking *placement*, complementing the `view-regeneration-*`
   presence/absence rules. The post-migration audit prompt and audit-agent gain the
   matching holistic `modern/`-tree placement + duplication scan, reporting through the
   existing findings/registry path (FR-005).
4. **Review checklist** (`package/skills/migration-review/SKILL.md` + review-agent
   priority 7): an explicit placement-verification item alongside the existing "no
   regenerated UI" checks, with quick-scan commands; a placement failure is Critical.

## Technical Context

**Language/Version**: TypeScript (Node.js) for the runtime that *loads* the packs; the
change itself is authored content in YAML and Markdown — stack-pack manifests, audit-rule
regexes, mapping prose, prompt/skill checklists. One one-line type-level vocabulary addition
in `migration/registry/types.ts` (new `JvmAuditCategory` literal, findings vocabulary only —
research.md Decision 8).

**Primary Dependencies**: none new. Stack-pack loader
(`migration/guildctl/stack.ts`: `loadStackPack`, `validateTemplates`, placeholder vocabulary
`{symbol, line, text, version, target}`), audit engine
(`migration/guildctl/audit.ts`: `refreshCompatibilityAudits`, `collectLineMatches`),
findings store (`migration/registry/commands/modernization.ts`: `replaceJvmAuditFindings`,
`listJvmAuditFindings`), findings vocabulary (`migration/registry/types.ts`:
`JvmAuditCategory`).

**Storage**: SQLite registry (unchanged schema). Placement findings flow into the existing
`jvm_audit_findings` table; prompt-layer findings create remediation artifacts via the
existing `create-artifact` CLI with `category "view-logic-placement"`. No new tables.

**Testing**: `npm test` → `node --import tsx --test migration/test/*.test.ts`. New
`migration/test/audit-view-logic-placement.test.ts` (positive detection on an inlined
handler fixture, zero findings on a consolidated fixture — mirroring
`audit-view-regeneration.test.ts`) plus extended `stack-pack-engine.test.ts` (rule count,
`logic_extraction` manifest presence).

**Target Platform**: Same Node.js CLI as the rest of the kit; the *authored* rules target
Java/Spring Boot 3 (java-spring pack). The python pack has no view-handling-module
vocabulary and receives no placement rules (research.md Decision 7).

**Project Type**: Policy/content change to an existing CLI + stack-pack monorepo. No new
project, no new pipeline phase, no runtime coordination changes (FR-007).

**Performance Goals**: None — two additional regex rules applied per artifact line; same
order of cost as existing audit rules.

**Constraints**:
- Constitution Principle VII: naming vocabulary, mapping rules, and audit rules live in the
  stack pack / `package/` artifacts, not in `migration/` runtime code.
- FR-007: no new pipeline phase; no changes to registry coordination, claims, evidence
  gates, or arbitration.
- Audit placeholder vocabulary is closed (`{symbol, line, text, version, target}`); rule
  templates must use only these.
- `stacks/` ↔ `package/stacks/` parity must be preserved (the trees are mirrored).
- Placement audit severity is **warning**, not critical: "non-trivial" is judgment-bounded
  and the reviewer resolves borderline cases (spec Edge Cases).
- This feature amends, not replaces, the #59 rules: `view-regeneration-*` rules and the
  existing review items stay as-is.

**Scale/Scope**: java-spring pack (`mappings.md`, `stack.yaml`, `audit.rules.yaml` —
mirrored between `stacks/` and `package/stacks/`), `package/prompts/post-migration-audit.prompt.md`,
`package/agents/audit-agent.agent.md`, `package/skills/migration-review/SKILL.md`,
`package/agents/review-agent.agent.md`, one literal in `migration/registry/types.ts`, plus
tests and maintainer docs (CHANGELOGS.MD under Unreleased).

## Constitution Check

*GATE: Passed before Phase 0 research; re-evaluated after Phase 1 design — PASS, unchanged.*

Post-design re-evaluation: Phase 0/1 introduced the `logic_extraction` pack declaration, two
`view-logic-placement-*` audit rules, a mappings placement subsection, checklist/prompt
updates, and the `view-logic-placement` findings-category literal. Every element is
stack-pack data, shipped-agent content, or findings vocabulary; no core runtime
coordination, claim, evidence-gate, arbitration, or schema code is touched. The closed
audit-template placeholder vocabulary is respected (validated at pack load). The design
therefore still satisfies Principles I–VII exactly as assessed below, with no new
violations.

- **I. Evidence Over Assertion (NON-NEGOTIABLE)** — PASS. Placement findings are produced by
  the existing deterministic regex scan and recorded in the registry; prompt-layer findings
  create registry remediation entries. No self-report path is added.
- **II. Legacy Is Read-Only; `modern/` Is the Only Write Target (NON-NEGOTIABLE)** — PASS.
  The feature only *reads* artifact content (audit scans) and *writes* rules about `modern/`
  output placement. No new write scope.
- **III. Registry-Mediated Coordination** — PASS. Placement findings and remediation entries
  live in the registry via existing commands (`replaceJvmAuditFindings`, `create-artifact`).
  No new coordination channel; schema unchanged.
- **IV. Separation of Powers: Builder, Critic, Arbiter** — PASS. The review-checklist item
  strengthens the independent critic pass with an explicit placement question; the audit
  rules are an independent scanner at warning severity precisely so the critic — not the
  rule — makes the final borderline call. Neither grants self-approval.
- **V. Tests Before Production Code** — PASS (kit-behavior clause). The new audit rules and
  manifest declaration are kit behavior and MUST ship with `migration/test` regression
  coverage (see Testing): positive/negative detection through the real pack loader and audit
  engine against fixture workspaces.
- **VI. Fail-Closed Automation** — PASS. Warning-severity placement findings still surface
  as registry findings requiring resolution; the #59 fail-closed path for low-confidence
  behavior/presentation separation is unchanged (spec Edge Cases).
- **VII. Pluggable Stacks, Neutral Providers** — PASS. This feature is the principle applied:
  the `*Service`/`*Validator` naming vocabulary, mapping rule, and audit rules all live in
  the stack pack behind the existing loader interface (`logic_extraction` is pack data like
  `view_contract`). No provider-specific or stack-specific logic enters core runtime.

No violations requiring the Complexity Tracking table.

## Project Structure

### Documentation (this feature)

```text
specs/004-view-logic-consolidation/
├── plan.md              # This file ($speckit-plan command output)
├── research.md          # Phase 0 output ($speckit-plan command)
├── data-model.md        # Phase 1 output ($speckit-plan command)
├── quickstart.md        # Phase 1 output ($speckit-plan command)
├── contracts/           # Phase 1 output ($speckit-plan command)
│   ├── logic-extraction-declaration.md
│   └── audit-placement-rules.md
└── tasks.md             # Phase 2 output ($speckit-tasks command - NOT created by $speckit-plan)
```

### Source Code (repository root)

```text
stacks/java-spring/                    # mirror target for package/stacks parity
├── stack.yaml                         # + logic_extraction block (service/validator suffixes, handler_roles)
└── audit.rules.yaml                   # + view-logic-placement-inline-validation / -inline-business-rule (warning)
# (mappings.md mirrored in both trees — stack.yaml and audit.rules.yaml touched in both)

package/stacks/java-spring/            # shipped source of truth
├── stack.yaml                         # + logic_extraction block
├── mappings.md                        # + "placement of extracted logic" subsection in View modules section
└── audit.rules.yaml                   # + view-logic-placement-* rules

package/
├── prompts/post-migration-audit.prompt.md   # + placement scan step (inline logic + per-endpoint duplication)
├── agents/audit-agent.agent.md              # + matching placement scan step
├── agents/review-agent.agent.md             # + priority 7 bullet: dedicated-module placement check
└── skills/migration-review/SKILL.md         # + View modules checklist placement item + quick scans

migration/
├── registry/types.ts                  # + "view-logic-placement" JvmAuditCategory literal (vocabulary only)
└── test/
    ├── stack-pack-engine.test.ts      # extended: rule count, logic_extraction manifest assertion
    └── audit-view-logic-placement.test.ts  # new: positive/negative placement detection
```

**Structure Decision**: All enforcement lives in stack-pack files (mirrored between
`stacks/` and `package/stacks/`) and shipped `package/` agent artifacts. `migration/`
production code is untouched except a one-literal extension of the findings-category union
(research.md Decision 8) and its **test suite** (constitution V: kit behavior changes ship
with regression tests). This is the only structure consistent with FR-007, FR-008, and
Principle VII.

## Complexity Tracking

*No Constitution Check violations — table not needed.*
