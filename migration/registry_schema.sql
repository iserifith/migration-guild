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
    -- Status lifecycle: pending → planned → analyzed → in-progress →
    -- tests-written → migrated → reviewed → completed, with blocked ↔
    -- needs-rework for human / arbitration rejection paths. Above-cutoff
    -- high-risk artifacts hold at pending-approval between an approving
    -- arbiter verdict and the human approval decision (spec 013), then
    -- release to reviewed / needs-rework.
    status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                     'pending',
                     'planned',
                     'analyzed',
                     'in-progress',
                     'tests-written',
                     'migrated',
                     'reviewed',
                     'needs-rework',
                     'pending-approval',
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

-- Claim ordering (claimNextTask) aggregates in-degree per dependency_id on
-- every claim; the PK above leads with dependent_id, so without this index
-- each claim is a full scan of source_dependencies.
CREATE INDEX IF NOT EXISTS idx_source_dependencies_dependency
    ON source_dependencies(dependency_id);

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
                     'approval-gated',
                     'approval-approved',
                     'approval-rejected',
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
                      'dependency-strategy-set',
                      'remediation-confirmed-no-defect',
                      'adversary-flagged',
                      'adversary-inconclusive',
                      'adversary-probe-passed'
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
    status       TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
    -- Attempt outcome. Every column is nullable so pre-existing rows and every
    -- current consumer keep working; value domains are enforced in finishRun
    -- because ALTER TABLE ADD COLUMN cannot add a CHECK in this SQLite build.
    files_written_count  INTEGER,
    files_written_source TEXT,
    status_from          TEXT,
    status_to            TEXT,
    budget_consumed      INTEGER,
    cleanup_outcome      TEXT,
    survivor_pids        TEXT,
    outcome_label        TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_agent  ON runs(agent);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_owner  ON runs(owner_id);
-- idx_runs_outcome_label is created in the migrations section below, not here.
-- The base section is executed as one statement batch against existing
-- databases too, where `CREATE TABLE IF NOT EXISTS runs` is a no-op and
-- outcome_label does not exist yet — indexing it here would abort the whole
-- batch and break in-place upgrade. The migrations section runs for fresh and
-- existing databases alike, after the ALTERs, so both end with the index.

