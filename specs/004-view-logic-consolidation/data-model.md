# Phase 1 Data Model: Consolidate Extracted View Logic into Dedicated Modules

This feature is a policy/content change to stack-pack files and shipped agent artifacts. Its
"entities" are the pack declarations, audit rules, and checklist items it introduces or
amends — not runtime data structures. Registry schema is unchanged; placement findings reuse
the existing `jvm_audit_findings` table via the extended category vocabulary (see research.md
Decision 8).

## Entities

### 1. Logic-extraction declaration (stack-pack manifest addition)

A new optional block in a stack pack's `stack.yaml`, sibling to `view_contract:`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `service_suffix` | string | yes | Name suffix marking a dedicated business-logic module (java-spring: `Service`) |
| `validator_suffix` | string | yes | Name suffix marking a dedicated validation module (java-spring: `Validator`) |
| `handler_roles` | string[] | yes | Registry role vocabulary values whose migrated handlers must only bind + delegate (java-spring: `[rest-endpoint]`) |

Validation rules:
- Suffixes are simple name suffixes (no glob/regex metacharacters); the audit rules and
  checklist derive their recognition patterns from them.
- `handler_roles` values MUST come from the registry role vocabulary (constitution VII —
  packs must not invent roles).
- Absence of the block in a pack means the pack declares no view-logic consolidation
  convention; placement rules are inert for that pack (python today).

### 2. Placement audit rule (pack audit-rule entries)

Entries in `audit.rules.yaml` following the existing rule schema, with
`category: view-logic-placement` and `severity: warning`.

| Field | Value for this feature |
|-------|------------------------|
| `id` | `view-logic-placement-inline-validation`, `view-logic-placement-inline-business-rule` |
| `finding` | `jvm` |
| `category` | `view-logic-placement` (new `JvmAuditCategory` literal; research.md Decision 8) |
| `severity` | `warning` (judgment-bounded; reviewer resolves borderline cases) |
| `match` / `flags` | Regex over artifact content targeting inline validation/business-rule signals in handler-named classes; `g` |
| `summary_template` / `remediation` / `details_template` | Closed placeholder vocabulary only (`{symbol}`, `{line}`, `{text}`, `{version}`, `{target}`); remediation directs extraction into a dedicated `*Validator` / `*Service` module |

Relationships:
- Produced by `refreshCompatibilityAudits` → stored via `replaceJvmAuditFindings` → surfaced
  by `listJvmAuditFindings`. Identical flow to `view-regeneration-*` findings (FR-005).
- Distinguished from `view-regeneration` findings by category: presence/absence of legacy
  view artifacts vs placement of extracted logic.

### 3. Mapping rule (pack instruction prose)

A placement subsection inside the java-spring `mappings.md` "View modules → API contracts"
section. Carries five normative statements (research.md Decision 4): consolidation into named
modules, handler = bind + delegate only, workspace-wide deduplication, single-use logic still
modularized, trivial pass-through exemption.

### 4. Review checklist item (shipped skill prose)

A new bullet in `package/skills/migration-review/SKILL.md` "View modules" checklist plus the
mirror bullet in `package/agents/review-agent.agent.md` priority 7, with quick-scan commands.
Failure severity: **Critical** (consistent with the section's existing convention).

### 5. Placement finding (runtime finding — existing shape, new category)

A `JvmAuditFinding` row whose `category` is `view-logic-placement`. Fields per the existing
model (`finding_id`, `artifact_id`, `tool`, `category`, `severity`, `symbol`, `summary`,
`evidence`, `remediation`, timestamps). No state transitions are introduced: findings are
records, not workflow artifacts.

## Unchanged entities (explicitly out of scope)

- Registry tables/schema, claims, evidence gates, arbitration — untouched (FR-007).
- `view_contract:` block and `view-regeneration-*` rules — unchanged; this feature layers on
  top (spec Assumptions: amends, not replaces).
- Python pack — no view-handling-module vocabulary, no placement rules (research.md
  Decision 7).
