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
                     'planned',
                     'claimed',
                     'claim-heartbeat',
                     'claim-completed',
                     'claim-released',
                     'claim-expired',
                     'run-reaped',
                     'registered',
                     'analyzed',
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
                     'status-changed',
                     'evaluated',
                     'auto-completed',
                     'auto-rework',
                     'batch-submitted',
                     'batch-applied',
                      'thread-created',
                      'dependency-strategy-set'
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
    owner_id     TEXT,
    phase        TEXT,
    model        TEXT,
    prompt       TEXT,
    log_file     TEXT,
    pid          INTEGER,
    started_at   TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at  TEXT,
    exit_code    INTEGER,
    termination_reason TEXT,
    status       TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_runs_agent  ON runs(agent);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_owner  ON runs(owner_id);

-- ─── Claim Attempts ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS artifact_claims (
    claim_id          TEXT PRIMARY KEY,
    artifact_id       TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    run_id            TEXT REFERENCES runs(run_id) ON DELETE SET NULL,
    owner_id          TEXT NOT NULL,
    agent             TEXT NOT NULL,
    from_status       TEXT NOT NULL CHECK (from_status IN (
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
    claim_token       TEXT NOT NULL,
    state             TEXT NOT NULL CHECK (state IN ('active', 'completed', 'released', 'expired', 'failed')),
    attempt_no        INTEGER NOT NULL,
    claimed_at        TEXT NOT NULL DEFAULT (datetime('now')),
    heartbeat_at      TEXT NOT NULL DEFAULT (datetime('now')),
    lease_expires_at  TEXT NOT NULL,
    finished_at       TEXT,
    finish_reason     TEXT
);

CREATE INDEX IF NOT EXISTS idx_claims_artifact ON artifact_claims(artifact_id);
CREATE INDEX IF NOT EXISTS idx_claims_run      ON artifact_claims(run_id);
CREATE INDEX IF NOT EXISTS idx_claims_owner    ON artifact_claims(owner_id);
CREATE INDEX IF NOT EXISTS idx_claims_state    ON artifact_claims(state);
CREATE UNIQUE INDEX IF NOT EXISTS idx_claims_active_artifact
  ON artifact_claims(artifact_id)
  WHERE state = 'active';

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

-- ─── JVM Compatibility Audit Findings ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jvm_audit_findings (
    finding_id   TEXT PRIMARY KEY,
    artifact_id  TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    tool         TEXT NOT NULL,
    category     TEXT NOT NULL CHECK (category IN (
                     'internal-api',
                     'removed-api',
                     'deprecated-api'
                 )),
    severity     TEXT NOT NULL CHECK (severity IN ('critical', 'warning')),
    symbol       TEXT,
    summary      TEXT NOT NULL,
    evidence     TEXT,
    remediation  TEXT NOT NULL,
    detected_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_jvm_audit_artifact ON jvm_audit_findings(artifact_id);
CREATE INDEX IF NOT EXISTS idx_jvm_audit_severity ON jvm_audit_findings(severity);

-- ─── Dependency Modernization Findings ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS dependency_findings (
    finding_id       TEXT PRIMARY KEY,
    artifact_id      TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    dependency_name  TEXT NOT NULL,
    current_version  TEXT,
    target_hint      TEXT,
    category         TEXT NOT NULL CHECK (category IN ('outdated', 'eol', 'incompatible')),
    severity         TEXT NOT NULL CHECK (severity IN ('critical', 'warning')),
    summary          TEXT NOT NULL,
    details          TEXT,
    remediation      TEXT NOT NULL,
    detected_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dependency_findings_artifact ON dependency_findings(artifact_id);
CREATE INDEX IF NOT EXISTS idx_dependency_findings_severity ON dependency_findings(severity);

CREATE TABLE IF NOT EXISTS dependency_strategies (
    finding_id         TEXT PRIMARY KEY REFERENCES dependency_findings(finding_id) ON DELETE CASCADE,
    strategy           TEXT NOT NULL CHECK (strategy IN ('upgrade', 'replace', 'remove')),
    target_dependency  TEXT,
    target_version     TEXT,
    rationale          TEXT NOT NULL,
    approved_by        TEXT NOT NULL,
    approved_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dependency_strategies_approved_by ON dependency_strategies(approved_by);

-- ─── Triggers ────────────────────────────────────────────────────────────────
-- Auto-write a status-changed event whenever any agent (at any depth) updates
-- an artifact's status. guildctl CLI polls this table — no agent cooperation needed.

CREATE TRIGGER IF NOT EXISTS trg_artifact_status_change
AFTER UPDATE OF status ON artifacts
WHEN OLD.status != NEW.status
BEGIN
  INSERT INTO events (artifact_id, type, agent, summary)
  VALUES (
    NEW.id,
    'status-changed',
    COALESCE(NEW.claimed_by, 'system'),
    OLD.status || ' → ' || NEW.status
  );
END;

-- ─── Foundry: Evaluation Results ─────────────────────────────────────────────
-- One row per evaluator per artifact run. Multiple rows if re-evaluated.

CREATE TABLE IF NOT EXISTS evaluations (
    eval_id      TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    artifact_id  TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    evaluator    TEXT NOT NULL CHECK (evaluator IN (
                     'no-legacy-imports',
                     'signature-preservation',
                     'test-coverage',
                     'correctness'
                 )),
    score        REAL,            -- 0.0–1.0; NULL if evaluator is rule-based pass/fail only
    pass         INTEGER NOT NULL CHECK (pass IN (0, 1)),
    feedback     TEXT,            -- human-readable explanation from the evaluator
    model        TEXT,            -- LLM model used (NULL for rule-based evaluators)
    eval_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_evaluations_artifact ON evaluations(artifact_id);
CREATE INDEX IF NOT EXISTS idx_evaluations_pass     ON evaluations(artifact_id, pass);

-- ─── Foundry: Batch Jobs ──────────────────────────────────────────────────────
-- Tracks async batch inference jobs submitted to Foundry.

CREATE TABLE IF NOT EXISTS batch_jobs (
    job_id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    foundry_job_id TEXT,          -- Foundry-assigned job ID (populated after submission)
    type           TEXT NOT NULL CHECK (type IN ('inventory', 'embed', 'evaluate')),
    wave           INTEGER,
    status         TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN (
                       'submitted', 'running', 'completed', 'failed'
                   )),
    artifact_ids   TEXT NOT NULL, -- JSON array of artifact IDs in this batch
    submitted_at   TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at   TEXT,
    result_path    TEXT           -- local path where Foundry wrote output JSONL
);

CREATE INDEX IF NOT EXISTS idx_batch_jobs_status ON batch_jobs(status);
CREATE INDEX IF NOT EXISTS idx_batch_jobs_type   ON batch_jobs(type);

-- ─── Foundry: LLM Traces ──────────────────────────────────────────────────────
-- One row per LLM API call. Written by the Foundry client wrapper.

CREATE TABLE IF NOT EXISTS traces (
    trace_id     TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    run_id       TEXT REFERENCES runs(run_id) ON DELETE SET NULL,
    artifact_id  TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
    span_name    TEXT NOT NULL,   -- 'inventory' | 'migration' | 'review' | 'evaluation' | 'embed'
    model        TEXT,
    tokens_in    INTEGER,
    tokens_out   INTEGER,
    latency_ms   INTEGER,
    cost_usd     REAL,
    ts           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_traces_run      ON traces(run_id);
CREATE INDEX IF NOT EXISTS idx_traces_artifact ON traces(artifact_id);
CREATE INDEX IF NOT EXISTS idx_traces_ts       ON traces(ts);

-- ─── Foundry: Azure AI Agent Threads ──────────────────────────────────────────
-- One persistent thread per artifact, shared across migration + review agents.

CREATE TABLE IF NOT EXISTS agent_threads (
    artifact_id     TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
    thread_id       TEXT NOT NULL,   -- Azure AI Agents thread ID
    agent_type      TEXT NOT NULL CHECK (agent_type IN ('migration', 'review', 'context')),
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    last_message_at TEXT
);

-- ─── Migrations for existing databases ───────────────────────────────────────

ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS claimed_by   TEXT;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS claimed_at   TEXT;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS claimed_from TEXT;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS tier         TEXT NOT NULL DEFAULT 'second-class'
  CHECK (tier IN ('first-class', 'second-class'));
ALTER TABLE runs ADD COLUMN IF NOT EXISTS pid INTEGER;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS owner_id TEXT;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS phase TEXT;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS termination_reason TEXT;
