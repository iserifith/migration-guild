# Implementation Plan: Agent-First Migration Output

**Branch**: `003-agent-first-migration-output` | **Date**: 2026-08-14 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/003-agent-first-migration-output/spec.md`

## Summary

Make API-contract output the mandatory default for legacy view-handling modules, and give the
kit three enforcement seams for that rule — all inside stack packs and shipped agent artifacts,
with zero core-runtime changes:

1. **Mapping rules** (stack-pack `mappings.md` + `stack.yaml` declaration): legacy
   view-handling modules (JSP, JSF/Facelets, servlet page renderers, view-bound Struts actions)
   map to structured API contracts plus behavior-preserving handlers — never to regenerated UI.
   Presentation (layout/markup/styling) is dropped; routing, parameter binding, validation, and
   business logic are extracted. The contract format (OpenAPI-style REST for java-spring) is a
   per-pack declaration in `stack.yaml` (new `view_contract:` block).
2. **Audit rules** (stack-pack `audit.rules.yaml`): new view-regeneration rules detect
   legacy-derived view artifacts in `modern/` (`.jsp`/`.xhtml`/Facelets files, JSF/JSP
   imports, legacy view-template usage) and report them as findings through the existing
   findings path. The post-migration audit prompt and audit-agent gain a corresponding scan
   step. Because the runtime audit engine (`migration/guildctl/audit.ts`) scans **all**
   registered artifacts with the pack's regex rules — not only `.java` files — `.jsp` view
   artifacts registered by inventory are covered with no engine changes.
3. **Review checklist** (`package/skills/migration-review/SKILL.md` + review-agent
   priorities): explicit verification that a migrated view module produced an API contract,
   preserved its routing/validation behavior, and regenerated no UI.

Supporting change: java-spring `stack.yaml` `source_globs` gains `**/*.jsp`, `**/*.jspx`,
`**/*.xhtml` so legacy view files enter the registry as first-class artifacts (today they are
silently invisible, which would make view modules neither migratable nor auditable).

## Technical Context

**Language/Version**: TypeScript (Node.js) for the runtime that *loads* the packs; the change
itself is authored content in YAML and Markdown — stack-pack manifests, audit-rule regexes,
mapping prose, prompt/skill checklists.

**Primary Dependencies**: none new. Stack-pack loader
(`migration/guildctl/stack.ts`: `loadStackPack`, `validateTemplates`, placeholder vocabulary
`{symbol, line, text, version, target}`), audit engine
(`migration/guildctl/audit.ts`: `refreshCompatibilityAudits`, `collectLineMatches`),
inventory (`migration/guildctl/commands/inventory.ts`: `scanAndRegister` over
`source_globs`), classification contract (`loadClassificationSpec` /
`classification.yaml`).

**Storage**: SQLite registry (unchanged schema). View-regeneration findings flow into the
existing `jvm_audit_findings` table via `replaceJvmAuditFindings`; intentional-drop decisions
use existing artifact `status: skipped` + `tags` (`classification.yaml` `tags.meaningful`
already provides the mechanism; a new meaningful tag value is pack data, not a schema change)
plus an artifact event — no new tables.

**Testing**: `npm test` → `node --import tsx --test migration/test/*.test.ts`. New/extended
coverage in `migration/test/stack-pack-engine.test.ts` (pack rule count, view-rule regex
behavior) and a new `migration/test/audit-view-regeneration.test.ts` (positive/negative
detection against a fixture workspace). Existing convention: one test file per behavior slice.

**Target Platform**: Same Node.js CLI as the rest of the kit; the *authored* rules target
Java/Spring Boot 3 (java-spring pack) with the python pack receiving the analogous rule shape
only if it has view-layer vocabulary (it does not today — documented as an assumption).

**Project Type**: Policy/content change to an existing CLI + stack-pack monorepo. No new
project, no new pipeline phase, no runtime coordination changes.

**Performance Goals**: None — a handful of additional regex rules applied per artifact line;
same order of cost as existing audit rules.

**Constraints**:
- Constitution Principle VII: all view-mapping and view-audit knowledge MUST live in stack
  packs / `package/` artifacts, not in `migration/` runtime code.
- FR-008: no new pipeline phase; no changes to registry coordination, claims, evidence gates,
  or arbitration.
- Audit placeholder vocabulary is closed (`{symbol, line, text, version, target}`); rule
  templates must use only these.
- `stacks/` ↔ `package/stacks/` parity must be preserved (DEVELOPMENT.md checklist; the trees
  are currently mirrored except for pre-existing python drift this feature does not touch).
- Legacy-derived view regeneration is prohibited; target-stack-native views are an explicit,
  reviewable exception, not a default mapping (spec Assumptions).

**Scale/Scope**: java-spring pack (mappings, stack.yaml, audit.rules.yaml, classification
signals), `package/prompts/post-migration-audit.prompt.md`, `package/agents/audit-agent.agent.md`,
`package/skills/migration-review/SKILL.md`, `package/agents/review-agent.agent.md`, plus tests
and maintainer docs (CHANGELOGS.MD, DEVELOPMENT.md if workflow notes are needed).

## Constitution Check

*GATE: Passed before Phase 0 research; re-evaluated after Phase 1 design — PASS, unchanged.*

Post-design re-evaluation: Phase 0/1 introduced the `view_contract` pack declaration, four
`view-regeneration-*` audit rules, classification signals, widened `source_globs`, and
prompt/skill checklist updates. Every element is stack-pack data or shipped-agent content;
no core runtime coordination, claim, evidence-gate, or arbitration code is touched. The
closed audit-template placeholder vocabulary is respected (validated at pack load). The
design therefore still satisfies Principles I–VII exactly as assessed above, with no new
violations.

- **I. Evidence Over Assertion (NON-NEGOTIABLE)** — PASS. Findings are produced by the
  existing deterministic regex scan and recorded in the registry; drop decisions are recorded
  artifact state (status + tag + event), not chat claims. No self-report path is added.
- **II. Legacy Is Read-Only; `modern/` Is the Only Write Target (NON-NEGOTIABLE)** — PASS.
  The feature only *reads* legacy view files (inventory + audit scans) and *writes* rules about
  `modern/` output. No new write scope. Adding `*.jsp`/`*.xhtml` to `source_globs` is a read
  expansion only.
- **III. Registry-Mediated Coordination** — PASS. View artifacts, findings, and drop decisions
  all live in the registry via existing commands (`registerArtifact`, `replaceJvmAuditFindings`,
  status/tag/event updates). No new coordination channel.
- **IV. Separation of Powers: Builder, Critic, Arbiter** — PASS. The review-checklist update
  strengthens the independent critic pass; the audit is an independent scanner. Neither grants
  self-approval.
- **V. Tests Before Production Code** — PASS (kit-behavior clause). The new audit rules and
  the `source_globs`/classification changes are kit behavior and MUST ship with
  `migration/test` regression coverage (see Testing). Rule regexes are verified by tests that
  run the real pack loader and audit engine against fixture workspaces.
- **VI. Fail-Closed Automation** — PASS. Per spec, low-confidence behavior/presentation
  separation flags the artifact for review (blocked/needs-human-decision tags exist) rather
  than regenerating UI; audit rules fire closed on any legacy-view trace in `modern/`.
- **VII. Pluggable Stacks, Neutral Providers** — PASS. This feature is the principle applied:
  contract format, view-technology vocabulary, mapping rules, and audit rules all live in the
  stack pack behind the existing loader interface. The closed placeholder vocabulary is
  respected; no provider-specific logic is introduced.

No violations requiring the Complexity Tracking table.

## Project Structure

### Documentation (this feature)

```text
specs/003-agent-first-migration-output/
├── plan.md              # This file ($speckit-plan command output)
├── research.md          # Phase 0 output ($speckit-plan command)
├── data-model.md        # Phase 1 output ($speckit-plan command)
├── quickstart.md        # Phase 1 output ($speckit-plan command)
├── contracts/           # Phase 1 output ($speckit-plan command)
└── tasks.md             # Phase 2 output ($speckit-tasks command - NOT created by $speckit-plan)
```

### Source Code (repository root)

```text
stacks/java-spring/                    # mirror target for package/stacks parity
├── stack.yaml                         # + view globs in source_globs; + view_contract block
├── classification.yaml                # + jsp/jsf frameworks, view signals (priority-ordered)
├── mappings.md                        # + view-module → API-contract mapping rules
└── audit.rules.yaml                   # + view-regeneration rules (view-regeneration-*)

package/stacks/java-spring/            # shipped source of truth (same four files)
package/
├── prompts/post-migration-audit.prompt.md   # + Step 4b view-regeneration scan + report section
├── agents/audit-agent.agent.md              # + matching scan step
├── agents/review-agent.agent.md             # + review priority: view modules → API contracts
└── skills/migration-review/SKILL.md         # + view-module checklist section

migration/test/
├── stack-pack-engine.test.ts          # extended: rule count, view-rule presence
└── audit-view-regeneration.test.ts    # new: positive/negative view-regeneration detection
                                       #   + .jsp artifact registration via inventory
```

**Structure Decision**: All enforcement lives in stack-pack files (mirrored between
`stacks/` and `package/stacks/`) and shipped `package/` agent artifacts. `migration/` runtime
code is untouched except its **test suite** (constitution V: kit behavior changes ship with
regression tests). This is the only structure consistent with FR-008 and Principle VII.

## Complexity Tracking

*No Constitution Check violations — table not needed.*
