# Data Model: Planner-Emitted Dependency Disposition Records

**Feature**: `006-dependency-disposition` | **Date**: 2026-08-16

All state lives in the workspace SQLite registry (`migration/registry_schema.sql`,
WAL mode), per Principle III. Two new tables are added; no existing table is
modified. Field-level contracts (SQL DDL, indexes, query shapes) are in
[contracts/registry-schema.md](./contracts/registry-schema.md).

## Entity 1: Dependency Disposition Record (`dependency_dispositions`)

Exactly one row per third-party library per workspace — `library_name UNIQUE`
enforces SC-001 at the schema level. The primary columns always hold the
**current** decision (the confirmed one, or the standing proposal when nothing
is confirmed yet). A pending re-proposal against an already-confirmed decision
lives in a separate `pending_*` column group on the same row (research.md §8),
never as a second row.

| Field | Type | Constraints | Notes |
|---|---|---|---|
| `disposition_id` | TEXT | PRIMARY KEY | Stable id: `dep-<sha1(library_name)[:12]>` — deterministic, so re-runs address the same row. |
| `library_name` | TEXT | NOT NULL, UNIQUE | Canonical library coordinates, e.g. `org.apache.commons:commons-lang3` or the manifest-declared name. |
| `current_version` | TEXT | NULL | Version observed in findings/manifests (MAX when several observed). NULL when version evidence could not be scanned (FR-012). |
| `disposition` | TEXT | NOT NULL, CHECK IN ('keep','replace-with-native','inline') | FR-002: exactly three kinds. |
| `status` | TEXT | NOT NULL, CHECK IN ('proposed','confirmed') | A row is a *proposal* until confirmed (US2). |
| `native_replacement` | TEXT | NULL | Required when `disposition='replace-with-native'`; the Java 17/21 (or stack-appropriate) platform equivalent, e.g. `java.time`. |
| `inline_note` | TEXT | NULL | Required when `disposition='inline'`; describes the used helper surface to be provided inline in target code. No inlining is performed (FR-013). |
| `locked_target_version` | TEXT | NULL | Required when `disposition='keep'` AND `status='confirmed'`; the single resolved target version (FR-008). |
| `rationale` | TEXT | NOT NULL | Human-readable why; also records version-conflict resolutions (FR-008) and scan limitations (FR-012) where applicable. |
| `usage_json` | TEXT | NULL | JSON used-surface summary from import/usage analysis: `{ "using_artifacts": [ids…≤20], "using_artifact_count": N, "import_count": M, "scan_notes": […] }`. |
| `proposed_by` | TEXT | NOT NULL | Proposing actor: `planner-collector` (deterministic seed), `planner-agent`, or `operator-policy` (spec edge case: pre-declared policy). |
| `confirmed_by` | TEXT | NULL | Confirming actor: operator name, or `benchmark-runner` under the auto-confirm env var (FR-006). NULL while proposed. |
| `confirmed_at` | TEXT | NULL | Confirmation timestamp; set iff `confirmed_by` set (same invariant as feature 005's decided_by/decided_at). |
| `pending_disposition` | TEXT | NULL, CHECK IN ('keep','replace-with-native','inline') | FR-011: changed proposal against an already-confirmed row. When non-NULL the row counts as unresolved for readiness gating. |
| `pending_native_replacement` | TEXT | NULL | Pending target when `pending_disposition='replace-with-native'`. |
| `pending_inline_note` | TEXT | NULL | Pending note when `pending_disposition='inline'`. |
| `pending_locked_target_version` | TEXT | NULL | Pending lock when `pending_disposition='keep'`. |
| `pending_rationale` | TEXT | NULL | Why the re-proposal differs from the confirmed decision. |
| `pending_proposed_by` | TEXT | NULL | Actor of the pending proposal. |
| `pending_at` | TEXT | NULL | When the pending proposal was recorded. |
| `created_at` | TEXT | NOT NULL DEFAULT datetime('now') | |
| `updated_at` | TEXT | NOT NULL DEFAULT datetime('now') | |

**Validation rules** (enforced in `migration/registry/commands/dispositions.ts`,
mirroring `approveDependencyStrategy`'s argument validation):

- `disposition='replace-with-native'` ⇒ `native_replacement` non-empty.
- `disposition='inline'` ⇒ `inline_note` non-empty.
- Transition to `status='confirmed'` with `disposition='keep'` ⇒
  `locked_target_version` non-empty (FR-008).
- Transition to `status='confirmed'` ⇒ `confirmed_by` non-empty AND
  `confirmed_at` set in the same statement — never a bare status flip.
- Confirming a pending re-proposal atomically folds the `pending_*` values into
  the primary columns and NULLs the pending group, in one transaction that first
  snapshots the row to history.
- `rationale` must be non-empty for every write (mirrors
  `approveDependencyStrategy`'s `--rationale is required`).

State machine:

```text
              collector/agent writes proposal
   (none) ────────────────────────────────────▶ proposed ──confirm──▶ confirmed
                    ▲                               │                   │
                    │                               │ override (y/n/e)  │ re-run: changed evidence
                    │                               ▼                   ▼
                    │                         proposed (proposal    confirmed + pending_*
                    │                         fields replaced)      (current decision stays
                    │                                             in effect; row unresolved)
                    │                               ▲                   │
                    │                               │                   │ confirm pending
                    │                               └── operator edits  ▼
                    │                                                   confirmed (pending folded
                    │                                                   into primary, prior → history)
                    │
            every mutation snapshots the prior row to dependency_disposition_history
```

## Entity 2: Disposition History (`dependency_disposition_history`)

Append-only audit trail; no row is ever updated or deleted. Mirrors the
repository's `audit_overrides` / `scope_decisions` audit posture: decisions are
never silently lost (Principle I).

| Field | Type | Notes |
|---|---|---|
| `history_id` | TEXT PRIMARY KEY | `deph-<sha1(disposition_id|ts|rand)[:16]>` (same id shape as `audit_overrides.ovr-`). |
| `disposition_id` | TEXT NOT NULL | The live row this snapshot was taken from. |
| `library_name` | TEXT NOT NULL | Denormalized for query convenience. |
| `snapshot_json` | TEXT NOT NULL | Full JSON of the live row BEFORE the change. |
| `change_kind` | TEXT NOT NULL CHECK IN ('propose','refine','confirm','override','auto-confirm','re-propose') | What transition caused the snapshot. |
| `change_actor` | TEXT NOT NULL | Who/what performed the change (`planner-collector`, `planner-agent`, operator name, `benchmark-runner`). |
| `superseded_at` | TEXT NOT NULL DEFAULT datetime('now') | |

## Entity 3: Locked Dependency Set (derived view — no table)

A deterministic projection over confirmed rows, produced by
`getLockedDependencySet(db)` (research.md §9). NOT a table — computed on demand
so it can never drift from the disposition rows (SC-004: single indexed scan).

```text
LockedDependencySetEntry {
  library_name:          string
  disposition:           'keep' | 'replace-with-native' | 'inline'
  locked_target_version: string | null   // present iff keep
  native_replacement:    string | null   // present iff replace-with-native
  inline_note:           string | null   // present iff inline
  confirmed_by:          string
  confirmed_at:          string
}
```

Ordering: `ORDER BY library_name ASC` — deterministic across runs (FR-009).
Only `status='confirmed'` rows appear; libraries with merely proposed
dispositions (or with a non-NULL `pending_disposition`, which awaits
re-confirmation of changed evidence) are absent from the locked set — they are
readiness blockers, not locked-set members. For a row with a pending
re-proposal, the locked set carries the CURRENT confirmed decision (primary
columns), which remains in effect per FR-011.

## Relationships

- `dependency_dispositions` → `artifacts`: INDIRECT, via `usage_json.using_artifacts`
  and via `dependency_findings` (a library may be referenced by many findings
  across artifacts). No FK column on the disposition table — the per-library
  workspace-wide grain is deliberate (research.md §1).
- `dependency_dispositions` → `dependency_findings`: complementary, not
  hierarchical. A kept library may still have findings needing approved
  strategies; a replaced/inlined library's findings are implicitly resolved by
  the disposition (the readiness gate treats findings on libraries with a
  confirmed non-keep disposition as resolved for planning purposes — wired in
  `evaluatePlanningReadiness`, see contracts/registry-schema.md).
- `dependency_disposition_history` → `dependency_dispositions`: soft reference
  by `disposition_id`; history rows survive live-row changes.

## Volume assumptions

Hundreds to low thousands of libraries per workspace (spec SC-004 sizes the
locked-set query at 500 libraries). All queries are single indexed scans or
PK lookups; no N+1 patterns. History grows by one row per change — bounded by
operator activity, trivially small.
