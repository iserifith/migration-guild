# Phase 1 Data Model: Version-Locked Documentation RAG for Codegen

Storage: `.guild/index.db` (`better-sqlite3`, WAL mode), schema applied on
first open the same way `migration/registry/db/schema.ts` applies
`registry_schema.sql` — a new `migration/index-db/schema.ts` +
`index_db_schema.sql`, mirroring that file's structure and `IF NOT EXISTS`
idiom.

## Table: `documentation_entries`

One row per (library, version, symbol, full signature) — FR-001, FR-011.

| Column | Type | Notes |
|---|---|---|
| `entry_id` | TEXT PRIMARY KEY | `doc-<sha1(library_name\|library_version\|symbol_kind\|symbol_name\|signature)[:12]>` — deterministic, so re-ingesting an unchanged entry is a no-op write (FR-007). |
| `library_name` | TEXT NOT NULL | Maven GAV `groupId:artifactId`, matching `dependency_dispositions.library_name` (research.md §7). |
| `library_version` | TEXT NOT NULL | Exact locked version — never a range. |
| `symbol_kind` | TEXT NOT NULL | `CHECK (symbol_kind IN ('class', 'method'))`. |
| `symbol_name` | TEXT NOT NULL | Fully-qualified class name, or `ClassName#methodName` for methods. |
| `signature` | TEXT | NULL for `class` rows; normalized parameter-type list (e.g. `(java.lang.String,int)`) for `method` rows — FR-011 disambiguation key. |
| `description` | TEXT NOT NULL | Human-readable documentation content (Javadoc-equivalent prose). |
| `return_type` | TEXT | NULL for `class` rows. |
| `source_url` | TEXT NOT NULL | Required provenance — FR-003a. |
| `source_excerpt` | TEXT NOT NULL | Verbatim excerpt the entry was derived from — FR-003a. An entry cannot be constructed without both this and `source_url` (enforced at the write layer, not just documented). |
| `ingestion_run_id` | TEXT NOT NULL | FK to `ingestion_runs.run_id`. |
| `indexed_at` | TEXT NOT NULL DEFAULT (datetime('now')) | |

**Indexes**:
- `UNIQUE (library_name, library_version, symbol_kind, symbol_name, signature)` — the exact-match lookup key (FR-002); `signature` participates in the uniqueness so two overloads of the same method are distinct rows (FR-011). SQLite treats NULL as distinct-per-row in a UNIQUE index, which is correct here: multiple `class`-kind rows for the same symbol should never exist, so `symbol_kind`+`symbol_name` alone already prevents duplicate class rows regardless of the NULL `signature`.
- `idx_documentation_entries_library_version` on `(library_name, library_version)` — FR-005/FR-006 scoping and superseded-version cleanup.

**Lifecycle**: When a library's locked version changes (FR-006), the write
path deletes all rows for `(library_name, old_version)` before inserting rows
for the new version, inside the same transaction — old-version rows are never
left queryable once a new ingestion run for that library completes. This
mirrors the "never silently served as current" edge case in `spec.md`.

## Virtual table: `documentation_entries_fts`

FTS5 full-text index over entry content, populated in the same ingestion
transaction that writes `documentation_entries` (FR-001, FR-003):

```sql
CREATE VIRTUAL TABLE documentation_entries_fts USING fts5(
  symbol_name,
  description,
  content='documentation_entries',
  content_rowid='rowid'
);
```

A contentless-adjacent (external-content) FTS5 table keyed to
`documentation_entries.rowid`, kept in sync via `INSERT`/`DELETE` triggers on
the parent table (standard FTS5 external-content pattern — avoids storing
document text twice). Search queries (FR-002a) run
`SELECT ... FROM documentation_entries_fts WHERE documentation_entries_fts MATCH ? AND library_name = ? AND library_version = ?
ORDER BY rank LIMIT ?` joined back to `documentation_entries` for the full row.

## Table: `ingestion_runs`

One row per ingestion invocation (User Story 3) — the audit record for "which
libraries were attempted."

