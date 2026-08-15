# Contract: Registry Schema — Dependency Dispositions

**Feature**: `006-dependency-disposition` | **Date**: 2026-08-16

Changes to `migration/registry_schema.sql`. Two new tables, three new indexes.
No existing table or column is modified; `migration/registry/db/schema.ts`
`applySchema` needs no `ensureColumn` guards (both tables are new, so the base
`CREATE TABLE IF NOT EXISTS` covers fresh and existing databases alike — same
reasoning as feature 005's new tables).

## DDL

```sql
-- ISSUE-61: planner-emitted dependency dispositions — one current decision per
-- third-party library per workspace (keep / replace-with-native / inline).
-- Primary columns always hold the CURRENT decision; the pending_* group carries
-- a re-proposal against an already-confirmed decision (FR-011) without adding a
-- second row for the library.
CREATE TABLE IF NOT EXISTS dependency_dispositions (
    disposition_id             TEXT PRIMARY KEY,
    library_name               TEXT NOT NULL UNIQUE,
    current_version            TEXT,
    disposition                TEXT NOT NULL CHECK (disposition IN ('keep', 'replace-with-native', 'inline')),
    status                     TEXT NOT NULL CHECK (status IN ('proposed', 'confirmed')),
    native_replacement         TEXT,
    inline_note                TEXT,
    locked_target_version      TEXT,
    rationale                  TEXT NOT NULL,
    usage_json                 TEXT,
    proposed_by                TEXT NOT NULL,
    confirmed_by               TEXT,
    confirmed_at               TEXT,
    pending_disposition        TEXT CHECK (pending_disposition IN ('keep', 'replace-with-native', 'inline')),
    pending_native_replacement TEXT,
    pending_inline_note        TEXT,
    pending_locked_target_version TEXT,
    pending_rationale          TEXT,
    pending_proposed_by        TEXT,
    pending_at                 TEXT,
    created_at                 TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at                 TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dependency_dispositions_status
    ON dependency_dispositions(status);
CREATE INDEX IF NOT EXISTS idx_dependency_dispositions_pending
    ON dependency_dispositions(pending_disposition);

-- Append-only audit trail: every mutation of a live row snapshots the prior
-- state here first. No UPDATE/DELETE ever runs against this table.
CREATE TABLE IF NOT EXISTS dependency_disposition_history (
    history_id      TEXT PRIMARY KEY,
    disposition_id  TEXT NOT NULL,
    library_name    TEXT NOT NULL,
    snapshot_json   TEXT NOT NULL,
    change_kind     TEXT NOT NULL CHECK (change_kind IN ('propose', 'refine', 'confirm', 'override', 'auto-confirm', 're-propose')),
    change_actor    TEXT NOT NULL,
    superseded_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dependency_disposition_history_library
    ON dependency_disposition_history(library_name);
```

## Commands-module API (`migration/registry/commands/dispositions.ts`, NEW)

All write functions follow the repository's existing conventions: throw
`RegistryError` on validation failure (exit-code carrying) and run
multi-statement changes inside `db.transaction(...)`.

**Decision-evidence trail**: `dependency_disposition_history` is the sole
evidence trail for disposition mutations — every mutation writes a history row
(`change_kind`, prior-state snapshot, actor) in the same transaction as the
mutation itself. Disposition mutations do **not** emit `events` rows: the
`events` table requires `artifact_id NOT NULL REFERENCES artifacts(id)`, while
dispositions are deliberately workspace-wide per-library records with no
artifact FK (data-model.md Relationships) — a declared-but-unused library has
no artifact to reference, so an events-row obligation would be unenforceable
(spec edge case #1). This diverges from `approveDependencyStrategy`'s
`dependency-strategy-set` event (modernization.ts:330-349), which works only
because `dependency_findings` rows carry an `artifact_id`. The
`dependency-strategy-set` precedent does not apply here.

```text
upsertProposedDisposition(db, opts): DependencyDisposition
  opts: { libraryName, currentVersion?, disposition, nativeReplacement?,
          inlineNote?, lockedTargetVersion?, rationale, usageJson?, proposedBy }
  Behavior:
    - No row for library_name            → INSERT with status='proposed'
      (history change_kind='propose').
    - Row exists, status='proposed'      → UPDATE proposal fields in place
      (history change_kind='refine'); never touches confirmed_* fields.
    - Row exists, status='confirmed',
      proposal differs in disposition/
      target                         → UPDATE ONLY the pending_* group
      (history change_kind='re-propose'); primary columns untouched (FR-011).
    - Row exists, status='confirmed',
      proposal identical             → no-op (idempotent re-run).
  Validation: disposition-target pairing rules from data-model.md; rationale
  non-empty; replace-with-native requires nativeReplacement; inline requires
  inlineNote.

confirmDisposition(db, opts): DependencyDisposition
  opts: { libraryName, confirmedBy, disposition?, nativeReplacement?,
          inlineNote?, lockedTargetVersion?, rationale? }
  Behavior:
    - Optional override args REPLACE the proposal fields before confirming
      (US2 scenario 2; history change_kind='override' when any override arg
      present, else 'confirm'; 'auto-confirm' when invoked from the
      GUILDCTL_AUTO_CONFIRM_DISPOSITIONS path with confirmedBy='benchmark-runner').
    - If pending_disposition IS NOT NULL and no explicit override args: folds
      the pending_* group into the primary columns, NULLs the pending group.
    - Sets confirmed_by + confirmed_at in the SAME statement as status flip.
    - keep + confirm requires locked_target_version non-empty (FR-008).
  Validation: target pairing rules re-checked on the final effective values.

listDispositions(db, opts): DependencyDisposition[]
  opts: { status?: 'proposed' | 'confirmed', pendingOnly?: boolean }
  ORDER BY library_name ASC (deterministic).

getLockedDependencySet(db): LockedDependencySetEntry[]
  SELECT of confirmed rows only, ORDER BY library_name ASC. Rows with
  pending_disposition non-NULL contribute their CURRENT (primary) confirmed
  decision — still in effect per FR-011.

dispositionContextForArtifact(db, artifactId): string | null
  Prompt-ready text block listing confirmed non-keep dispositions for libraries
  used by the artifact (usage_json.using_artifacts match, falling back to
  dependency_findings name match). NULL when none — callers append nothing.
```

## Readiness integration (`migration/guildctl/readiness.ts`)

- `PlanningReadiness` gains `unconfirmedDispositions: DependencyDisposition[]`
  — rows where `status='proposed'` OR `pending_disposition IS NOT NULL`.
- `evaluatePlanningReadiness` populates it from `listDispositions`.
- `formatPlanningBlockMessage` gains a disposition branch, evaluated AFTER the
  existing scope → JVM → dependency branches (scope and critical JVM findings
  remain the most fundamental blockers):
  ```text
  summary: "Planning blocked by unconfirmed dependency dispositions."
  reason:  "<N> librar(y|ies) lack a confirmed keep / replace-with-native /
            inline disposition (<sample>). Every in-scope library needs a
            confirmed disposition before planning sign-off."
  command: "node migration/registry/dist/cli.js list-dispositions --status proposed"
  ```
- Dependency-finding interplay: a `dependency_findings` row whose
  `dependency_name` has a confirmed non-keep disposition counts as resolved for
  planning-readiness purposes (the disposition IS the resolution: the library
  will not be carried into the target). Implemented by extending the
  `unresolvedDependencyFindings` filter in `evaluatePlanningReadiness` with a
  `NOT EXISTS` against confirmed non-keep dispositions matched on
  `dependency_name = library_name`. Kept libraries' findings still require
  approved strategies exactly as today.

## Claim/evidence invariants preserved

- No change to `claimNextTask` / `claimArtifactById` — dispositions gate
  planning sign-off, not artifact claimability (research.md §7).
- No `events` rows are emitted for disposition mutations (see "Decision-evidence
  trail" above): the append-only audit trail for dispositions lives in
  `dependency_disposition_history`. Dashboard/poller consumers that need
  disposition decisions read the history table; the existing
  artifact-scoped event stream is unchanged.
