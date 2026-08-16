# Contract: `.guild/index.db` Schema

**Feature**: `007-doc-rag-lookup` | **Date**: 2026-08-16

New file: `migration/index-db/index_db_schema.sql`, applied by a new
`migration/index-db/schema.ts` (mirrors `migration/registry/db/schema.ts`'s
`applySchema(db)` shape — idempotent, `IF NOT EXISTS` throughout, safe to call
on every open). New connection module `migration/index-db/connection.ts`
mirrors `migration/registry/db/connection.ts`: WAL mode,
`foreign_keys = ON`, `busy_timeout = 5000`, auto-applies schema on first open.

```sql
CREATE TABLE IF NOT EXISTS documentation_entries (
    entry_id            TEXT PRIMARY KEY,
    library_name        TEXT NOT NULL,
    library_version      TEXT NOT NULL,
    symbol_kind          TEXT NOT NULL CHECK (symbol_kind IN ('class', 'method')),
    symbol_name          TEXT NOT NULL,
    signature             TEXT,
    description           TEXT NOT NULL,
    return_type           TEXT,
    source_url            TEXT NOT NULL,
    source_excerpt        TEXT NOT NULL,
    ingestion_run_id      TEXT NOT NULL,
    indexed_at            TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (library_name, library_version, symbol_kind, symbol_name, signature)
);

CREATE INDEX IF NOT EXISTS idx_documentation_entries_library_version
    ON documentation_entries(library_name, library_version);

CREATE VIRTUAL TABLE IF NOT EXISTS documentation_entries_fts USING fts5(
    symbol_name,
    description,
    content='documentation_entries',
    content_rowid='rowid'
);

-- Standard FTS5 external-content sync triggers.
CREATE TRIGGER IF NOT EXISTS documentation_entries_ai AFTER INSERT ON documentation_entries BEGIN
    INSERT INTO documentation_entries_fts(rowid, symbol_name, description)
    VALUES (new.rowid, new.symbol_name, new.description);
END;

CREATE TRIGGER IF NOT EXISTS documentation_entries_ad AFTER DELETE ON documentation_entries BEGIN
    INSERT INTO documentation_entries_fts(documentation_entries_fts, rowid, symbol_name, description)
    VALUES ('delete', old.rowid, old.symbol_name, old.description);
END;

CREATE TABLE IF NOT EXISTS ingestion_runs (
    run_id                       TEXT PRIMARY KEY,
    started_at                   TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at                 TEXT,
    triggered_by                 TEXT NOT NULL,
    locked_set_snapshot_count    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ingestion_run_libraries (
    run_id            TEXT NOT NULL,
    library_name      TEXT NOT NULL,
    library_version   TEXT NOT NULL,
    outcome           TEXT NOT NULL CHECK (outcome IN ('indexed', 'skipped', 'unchanged', 'failed')),
    reason            TEXT,
    entries_written   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (run_id, library_name),
    FOREIGN KEY (run_id) REFERENCES ingestion_runs(run_id)
);
```

## Path resolution contract

New `resolveIndexDbPath(options: { workspaceRoot?: string }): string` in
`migration/guildctl/config.ts`, adjacent to and following the exact shape of
`resolveRegistryDbPath` (`config.ts:240-249`): default
`".guild/index.db"`, resolved against `resolveWorkspaceRoot()` unless an
absolute override is configured. No new config key is required for v1 beyond
this default — a future `database.index_path` override can be added the same
way `database.path` overrides the registry, without a schema/contract change.

## Write-path invariant (enforced in code, not just documented)

`upsertDocumentationEntry(db, options)` in the new
`migration/index-db/commands/entries.ts` (mirroring the
`upsertProposedDisposition` shape in `dispositions.ts`) MUST throw
(`IndexDbError`, mirroring `RegistryError`) if `source_url` or `source_excerpt`
is empty — FR-003a is a write-time guarantee, not a convention agents are
merely asked to follow. On a version change for an already-indexed library,
the same transaction that inserts new-version rows first deletes all rows
for `(library_name, previous_version)` (data-model.md's lifecycle note) —
implemented as a single `db.transaction(() => { ... })()` call, the same
pattern `confirmDisposition` uses for its history-snapshot-then-write.