CREATE TABLE IF NOT EXISTS run_operator_credentials (
    run_id       TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
    token_hash   TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Artifact Verification ───────────────────────────────────────────────────
-- Verification state is a fact distinct from migration status: it records
-- whether an artifact's own output was checked, by what method, and why.
-- It is triage input only. It has deliberately NO foreign key to
-- acceptance_evidence, cannot substitute for it, and cannot satisfy the
-- arbitration gate.

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
                       'benchmark-result',
                       'characterization-fixture'
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

-- ─── Approval Decisions ─────────────────────────────────────────────────────
-- Records the human approval or rejection that releases an artifact out of
-- pending-approval. The approving arbiter identity MUST NOT equal `operator`
-- (enforced by the registry layer, research.md §1), and rejections require a
-- reason so the rework loop knows what to fix (spec 013, data-model.md §2).

CREATE TABLE IF NOT EXISTS approval_decisions (
    decision_id      TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    artifact_id      TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    run_id           TEXT REFERENCES runs(run_id) ON DELETE SET NULL,
    operator         TEXT NOT NULL,
    decision         TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
    reason           TEXT,
    operator_token_hash TEXT,
    decided_at       TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (decision <> 'rejected' OR reason IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_approval_decisions_artifact ON approval_decisions(artifact_id);

-- ─── Attempt Records ────────────────────────────────────────────────────────
-- Durable per-attempt outcome history for migrate retries (spec 013,
-- data-model.md §3): one row per (artifact, attempt_no), recording outcome,
-- classified failure kind/signature, and timing, so attempt/budget state is
-- re-seedable from SQLite + events after a process restart instead of living
-- only in the supervisor's in-memory FailureBudget maps.

CREATE TABLE IF NOT EXISTS attempt_records (
    attempt_id        TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    artifact_id       TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    attempt_no        INTEGER NOT NULL CHECK (attempt_no > 0),
    phase             TEXT NOT NULL DEFAULT 'migrate',
    outcome           TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'budget-exhausted')),
    failure_kind      TEXT CHECK (failure_kind IS NULL OR failure_kind IN (
                         'build-failure',
                         'test-failure',
                         'agent-timeout',
                         'review-rejection',
                         'filesystem-violation',
                         'claim-violation',
                         'stack-mismatch',
                         'pack-defect',
                         'provider-error',
                         'unknown'
                     )),
    failure_signature TEXT,
    started_at        TEXT NOT NULL,
    finished_at       TEXT NOT NULL DEFAULT (datetime('now')),
    claim_id          TEXT REFERENCES artifact_claims(claim_id) ON DELETE SET NULL,
    recorded_at       TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (artifact_id, attempt_no),
    CHECK (outcome = 'succeeded' OR failure_kind IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_attempt_records_artifact ON attempt_records(artifact_id);

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
                         'pending-approval',
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

-- ─── Verify Slots (US5 / #151) ───────────────────────────────────────────────
-- A bounded lease granting permission to run one verify subprocess at a time,
-- mirroring the artifact_claims lease shape. At most `verification.max_concurrent`
-- rows may be live (released_at IS NULL and lease_expires_at > now()) at once;
-- the acquire function enforces that with an atomic insert-if-under-limit check.

CREATE TABLE IF NOT EXISTS verify_slots (
    slot_id           TEXT PRIMARY KEY,
    run_id            TEXT REFERENCES runs(run_id) ON DELETE SET NULL,
    artifact_id       TEXT NOT NULL,
    acquired_at       TEXT NOT NULL DEFAULT (datetime('now')),
    lease_expires_at  TEXT NOT NULL,
    released_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_verify_slots_run      ON verify_slots(run_id);
CREATE INDEX IF NOT EXISTS idx_verify_slots_artifact ON verify_slots(artifact_id);
CREATE INDEX IF NOT EXISTS idx_verify_slots_live
  ON verify_slots(released_at, lease_expires_at);

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

-- ─── Automated Risk Scoring ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS artifact_risk_assessments (
    artifact_id       TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
    risk_score        REAL NOT NULL CHECK (risk_score >= 0),
    high_risk         INTEGER NOT NULL DEFAULT 0 CHECK (high_risk IN (0, 1)),
    reason_codes_json TEXT NOT NULL,
    signals_json      TEXT NOT NULL,
    updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_artifact_risk_assessments_high_risk
  ON artifact_risk_assessments(high_risk);

CREATE TABLE IF NOT EXISTS risk_confirmations (
    artifact_id  TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
    decision     TEXT NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending', 'confirmed', 'declined')),
    decided_by   TEXT,
    decided_at   TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_risk_confirmations_decision
  ON risk_confirmations(decision);

-- ─── JVM Compatibility Audit Findings ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jvm_audit_findings (
    finding_id   TEXT PRIMARY KEY,
    artifact_id  TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    tool         TEXT NOT NULL,
    category     TEXT NOT NULL CHECK (category IN (
                     'internal-api',
                     'removed-api',
                     'deprecated-api',
                     'python-compat',
                     'view-regeneration',
                     'view-logic-placement'
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

-- ISSUE-68: scope gate — one keep/drop decision per module, recorded between
-- Inventory and Plan. `drop` bulk-transitions that module's pre-migration
-- artifacts to status='skipped' (see recordScopeDecision); this table is the
-- audit trail (who/when/why) that the status flip alone wouldn't preserve.
CREATE TABLE IF NOT EXISTS scope_decisions (
    module       TEXT PRIMARY KEY,
    decision     TEXT NOT NULL CHECK (decision IN ('keep', 'drop')),
    reason       TEXT NOT NULL,
    decided_by   TEXT NOT NULL,
    decided_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

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

-- Attempt-outcome columns on runs (FR-030–FR-034). Every one is nullable, so an
-- existing workspace registry upgrades in place with no backfill.
-- Note: SQLite in this build rejects `ADD COLUMN IF NOT EXISTS`, so schema.ts
-- also adds each of these at runtime via a plain ALTER guarded by a
-- column-existence check. Both halves are required; either alone leaves fresh
-- or existing databases wrong.
ALTER TABLE runs ADD COLUMN files_written_count  INTEGER;
ALTER TABLE runs ADD COLUMN files_written_source TEXT;
ALTER TABLE runs ADD COLUMN status_from          TEXT;
ALTER TABLE runs ADD COLUMN status_to            TEXT;
ALTER TABLE runs ADD COLUMN budget_consumed      INTEGER;
ALTER TABLE runs ADD COLUMN cleanup_outcome      TEXT;
ALTER TABLE runs ADD COLUMN survivor_pids        TEXT;
ALTER TABLE runs ADD COLUMN outcome_label        TEXT;

CREATE INDEX IF NOT EXISTS idx_runs_outcome_label ON runs(outcome_label);

CREATE TABLE IF NOT EXISTS run_operator_credentials (
    run_id       TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
    token_hash   TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- US5 (#151): bounded verify-concurrency lease table for existing databases.
-- `CREATE TABLE IF NOT EXISTS` is idempotent, so this is a no-op on a fresh
-- database that already picked the table up from the base schema above.
CREATE TABLE IF NOT EXISTS verify_slots (
    slot_id           TEXT PRIMARY KEY,
    run_id            TEXT REFERENCES runs(run_id) ON DELETE SET NULL,
    artifact_id       TEXT NOT NULL,
    acquired_at       TEXT NOT NULL DEFAULT (datetime('now')),
    lease_expires_at  TEXT NOT NULL,
    released_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_verify_slots_run      ON verify_slots(run_id);
CREATE INDEX IF NOT EXISTS idx_verify_slots_artifact ON verify_slots(artifact_id);
CREATE INDEX IF NOT EXISTS idx_verify_slots_live
  ON verify_slots(released_at, lease_expires_at);
