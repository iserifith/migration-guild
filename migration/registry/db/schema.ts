import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";

function resolveSchemaPath(): string {
  // Walk up from this file's directory until we find registry_schema.sql.
  // Robust to whether we run from source (registry/db/) or a build output
  // (dist/registry/db/), and regardless of where the bundler placed dist/.
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "registry_schema.sql");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback to the documented layout.
  return path.resolve(__dirname, "..", "..", "registry_schema.sql");
}

export function applySchema(db: Database.Database): void {
  const schemaPath = resolveSchemaPath();
  const sql = fs.readFileSync(schemaPath, "utf-8");

  // Split at the migrations section — ALTER TABLE statements for existing DBs
  // are run individually so failures (duplicate column) are silently ignored.
  const [base, migrations = ""] = sql.split(/--\s*─+ Migrations for existing databases/i);

  db.exec(base);

  for (const stmt of migrations.split(";").map(s => s.trim()).filter(Boolean)) {
    // The migration section begins with a box-drawing separator line that is
    // not valid SQL — skip any statement that does not start with a DDL/DML verb.
    if (!/^(ALTER|CREATE|INSERT|UPDATE|DELETE)\b/i.test(stmt)) continue;
    try {
      db.exec(stmt + ";");
    } catch (e) {
      // Duplicate-column / already-exists on ALTER is expected for a fresh DB;
      // this SQLite build also rejects `ADD COLUMN IF NOT EXISTS`, which is
      // harmless for idempotent migrations. Surface anything genuinely novel.
      const msg = e instanceof Error ? e.message : String(e);
      if (!/duplicate column|already exists|near "EXISTS"|IF NOT EXISTS|not exist/i.test(msg)) {
        // eslint-disable-next-line no-console
        console.warn(`[applySchema] migration skipped: ${msg}`);
      }
    }
  }

  // TASK-05: ensure expected_output_paths exists even on DBs created before the
  // column was added to the base CREATE TABLE. Plain ALTER (this SQLite build
  // rejects ADD COLUMN IF NOT EXISTS).
  ensureColumn(db, "artifact_claims", "expected_output_paths", "TEXT");
  ensureColumn(db, "acceptance_evidence", "log_sha256", "TEXT");
  ensureColumn(db, "acceptance_evidence", "duration_ms", "INTEGER");
  ensureColumn(db, "acceptance_evidence", "authenticity", "TEXT");
  ensureColumn(db, "acceptance_evidence", "content_sha256", "TEXT");
  ensureColumn(db, "acceptance_evidence", "signature_json", "TEXT");

  // Attempt-outcome columns on runs. The migrations section already carries the
  // matching ALTER statements, but this SQLite build rejects
  // `ADD COLUMN IF NOT EXISTS`, so the guarded ALTERs here are what actually
  // upgrade an existing database. Both halves are required.
  ensureColumn(db, "runs", "files_written_count", "INTEGER");
  ensureColumn(db, "runs", "files_written_source", "TEXT");
  ensureColumn(db, "runs", "status_from", "TEXT");
  ensureColumn(db, "runs", "status_to", "TEXT");
  ensureColumn(db, "runs", "budget_consumed", "INTEGER");
  ensureColumn(db, "runs", "cleanup_outcome", "TEXT");
  ensureColumn(db, "runs", "survivor_pids", "TEXT");
  ensureColumn(db, "runs", "outcome_label", "TEXT");

  // The index depends on a column the guards above may have just added.
  db.exec("CREATE INDEX IF NOT EXISTS idx_runs_outcome_label ON runs(outcome_label)");

  ensureCharacterizationFixtureEvidenceType(db);
  ensureRemediationNoDefectEventType(db);
  ensureAdversaryEnvelopeEventTypes(db);
}

/**
 * `evidence_type` is a CHECK-constrained column, which SQLite cannot widen via
 * ALTER TABLE — the only way to add 'characterization-fixture' to an existing
 * database is to rebuild the table with the new constraint. No other table
 * references acceptance_evidence by foreign key, so this is a same-shape copy.
 */
