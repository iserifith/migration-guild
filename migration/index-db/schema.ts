import Database from "better-sqlite3";

/**
 * Embedded .guild/index.db schema (contracts/index-db-schema.md).
 *
 * Embedded as a string rather than read from a `.sql` file so the compiled
 * `dist/index-db/schema.js` works regardless of whether the bundler copied the
 * `.sql` alongside it — the registry CLI and the doc-RAG MCP server both open
 * index.db from build output, not source.
 */
const INDEX_DB_SCHEMA = `
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
`;

/**
 * Applies the .guild/index.db schema (contracts/index-db-schema.md). Idempotent
 * — IF NOT EXISTS throughout — so it is safe to call on every connection open,
 * the same way registry applySchema runs on every registry open.
 */
export function applyIndexDbSchema(db: Database.Database): void {
  db.exec(INDEX_DB_SCHEMA);
}
