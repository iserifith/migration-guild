# Contract: Registry Schema Delta

**Interface**: the per-workspace SQLite registry (WAL). **File**: `migration/registry_schema.sql`,
applied by `migration/registry/db/schema.ts`.

**Application mechanism**: `applySchema()` splits `registry_schema.sql` at the
`── Migrations for existing databases` marker, executes the base section, then runs each migration
statement individually with duplicate-column errors ignored. Because this SQLite build rejects
`ADD COLUMN IF NOT EXISTS`, every new column must be present in the fresh-database base schema and
also be registered with the `ensureColumn()` guard at the end of `applySchema()` for in-place upgrades.
For columns whose index depends on a guarded upgrade, the index is created only after the guard runs.

**Compatibility commitment**: no existing table, column, `CHECK` constraint, trigger, or index is
modified or dropped. Every addition is a new table or a nullable/defaulted column, so an existing
workspace registry upgrades in place with no backfill and no downtime.

---

## 1. `artifact_verifications` — NEW table

Satisfies FR-001, FR-002, FR-004.

```sql
CREATE TABLE IF NOT EXISTS artifact_verifications (
    artifact_id    TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
    state          TEXT NOT NULL CHECK (state IN (
                       'verified',
                       'unverified',
                       'verification-failed'
                   )),
    method         TEXT NOT NULL,
    reason         TEXT,
    detail         TEXT,
    scope_json     TEXT,
    budget_ms      INTEGER,
    duration_ms    INTEGER,
    run_id         TEXT REFERENCES runs(run_id) ON DELETE SET NULL,
    determined_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_artifact_verifications_state ON artifact_verifications(state);
CREATE INDEX IF NOT EXISTS idx_artifact_verifications_run   ON artifact_verifications(run_id);
```

**Invariants enforced above the schema** (SQLite `CHECK` cannot express them cleanly, so they are
enforced in `migration/registry/commands/verification.ts` and covered by tests):

