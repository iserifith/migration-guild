PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ─── Artifacts ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS artifacts (
    id           TEXT PRIMARY KEY,
    slug         TEXT NOT NULL UNIQUE,
    kind         TEXT NOT NULL CHECK (kind IN (
                     'legacy-source',
                     'target-source',
                     'test',
                     'module',
                     'config',
                     'descriptor',
                     'sql-schema',
                     'properties',
                     'shared-constants'
                 )),
    tier         TEXT NOT NULL DEFAULT 'second-class' CHECK (tier IN ('first-class', 'second-class')),
    path         TEXT NOT NULL,
    module       TEXT,
    role         TEXT CHECK (role IS NULL OR role IN (
                     'rest-endpoint',
                     'exception-handler',
                     'startup-config',
                     'filter',
                     'service',
                     'utility',
                     'model',
                     'test',
                     'module',
                     'entry-point',
                     'transformer',
                     'interface'
                 )),
    framework    TEXT,
    status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                     'pending',
                     'planned',
                     'analyzed',
                     'in-progress',
                     'tests-written',
                     'migrated',
                     'reviewed',
                     'needs-rework',
                     'completed',
                     'blocked',
                     'skipped'
                 )),
    wave         INTEGER,          -- assigned during planning; lower waves execute first
    data_path    TEXT,
    claimed_by   TEXT,             -- agent name that currently holds this task
    claimed_at   TEXT,             -- when it was claimed
    claimed_from TEXT,             -- status before claiming (for release rollback)
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_artifacts_status ON artifacts(status);
CREATE INDEX IF NOT EXISTS idx_artifacts_wave   ON artifacts(wave);
CREATE INDEX IF NOT EXISTS idx_artifacts_tier   ON artifacts(tier);

-- ─── Outcome Tags ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS artifact_tags (
    artifact_id  TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    tag          TEXT NOT NULL,
    PRIMARY KEY (artifact_id, tag)
);

-- ─── Dependency Graph ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS dependencies (
    artifact_id      TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    depends_on_id    TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    relation         TEXT NOT NULL CHECK (relation IN (
                         'source-of',
                         'produced-by',
                         'verified-by',
                         'part-of',
                         'related-issue'
                     )),
    PRIMARY KEY (artifact_id, depends_on_id, relation)
);

-- ─── Event Log (append-only) ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS events (
    event_id     TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    ts           TEXT NOT NULL DEFAULT (datetime('now')),
    artifact_id  TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    type         TEXT NOT NULL CHECK (type IN (
                     'registered',
                     'analyzed',
                     'planned',
                     'claimed',
                     'scaffolded',
                     'migrated',
                     'reviewed',
                     'remediated',
                     'blocked',
                     'unblocked',
                     'completed',
                     'issue-opened',
                     'issue-resolved',
                     'tag-added',
                     'tag-removed',
                     'context-written',
                     'status-changed'
                 )),
    agent        TEXT NOT NULL,
    model        TEXT,
    summary      TEXT NOT NULL,
    event_data   TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_artifact ON events(artifact_id);
CREATE INDEX IF NOT EXISTS idx_events_type     ON events(type);
CREATE INDEX IF NOT EXISTS idx_events_ts       ON events(ts);

-- ─── Agent Context ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_context (
    artifact_id  TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    agent        TEXT NOT NULL,
    file_path    TEXT NOT NULL,
    summary      TEXT,
    updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (artifact_id, agent)
);

-- ─── Changelogs ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS changelogs (
    artifact_id  TEXT NOT NULL PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
    file_path    TEXT NOT NULL,
    last_entry   TEXT,
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Operator Dashboard State ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS operator_state (
    key          TEXT PRIMARY KEY,
    value        TEXT NOT NULL,
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Agent Runs ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS runs (
    run_id       TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    agent        TEXT NOT NULL,
    model        TEXT,
    prompt       TEXT,
    log_file     TEXT,
    started_at   TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at  TEXT,
    exit_code    INTEGER,
    status       TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_runs_agent  ON runs(agent);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);

-- ─── Stack Mappings ──────────────────────────────────────────────────────────
-- Created by stack-advisor after inventory; confirmed by a human before planning.

CREATE TABLE IF NOT EXISTS stack_mappings (
    id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    legacy_framework TEXT NOT NULL,
    target_framework TEXT NOT NULL,
    strategy         TEXT CHECK (strategy IS NULL OR strategy IN ('direct', 'adapter', 'rewrite')),
    notes            TEXT,
    confirmed        INTEGER NOT NULL DEFAULT 0 CHECK (confirmed IN (0, 1)),
    confirmed_by     TEXT,
    confirmed_at     TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (legacy_framework, target_framework)
);

CREATE INDEX IF NOT EXISTS idx_stack_mappings_confirmed ON stack_mappings(confirmed);

-- ─── Migrations for existing databases ───────────────────────────────────────

ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS claimed_by   TEXT;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS claimed_at   TEXT;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS claimed_from TEXT;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS tier         TEXT NOT NULL DEFAULT 'second-class'
  CHECK (tier IN ('first-class', 'second-class'));