| Column | Type | Notes |
|---|---|---|
| `run_id` | TEXT PRIMARY KEY | |
| `started_at` | TEXT NOT NULL | |
| `completed_at` | TEXT | NULL while in progress. |
| `triggered_by` | TEXT NOT NULL | Operator/actor identity, mirroring `confirmed_by` conventions in spec 006. |
| `locked_set_snapshot_count` | INTEGER NOT NULL | Count of `keep`-disposition libraries the run considered — a cheap sanity total for the completion report (FR-004). |

## Table: `ingestion_run_libraries`

Per-library outcome within a run (FR-004, FR-012) — the "which libraries
succeeded, failed, or were skipped" record.

| Column | Type | Notes |
|---|---|---|
| `run_id` | TEXT NOT NULL | FK to `ingestion_runs.run_id`. |
| `library_name` | TEXT NOT NULL | |
| `library_version` | TEXT NOT NULL | |
| `outcome` | TEXT NOT NULL | `CHECK (outcome IN ('indexed', 'skipped', 'unchanged', 'failed'))`. `unchanged` covers FR-007's idempotent no-op case distinctly from a fresh `indexed` write, so readiness reporting (FR-004/SC-005) can tell "already covered" apart from "just ingested." |
| `reason` | TEXT | Required when `outcome IN ('skipped', 'failed')` — e.g. "no citable source found," "network error," "no sources/javadoc artifact published." |
| `entries_written` | INTEGER NOT NULL DEFAULT 0 | Count of `documentation_entries` rows written for this library in this run. |

**Primary key**: `(run_id, library_name)`.

**Consumption for readiness (FR-004, SC-005)**: workspace readiness reporting
reads the most recent `ingestion_run_libraries` row per `library_name` (by
joining to the latest `ingestion_runs.completed_at`) alongside
`getLockedDependencySet(db)` from the registry, to answer "which locked
libraries have queryable docs and which don't" without a special-purpose
readiness table — this mirrors how `readiness.ts` already composes multiple
registry reads (`evaluatePlanningReadiness`) rather than maintaining a
separate readiness cache.

## Entity: `Documentation Lookup` (request/response shape, not a stored row)

Input: `{ library_name, library_version, symbol_kind, symbol_name, signature? }`.
Output: one of —
- `{ status: "found", entry: <documentation_entries row, chunked per FR-015> }`
- `{ status: "not_found" }`
- `{ status: "unavailable", reason: "library not in locked keep set" | "never ingested" }`

## Entity: `Documentation Search` (request/response shape)

Input: `{ library_name, library_version, query, limit? }` (`limit` default
bounded by the token-budget threshold, FR-015).
Output: `{ status: "ok", candidates: [{ symbol_name, signature?, snippet, rank }] }`
or `{ status: "empty" }` (distinct from lookup's `not_found` per the Edge Cases
entry added during clarification).

## Entity: `Batch Verification Request/Result` (`verify_library_docs`)

Input: `{ references: [{ library_name, library_version, symbol_name, signature? }, ...] }`
(bounded count per call, enforced against the FR-015 token budget — oversized
batches return a `truncated` flag with a continuation cursor rather than
silently dropping references).
Output: `{ results: [{ reference, outcome: "verified-present" | "verified-absent" | "unavailable" }, ...] }`
— one outcome per input reference, order-preserved, per FR-010a and the Edge
Cases entry on mixed indexed/unindexed batches.

## Relationships

```
dependency_dispositions (registry.db, spec 006)
        │  getLockedDependencySet() — disposition='keep' rows only
        ▼
ingestion_runs ──1:N── ingestion_run_libraries
        │
        ▼ (per successfully ingested library)
documentation_entries ──1:1(rowid)── documentation_entries_fts
        ▲
        │  lookup_library_doc / search / verify_library_docs (MCP, FR-009)
        │
Migrate agent (code-writer-agent) · Critic agent (review-agent)
```

`documentation_entries` has no foreign key to `registry.db` — `.guild/index.db`
is a separate database file (research.md §2), so the relationship to
`dependency_dispositions` is enforced at ingestion-write time (only libraries
present in `getLockedDependencySet()` with `disposition='keep'` are ever
ingested — FR-005), not by a cross-database constraint.
