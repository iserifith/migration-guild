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
                     'shared-constants'
                 )),
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
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_artifacts_status ON artifacts(status);
CREATE INDEX IF NOT EXISTS idx_artifacts_wave   ON artifacts(wave);

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