function ensureCharacterizationFixtureEvidenceType(db: Database.Database): void {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'acceptance_evidence'`)
    .get() as { sql: string } | undefined;
  if (!row || row.sql.includes("characterization-fixture")) return;

  db.exec(`
    CREATE TABLE acceptance_evidence_new (
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
    INSERT INTO acceptance_evidence_new SELECT * FROM acceptance_evidence;
    DROP TABLE acceptance_evidence;
    ALTER TABLE acceptance_evidence_new RENAME TO acceptance_evidence;
    CREATE INDEX IF NOT EXISTS idx_acceptance_evidence_artifact ON acceptance_evidence(artifact_id);
    CREATE INDEX IF NOT EXISTS idx_acceptance_evidence_pass ON acceptance_evidence(artifact_id, pass);
    CREATE INDEX IF NOT EXISTS idx_acceptance_evidence_type ON acceptance_evidence(evidence_type);
  `);
}

function ensureColumn(
  db: Database.Database,
  table: string,
  column: string,
  type: string,
): void {
  const exists = db
    .prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`)
    .get(table, column);
  if (!exists) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

/**
 * `events.type` is a CHECK-constrained column, so adding
 * `remediation-confirmed-no-defect` (US2 / #154) to an existing database
 * requires the same table rebuild SQLite demands for any CHECK widening —
 * the exact pattern `ensureCharacterizationFixtureEvidenceType` already uses
 * for acceptance_evidence. Fresh databases get the widened CHECK from
 * registry_schema.sql and this is a no-op there.
 */
function ensureRemediationNoDefectEventType(db: Database.Database): void {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'events'`)
    .get() as { sql: string } | undefined;
  if (!row || row.sql.includes("remediation-confirmed-no-defect")) return;

  db.exec(`
    CREATE TABLE events_new (
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
                         'dependency-strategy-set',
                         'remediation-confirmed-no-defect'
                     )),
        agent        TEXT NOT NULL,
        model        TEXT,
        summary      TEXT NOT NULL,
        event_data   TEXT
    );
    INSERT INTO events_new SELECT * FROM events;
    DROP TABLE events;
    ALTER TABLE events_new RENAME TO events;
    CREATE INDEX IF NOT EXISTS idx_events_artifact ON events(artifact_id);
    CREATE INDEX IF NOT EXISTS idx_events_type     ON events(type);
    CREATE INDEX IF NOT EXISTS idx_events_ts       ON events(ts);
  `);
}

/**
 * `events.type` is a CHECK-constrained column, so adding the adversary-agent
 * checkpoint's three new literals (#217, building on #216: 'adversary-flagged',
 * 'adversary-inconclusive', 'adversary-probe-passed') to an existing database
 * requires the same table rebuild SQLite demands for any CHECK widening — the
 * same pattern ensureRemediationNoDefectEventType already uses. Fresh
 * databases get the widened CHECK from registry_schema.sql and this is a
 * no-op there.
 */
function ensureAdversaryEnvelopeEventTypes(db: Database.Database): void {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'events'`)
    .get() as { sql: string } | undefined;
  if (!row || row.sql.includes("adversary-flagged")) return;

  // Defensive: an earlier CHECK-widening rebuild (this function's own or a
  // prior one's) that was interrupted before its DROP+RENAME can leave a
  // stale `events_new` behind. Clear it first so this rebuild is idempotent
  // rather than failing with "table events_new already exists".
  db.exec(`DROP TABLE IF EXISTS events_new`);

  // trg_artifact_status_change (AFTER UPDATE OF status ON artifacts) INSERTs
  // into `events`. SQLite's ALTER TABLE ... RENAME TO recompiles every
  // trigger/view/index that references the table being renamed as part of
  // the rename itself — with `events` briefly absent (dropped, not yet
  // renamed into place), that recompile fails with a confusing "error in
  // trigger trg_artifact_status_change: no such table: main.events" even
  // though the trigger body never actually runs. Drop the trigger before the
  // rebuild and recreate it identically afterward so the rename has nothing
  // referencing `events` to choke on.
  db.exec(`DROP TRIGGER IF EXISTS trg_artifact_status_change`);

  db.exec(`
    CREATE TABLE events_new (
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
    INSERT INTO events_new SELECT * FROM events;
    DROP TABLE events;
    ALTER TABLE events_new RENAME TO events;
    CREATE INDEX IF NOT EXISTS idx_events_artifact ON events(artifact_id);
    CREATE INDEX IF NOT EXISTS idx_events_type     ON events(type);
    CREATE INDEX IF NOT EXISTS idx_events_ts       ON events(ts);
  `);

  // Recreate the trigger dropped above, identical to registry_schema.sql's
  // definition.
  db.exec(`
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
  `);
}
