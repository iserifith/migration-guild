# Contract: `view-logic-placement-*` audit rules

**Audience**: stack-pack authors; kit maintainers extending `migration/test`.

New rules in the pack's `audit.rules.yaml`, detected by the existing audit engine with no
runtime changes, reported through the existing findings path.

## Rule schema (existing — unchanged)

`id`, `finding`, `category`, `severity`, `match`, `flags`, `summary_template`,
`remediation`, optional `details_template`. Placeholders restricted to the closed vocabulary
`{symbol}`, `{line}`, `{text}`, `{version}`, `{target}` (validated by `validateTemplates` at
pack load).

## Rules in this feature

| id | finding | category | severity |
|----|---------|----------|----------|
| `view-logic-placement-inline-validation` | `jvm` | `view-logic-placement` | warning |
| `view-logic-placement-inline-business-rule` | `jvm` | `view-logic-placement` | warning |

## Detection contract

- **Subject**: content of registered artifacts (same scan substrate as the
  `view-regeneration-*` rules).
- **Positive signal (finding produced)**: inline validation signals (null/empty guards with
  throw/BindingResult branching, `matches(` pattern guards) or multi-branch business-rule
  logic in a handler-named class (`*Controller`, `*Resource`, `*Endpoint`) **without** a
  declared `*Validator` / `*Service` collaborator reference.
- **Negative signal (no finding)**: the handler references a collaborator matching the
  pack's `logic_extraction` suffixes — properly consolidated output produces zero findings
  (SC-003 false-positive requirement).
- **Severity**: `warning`. "Non-trivial" is judgment-bounded; the reviewer resolves
  borderline cases (spec Edge Cases). The category is distinct from `view-regeneration`
  (presence/absence) so triage can tell placement findings apart.

## Remediation contract

Each finding's remediation directs: extract the inline validation into the pack-declared
`*Validator` module (or business rule into `*Service`), delegate from the handler, and
deduplicate any rule copied across endpoints into one shared module.

## Findings path

Produced by `refreshCompatibilityAudits` → `replaceJvmAuditFindings` → surfaced by
`listJvmAuditFindings`; prompt/agent-layer placement findings create registry remediation
entries with `category "view-logic-placement"` via the existing `create-artifact` commands.
No parallel reporting mechanism (FR-005).