- `reason` is non-empty whenever `state <> 'verified'`, and is drawn from the closed vocabulary in
  [../data-model.md](../data-model.md#1-artifact-verification-record-persisted--new-table).
- `state = 'verified'` requires non-null `duration_ms` and non-empty `scope_json`.
- `detail` is passed through `redactSecrets()` before write.

**Read-model default (FR-002)**: consumers MUST NOT read this table with an inner join. The canonical
read is:

```sql
SELECT a.id,
       COALESCE(v.state,  'unverified')   AS verification_state,
       COALESCE(v.reason, 'not-attempted') AS verification_reason,
       COALESCE(v.method, 'none')          AS verification_method,
       v.determined_at
FROM artifacts a
LEFT JOIN artifact_verifications v ON v.artifact_id = a.id;
```

This is what makes an artifact with no verification attempt read as *unverified* rather than blank,
without touching a single historical row.

**Upsert shape**:

```sql
INSERT INTO artifact_verifications (...)
VALUES (...)
ON CONFLICT (artifact_id) DO UPDATE SET
    state = excluded.state, method = excluded.method, reason = excluded.reason,
    detail = excluded.detail, scope_json = excluded.scope_json,
    budget_ms = excluded.budget_ms, duration_ms = excluded.duration_ms,
    run_id = excluded.run_id, determined_at = excluded.determined_at;
```

**Invalidation**: when an artifact enters `in-progress` or `needs-rework`, its row is reset to
`state = 'unverified'`, `reason = 'not-attempted'`. This mirrors the content-bound evidence rule of
Constitution I — a verification of superseded output must not survive.

---

## 2. `runs` — NEW columns

Satisfies FR-030–FR-034. Added to the base `CREATE TABLE` and to the `ensureColumn()` list. The
existing-database upgrade uses the guarded plain `ALTER TABLE` path in `schema.ts`; adding the
outcome index to the base SQL batch would break upgrades because the base `CREATE TABLE IF NOT EXISTS`
is a no-op for an existing `runs` table whose new columns have not yet been added.

```sql
-- base CREATE TABLE runs
files_written_count  INTEGER,
files_written_source TEXT,
status_from          TEXT,
status_to            TEXT,
budget_consumed      INTEGER,
cleanup_outcome      TEXT,
survivor_pids        TEXT,
outcome_label        TEXT
```

```ts
// migration/registry/db/schema.ts — required companion
ensureColumn(db, "runs", "files_written_count", "INTEGER");
ensureColumn(db, "runs", "files_written_source", "TEXT");
ensureColumn(db, "runs", "status_from", "TEXT");
ensureColumn(db, "runs", "status_to", "TEXT");
ensureColumn(db, "runs", "budget_consumed", "INTEGER");
ensureColumn(db, "runs", "cleanup_outcome", "TEXT");
ensureColumn(db, "runs", "survivor_pids", "TEXT");
ensureColumn(db, "runs", "outcome_label", "TEXT");
```

**Value domains** (enforced in `finishRun`, not by `CHECK`, because `ALTER TABLE ADD COLUMN` cannot
add a constraint to an existing table in this SQLite build):

| Column | Domain |
|--------|--------|
| `files_written_source` | `warden-snapshot` \| `git-diff` \| `unavailable` |
| `budget_consumed` | `0` \| `1` |
| `cleanup_outcome` | `clean` \| `survivors` \| `not-applicable` |
| `outcome_label` | `succeeded` \| `released-retryable` \| `no-progress` \| `failed` |
| `survivor_pids` | JSON array of integers; non-empty iff `cleanup_outcome = 'survivors'` |

**Label derivation is computed, never supplied by an agent** — see
[../data-model.md](../data-model.md#2-attempt-outcome-persisted--new-columns-on-runs). The binding
rule: `succeeded` MUST NOT be assigned when `status_from = status_to`.

**Index for the counted condition (FR-034)**:

```sql
CREATE INDEX IF NOT EXISTS idx_runs_outcome_label ON runs(outcome_label);
```

The implementation creates this index after the `ensureColumn()` guards, not in the base schema batch,
so both fresh registries and existing registries upgrade safely.

**Counted-condition query**:

```sql
SELECT c.artifact_id, COUNT(*) AS no_progress_attempts
FROM runs r
JOIN artifact_claims c ON c.run_id = r.run_id
WHERE r.outcome_label = 'no-progress'
GROUP BY c.artifact_id
HAVING COUNT(*) >= ?;
```

---

## 3. `artifact_tags` — NEW tag value, UNCHANGED schema

Satisfies FR-010. No DDL change; the tag vocabulary gains one reserved value:

| Tag | Meaning |
|-----|---------|
| `blocked:out-of-scope-path` | the attempt required a change outside its authorized output paths |

The offending path travels in the payload of an `events` row of the **existing** type
`filesystem-violation`:

```json
{ "out_of_scope_paths": ["build.gradle"], "claim_id": "…", "run_id": "…" }
```

**Deliberately not done**: no new value is added to the `events.type` `CHECK` list. That list is a
fixed enumeration consumed by several type unions; extending it would be schema churn for capability
the tag already provides.

---

## 4. `acceptance_evidence` and `arbitration_decisions` — UNCHANGED (stated for completeness)

No column, constraint, or semantic of either table changes, and `artifact_verifications` has **no**
foreign key to `acceptance_evidence`.

This is a load-bearing absence, not an oversight. The arbitration gate continues to require
verifier-produced runtime evidence carrying `authenticity` + `log_sha256`, produced by an actor
different from the arbiter, content-bound and fresh. A builder-side verification record cannot
satisfy it, cannot substitute for it, and cannot be joined into it.

**Required regression test** (Constitution IV, research R11): an artifact with
`artifact_verifications.state = 'verified'` and no passing `acceptance_evidence` row is still
**rejected** by arbitration. This test is the enforcement point for the whole separation; it belongs
in the existing `migration/test/arbiter-gate.test.ts`.
