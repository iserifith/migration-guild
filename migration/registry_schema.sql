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

-- TASK-10: source-level code dependencies between registered artifacts, used for
-- dependency-aware parallel pool assignment. `auto` rows are (re)written on each
-- inventory; `manual` rows (added via `deps add`) are preserved across re-runs.
CREATE TABLE IF NOT EXISTS source_dependencies (
    dependent_id    TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    dependency_id   TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    signal          TEXT NOT NULL CHECK (signal IN ('import', 'inheritance', 'manual')),
    created_by      TEXT NOT NULL DEFAULT 'auto',
    PRIMARY KEY (dependent_id, dependency_id, signal)
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
                     'proposal-submitted',
                     'evidence-submitted',
                     'critique-issued',
                     'arbitration-approved',
                     'arbitration-rejected',
                     'conflict-opened',
                     'conflict-resolved',
                     'benchmark-recorded',
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
                     'filesystem-violation',
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
    token_input  INTEGER NOT NULL DEFAULT 0 CHECK (token_input >= 0),
    token_output INTEGER NOT NULL DEFAULT 0 CHECK (token_output >= 0),
    token_reasoning INTEGER NOT NULL DEFAULT 0 CHECK (token_reasoning >= 0),
    token_cache_read INTEGER NOT NULL DEFAULT 0 CHECK (token_cache_read >= 0),
    token_cache_write INTEGER NOT NULL DEFAULT 0 CHECK (token_cache_write >= 0),
    token_fresh INTEGER NOT NULL DEFAULT 0 CHECK (token_fresh >= 0),
    token_total INTEGER NOT NULL DEFAULT 0 CHECK (token_total >= 0),
    status       TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_runs_agent  ON runs(agent);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_owner  ON runs(owner_id);

CREATE TABLE IF NOT EXISTS run_operator_credentials (
    run_id       TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
    token_hash   TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Acceptance Evidence Gate ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS acceptance_evidence (
    evidence_id     TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    artifact_id     TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    run_id          TEXT REFERENCES runs(run_id) ON DELETE SET NULL,
    produced_by     TEXT NOT NULL,
    evidence_type   TEXT NOT NULL CHECK (evidence_type IN (
                       'runtime',
                       'test-command',
                       'build-command',
                       'static-check',
                       'review-verdict',
                       'benchmark-result'
                     )),
    command         TEXT,
    exit_code       INTEGER,
    pass            INTEGER NOT NULL CHECK (pass IN (0, 1)),
    summary         TEXT NOT NULL,
    output_path     TEXT,
    output_excerpt  TEXT,
    log_sha256      TEXT,
    duration_ms     INTEGER,
    authenticity    TEXT,
    content_sha256  TEXT,
    signature_json  TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_acceptance_evidence_artifact ON acceptance_evidence(artifact_id);
CREATE INDEX IF NOT EXISTS idx_acceptance_evidence_pass ON acceptance_evidence(artifact_id, pass);
CREATE INDEX IF NOT EXISTS idx_acceptance_evidence_type ON acceptance_evidence(evidence_type);

CREATE TABLE IF NOT EXISTS arbitration_decisions (
    decision_id    TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    artifact_id    TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    arbiter        TEXT NOT NULL,
    decision       TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
    reason         TEXT NOT NULL,
    evidence_ids   TEXT NOT NULL,
    decided_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_arbitration_decisions_artifact ON arbitration_decisions(artifact_id);

-- ─── Benchmark Runs ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS benchmark_runs (
    benchmark_id        TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    mode                TEXT NOT NULL CHECK (mode IN ('single-agent', 'guild')),
    fixture             TEXT NOT NULL,
    started_at          TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at         TEXT NOT NULL DEFAULT (datetime('now')),
    elapsed_ms          INTEGER NOT NULL CHECK (elapsed_ms >= 0),
    total_runs          INTEGER NOT NULL CHECK (total_runs >= 0),
    failed_runs         INTEGER NOT NULL CHECK (failed_runs >= 0),
    artifacts_planned   INTEGER NOT NULL CHECK (artifacts_planned >= 0),
    artifacts_completed INTEGER NOT NULL CHECK (artifacts_completed >= 0),
    evidence_pass_rate  REAL NOT NULL CHECK (evidence_pass_rate >= 0 AND evidence_pass_rate <= 1),
    rework_count        INTEGER NOT NULL CHECK (rework_count >= 0),
    total_cost_usd      REAL,
    verdict             TEXT NOT NULL CHECK (verdict IN ('pass', 'fail')),
    notes               TEXT
);

CREATE INDEX IF NOT EXISTS idx_benchmark_runs_mode ON benchmark_runs(mode);
CREATE INDEX IF NOT EXISTS idx_benchmark_runs_fixture ON benchmark_runs(fixture);
CREATE INDEX IF NOT EXISTS idx_benchmark_runs_started ON benchmark_runs(started_at);

-- ─── Approved Companion Outputs ──────────────────────────────────────────────
-- Operator-approved companion paths expand a claim's fail-closed output allow-list.
-- Approval authorizes only the path; verifier evidence authenticates written content.
CREATE TABLE IF NOT EXISTS approved_companion_outputs (
    artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    output_path TEXT NOT NULL,
    approved_by TEXT NOT NULL,
    approved_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (artifact_id, output_path)
);

CREATE INDEX IF NOT EXISTS idx_companion_outputs_artifact ON approved_companion_outputs(artifact_id);
CREATE INDEX IF NOT EXISTS idx_companion_outputs_path     ON approved_companion_outputs(output_path);

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
    expected_output_paths TEXT,
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

-- ─── Inventory Classification Metadata ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS artifact_classifications (
    artifact_id    TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
    framework      TEXT NOT NULL,
    role           TEXT NOT NULL,
    confidence     REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    ambiguous      INTEGER NOT NULL DEFAULT 0 CHECK (ambiguous IN (0, 1)),
    evidence_json  TEXT NOT NULL,
    signals_json   TEXT NOT NULL,
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_artifact_classifications_framework ON artifact_classifications(framework);
CREATE INDEX IF NOT EXISTS idx_artifact_classifications_ambiguous ON artifact_classifications(ambiguous);

-- ─── JVM Compatibility Audit Findings ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jvm_audit_findings (
    finding_id   TEXT PRIMARY KEY,
    artifact_id  TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    tool         TEXT NOT NULL,
    category     TEXT NOT NULL CHECK (category IN (
                     'internal-api',
                     'removed-api',
                     'deprecated-api',
                     'python-compat'
                 )),
    severity     TEXT NOT NULL CHECK (severity IN ('critical', 'warning')),
    symbol       TEXT,
    summary      TEXT NOT NULL,
    evidence     TEXT,
    remediation  TEXT NOT NULL,
    detected_at  TEXT NOT NULL DEFAULT (datetime('now')),
    dismissed_at TEXT,
    override_id  TEXT
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
    detected_at      TEXT NOT NULL DEFAULT (datetime('now')),
    dismissed_at     TEXT,
    override_id      TEXT
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

-- TASK-11: audit finding dismiss/reopen (no-delete acknowledge path) + python-compat labels.
CREATE TABLE IF NOT EXISTS audit_overrides (
    override_id   TEXT PRIMARY KEY,
    finding_id    TEXT NOT NULL,
    finding_table TEXT NOT NULL CHECK (finding_table IN ('jvm_audit_findings', 'dependency_findings')),
    action        TEXT NOT NULL CHECK (action IN ('dismiss', 'reopen')),
    reason        TEXT NOT NULL,
    dismissed_by  TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_overrides_finding ON audit_overrides(finding_id);

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
ALTER TABLE runs ADD COLUMN IF NOT EXISTS token_input INTEGER NOT NULL DEFAULT 0 CHECK (token_input >= 0);
ALTER TABLE runs ADD COLUMN IF NOT EXISTS token_output INTEGER NOT NULL DEFAULT 0 CHECK (token_output >= 0);
ALTER TABLE runs ADD COLUMN IF NOT EXISTS token_reasoning INTEGER NOT NULL DEFAULT 0 CHECK (token_reasoning >= 0);
ALTER TABLE runs ADD COLUMN IF NOT EXISTS token_cache_read INTEGER NOT NULL DEFAULT 0 CHECK (token_cache_read >= 0);
ALTER TABLE runs ADD COLUMN IF NOT EXISTS token_cache_write INTEGER NOT NULL DEFAULT 0 CHECK (token_cache_write >= 0);
ALTER TABLE runs ADD COLUMN IF NOT EXISTS token_fresh INTEGER NOT NULL DEFAULT 0 CHECK (token_fresh >= 0);

-- TASK-05: expected output paths recorded on each claim so the runner-enforced
-- filesystem isolation (TASK-04) knows the allowed path union for a parallel pool.
-- Note: SQLite in this build rejects `ADD COLUMN IF NOT EXISTS`, so schema.ts
-- adds this column at runtime via a plain ALTER guarded by a column-existence check.
ALTER TABLE artifact_claims ADD COLUMN expected_output_paths TEXT;

ALTER TABLE runs ADD COLUMN IF NOT EXISTS token_total INTEGER NOT NULL DEFAULT 0 CHECK (token_total >= 0);
ALTER TABLE acceptance_evidence ADD COLUMN IF NOT EXISTS log_sha256 TEXT;
ALTER TABLE acceptance_evidence ADD COLUMN IF NOT EXISTS duration_ms INTEGER;
ALTER TABLE acceptance_evidence ADD COLUMN IF NOT EXISTS authenticity TEXT;
ALTER TABLE acceptance_evidence ADD COLUMN IF NOT EXISTS content_sha256 TEXT;
ALTER TABLE acceptance_evidence ADD COLUMN IF NOT EXISTS signature_json TEXT;

CREATE TABLE IF NOT EXISTS run_operator_credentials (
    run_id       TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
    token_hash   TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
