# Contract: CLI Surface — Dependency Dispositions

**Feature**: `006-dependency-disposition` | **Date**: 2026-08-16

New subcommands on the registry CLI (`migration/registry/cli.ts`, commander) and
one new environment variable honored by the Plan command
(`migration/guildctl/commands/plan.ts`). Follows the exact conventions of the
existing `approve-dependency-strategy` / `list-dependency-findings` /
`record-scope-decision` commands: JSON output via the shared `run(...)` wrapper,
`RegistryError` for validation failures, `--approved-by`-style actor flags
required wherever a human decision is recorded.

## Registry CLI additions

```text
list-dispositions
  Description: List dependency disposition records (one per library).
  Options:
    --status <status>     proposed | confirmed
    --pending-only        Show only confirmed rows carrying a pending re-proposal
  Output: array of disposition rows, ORDER BY library_name ASC.

propose-disposition
  Description: Record or refine a proposed disposition for a library
               (planner-agent / collector / operator-policy writes).
  Required:
    --library <name>            Canonical library coordinates
    --disposition <kind>        keep | replace-with-native | inline
    --rationale <text>          Why this disposition is proposed
    --proposed-by <actor>       planner-collector | planner-agent | operator-policy
  Optional:
    --current-version <v>       Observed current version
    --native-replacement <name> Required when --disposition replace-with-native
    --inline-note <text>        Required when --disposition inline
    --locked-version <v>        Target version lock (for keep proposals)
    --usage-json <json>         Used-surface summary from usage analysis
  Notes: idempotent per research.md §8 — safe for the collector to re-run;
  never modifies confirmed primary columns (writes pending_* instead).

confirm-disposition
  Description: Confirm (optionally overriding) a library's disposition.
  Required:
    --library <name>            Canonical library coordinates
    --confirmed-by <name>       Operator or authorized automation actor
  Optional (override — any present ⇒ change_kind='override'):
    --disposition <kind>        keep | replace-with-native | inline
    --native-replacement <name>
    --inline-note <text>
    --locked-version <v>
    --rationale <text>          Override rationale (required with --disposition)
  Behavior: without override args on a row with pending_*, folds pending into
  primary. On a row with neither proposal nor pending → RegistryError(2).

locked-dependency-set
  Description: Print the deterministic locked dependency set (confirmed rows
               only, ORDER BY library_name ASC) — the artifact consumed by the
               version-locked doc-RAG proposal (FR-009).
  Options: none.
```

## Plan-command environment variable

```text
GUILDCTL_AUTO_CONFIRM_DISPOSITIONS=1
  Effect: after the Planner phase, confirmDispositions bulk-confirms every
  pending proposal (and folds every pending re-proposal) as
  confirmed_by='benchmark-runner', change_kind='auto-confirm'.
  Precedent: GUILDCTL_AUTO_CONFIRM_MAPPINGS (plan.ts:27),
  GUILDCTL_AUTO_CONFIRM_RISK (plan.ts:105),
  GUILDCTL_AUTO_APPROVE_DEPENDENCIES (plan.ts:519).
  Unset + non-interactive stdin: rows stay pending; a silence-first warning is
  printed ("set GUILDCTL_AUTO_CONFIRM_DISPOSITIONS=1 to bulk-confirm in
  automation"); the process does NOT hang, and the end-of-Plan readiness gate
  blocks sign-off (FR-006, FR-007).
```

## Plan-phase interactive flow (confirmDispositions, plan.ts)

Called AFTER the Phase 2b Planner phase completes (adjacent to
`confirmHighRiskArtifacts`, plan.ts:591), so pending dispositions never block
wave assignment mid-run (research.md §7). Mirrors `confirmMappings`'s prompt
shape, extended with the override affordance required by US2:

```text
  Proposed dependency dispositions — confirm each before planning sign-off:

  org.apache.commons:commons-lang3   → replace-with-native (java.lang.String / java.util.Objects)
    Used by 14 artifact(s); 3 helper method(s) dominate usage (StringUtils).
  Confirm? [y]es / [n]o skip / [e]dit disposition:
    y → confirmed, confirmed_by='operator'
    n → left proposed; counted in the end-of-Plan readiness gate
    e → prompt for new kind (keep | replace-with-native | inline), target, and
        rationale → recorded as override (change_kind='override')
```

Rows with a pending re-proposal are presented distinctly:

```text
  com.google.guava:guava   (confirmed: keep @31.1-jre)  → NEW PROPOSAL: replace-with-native (java.util)
    Re-run evidence: only com.google.common.base.Optional / Precondition imports remain.
  Accept new disposition? [y]es / [n]o keep current / [e]dit:
```

## Operator policy pre-declaration (spec edge case)

Operators MAY pre-seed policy before a run:

```text
node migration/dist/registry/cli.js propose-disposition \
  --library com.fasterxml.jackson.core:jackson-databind \
  --disposition keep --locked-version 2.17.2 \
  --rationale "Platform serialization standard — always keep" \
  --proposed-by operator-policy
node migration/dist/registry/cli.js confirm-disposition \
  --library com.fasterxml.jackson.core:jackson-databind --confirmed-by operator
```

The collector never overwrites such rows (confirmed status), and the record's
provenance (`proposed_by='operator-policy'`) is preserved and shown in
`list-dispositions` output.
