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

/**
 * The `events.type` CHECK vocabulary, oldest literal first. Single source of
 * truth for the guarded event-log upgrade: it decides whether an existing
 * database still needs a rebuild (any missing literal) and generates the
 * rebuilt constraint. registry_schema.sql carries the same list for fresh
 * databases; registry-schema-delta.test.ts fails if the two ever drift.
 *
 * Historical widening: #154 added 'remediation-confirmed-no-defect', spec 013
 * added the three 'approval-*' literals, and #217 added the three
 * 'adversary-*' literals. Each of those upgrades rebuilt the events table
 * separately, so a database missing both the #154 and #217 additions was
 * rebuilt twice on its way to the current constraint; the single rebuild in
 * this file reaches it in one pass (#294).
 */
export const EVENT_TYPE_CHECK_LITERALS: readonly string[] = [
  "planned",
  "claimed",
  "claim-heartbeat",
  "claim-completed",
  "claim-released",
  "claim-expired",
  "run-reaped",
  "registered",
  "analyzed",
  "scaffolded",
  "migrated",
  "proposal-submitted",
  "evidence-submitted",
  "critique-issued",
  "arbitration-approved",
  "arbitration-rejected",
  "approval-gated",
  "approval-approved",
  "approval-rejected",
  "conflict-opened",
  "conflict-resolved",
  "benchmark-recorded",
  "reviewed",
  "remediated",
  "blocked",
  "unblocked",
  "completed",
  "issue-opened",
  "issue-resolved",
  "tag-added",
  "tag-removed",
  "context-written",
  "status-changed",
  "evaluated",
  "auto-completed",
  "auto-rework",
  "filesystem-violation",
  "thread-created",
  "dependency-strategy-set",
  "remediation-confirmed-no-defect",
  "adversary-flagged",
  "adversary-inconclusive",
  "adversary-probe-passed",
];

/**
 * The `acceptance_evidence.evidence_type` CHECK vocabulary, same pattern as
 * EVENT_TYPE_CHECK_LITERALS: 'characterization-fixture' was the widening that
 * forced this table's CHECK-constrained rebuild.
 */
export const EVIDENCE_TYPE_CHECK_LITERALS: readonly string[] = [
  "runtime",
  "test-command",
  "build-command",
  "static-check",
  "review-verdict",
  "benchmark-result",
  "characterization-fixture",
];

/**
 * Columns that a registry created by an earlier kit version may be missing,
 * with the full definition each ALTER must carry. This is the union of every
 * column the old SQL-text migration section and the former ensureColumn() call
 * list referenced (#294) — each existing upgrade keeps exactly one
 * authoritative executable implementation, here.
 *
 * Order matters only for upgrades: a database missing several of these gets
 * them appended in this order, mirroring the order the old migration text
 * declared.
 */
const UPGRADE_COLUMNS: ReadonlyArray<{
  table: string;
  column: string;
  definition: string;
}> = [
  // Claim ownership (pre-lease era artifacts tables).
  { table: "artifacts", column: "claimed_by", definition: "TEXT" },
  { table: "artifacts", column: "claimed_at", definition: "TEXT" },
  { table: "artifacts", column: "claimed_from", definition: "TEXT" },
  { table: "artifacts", column: "tier", definition: "TEXT NOT NULL DEFAULT 'second-class' CHECK (tier IN ('first-class', 'second-class'))" },

  // Run ownership/telemetry (TASK-10 era runs tables).
  { table: "runs", column: "pid", definition: "INTEGER" },
  { table: "runs", column: "owner_id", definition: "TEXT" },
  { table: "runs", column: "phase", definition: "TEXT" },
  { table: "runs", column: "termination_reason", definition: "TEXT" },
  { table: "runs", column: "token_input", definition: "INTEGER NOT NULL DEFAULT 0 CHECK (token_input >= 0)" },
  { table: "runs", column: "token_output", definition: "INTEGER NOT NULL DEFAULT 0 CHECK (token_output >= 0)" },
  { table: "runs", column: "token_reasoning", definition: "INTEGER NOT NULL DEFAULT 0 CHECK (token_reasoning >= 0)" },
  { table: "runs", column: "token_cache_read", definition: "INTEGER NOT NULL DEFAULT 0 CHECK (token_cache_read >= 0)" },
  { table: "runs", column: "token_cache_write", definition: "INTEGER NOT NULL DEFAULT 0 CHECK (token_cache_write >= 0)" },
  { table: "runs", column: "token_fresh", definition: "INTEGER NOT NULL DEFAULT 0 CHECK (token_fresh >= 0)" },
  { table: "runs", column: "token_total", definition: "INTEGER NOT NULL DEFAULT 0 CHECK (token_total >= 0)" },

  // TASK-05: expected output paths recorded on each claim so runner-enforced
  // filesystem isolation knows the allowed path union for a parallel pool.
  { table: "artifact_claims", column: "expected_output_paths", definition: "TEXT" },

  // Evidence authenticity columns (#49/#150 era acceptance_evidence tables).
  { table: "acceptance_evidence", column: "log_sha256", definition: "TEXT" },
  { table: "acceptance_evidence", column: "duration_ms", definition: "INTEGER" },
  { table: "acceptance_evidence", column: "authenticity", definition: "TEXT" },
  { table: "acceptance_evidence", column: "content_sha256", definition: "TEXT" },
  { table: "acceptance_evidence", column: "signature_json", definition: "TEXT" },

  // Attempt-outcome columns (truthful-run-state, FR-030–FR-034). Every one is
  // nullable, so existing rows upgrade in place with no backfill.
  { table: "runs", column: "files_written_count", definition: "INTEGER" },
  { table: "runs", column: "files_written_source", definition: "TEXT" },
  { table: "runs", column: "status_from", definition: "TEXT" },
  { table: "runs", column: "status_to", definition: "TEXT" },
  { table: "runs", column: "budget_consumed", definition: "INTEGER" },
  { table: "runs", column: "cleanup_outcome", definition: "TEXT" },
  { table: "runs", column: "survivor_pids", definition: "TEXT" },
  { table: "runs", column: "outcome_label", definition: "TEXT" },
];

/** The events table's column set — unchanged across every supported version. */
const EVENTS_COLUMNS: readonly string[] = [
  "event_id",
  "ts",
  "artifact_id",
  "type",
  "agent",
  "model",
  "summary",
  "event_data",
];

/** acceptance_evidence's column set once the guards above have run. */
const EVIDENCE_COLUMNS: readonly string[] = [
  "evidence_id",
  "artifact_id",
  "run_id",
  "produced_by",
  "evidence_type",
  "command",
  "exit_code",
  "pass",
  "summary",
  "output_path",
  "output_excerpt",
  "log_sha256",
  "duration_ms",
  "authenticity",
  "content_sha256",
  "signature_json",
  "created_at",
];

export function applySchema(db: Database.Database): void {
  const schemaPath = resolveSchemaPath();
  const sql = fs.readFileSync(schemaPath, "utf-8");

  // Fresh-schema creation. Every statement in the file is `IF NOT EXISTS`, so
  // executing it against an existing database only adds the objects that
  // postdate that database. The file is now purely fresh-schema SQL: the old
  // executable migration section parsed comment-delimited statements, split
  // them on semicolons, filtered them by their first word, and tolerated
  // failures by error-message matching — so comments and formatting decided
  // whether an upgrade ran, and genuinely unexpected failures were swallowed
  // (#294). The guarded path below is the only upgrade mechanism.
  db.exec(sql);

  // The one authoritative upgrade path for existing databases: guarded (each
  // step checks current database state before acting), transactional (an
  // unexpected failure rolls the whole upgrade back and propagates — nothing
  // is filtered or tolerated by message text), and repeatable (safe to run on
  // every open, as getDb does).
  db.transaction(() => {
    for (const { table, column, definition } of UPGRADE_COLUMNS) {
      ensureColumn(db, table, column, definition);
    }

    // Depends on runs.outcome_label, which the guards above may just have
    // added — that dependency is why it is not in the base file.
    db.exec("CREATE INDEX IF NOT EXISTS idx_runs_outcome_label ON runs(outcome_label)");

    // CHECK-constrained columns cannot be widened by ALTER TABLE; rebuild the
    // affected tables to the current constraint when an older database needs
    // it. Both former event-type widenings share this one rebuild (#294), so
    // a database missing every addition still rebuilds the events table at
    // most once.
    rebuildAcceptanceEvidenceIfCheckNarrow(db);
    rebuildEventsIfCheckNarrow(db);
  })();
}

function ensureColumn(
  db: Database.Database,
  table: string,
  column: string,
  definition: string,
): void {
  const exists = db
    .prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`)
    .get(table, column);
  if (!exists) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function quotedList(literals: readonly string[]): string {
  return literals.map((literal) => `'${literal}'`).join(",\n                         ");
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare("SELECT name FROM pragma_table_info(?)").pluck().all(table) as string[]).sort();
}

/**
 * A CHECK rebuild copies every historical row column-by-column. It must never
 * run against a table whose column set it does not recognize — an unexpected
 * shape must surface here rather than silently drop or misplace data.
 */
function assertSupportedColumnShape(
  db: Database.Database,
  table: string,
  expected: readonly string[],
): void {
  const actual = columnNames(db, table);
  const missing = expected.filter((name) => !actual.includes(name));
  if (missing.length > 0) {
    throw new Error(
      `Unsupported ${table} schema shape: missing column(s) ${missing.join(", ")}. ` +
        "The guarded rebuild refuses to rewrite a table it cannot copy losslessly; " +
        "nothing was changed.",
    );
  }
  const extra = actual.filter((name) => !expected.includes(name));
  if (extra.length > 0) {
    throw new Error(
      `Unsupported ${table} schema shape: unexpected column(s) ${extra.join(", ")}. ` +
        "The guarded rebuild refuses to rewrite a table it cannot copy losslessly; " +
        "nothing was changed.",
    );
  }
}

/**
 * `evidence_type` is a CHECK-constrained column, which SQLite cannot widen via
 * ALTER TABLE — the only way to add 'characterization-fixture' to an existing
 * database is to rebuild the table with the new constraint. The five
 * authenticity/duration columns are guaranteed present by the guards that ran
 * earlier in the same transaction, so the explicit-column copy is lossless.
 * No trigger references acceptance_evidence, so — unlike the events rebuild —
 * nothing needs to be dropped around the rename. Fresh databases get the
 * widened CHECK from registry_schema.sql and this is a no-op there.
 */
function rebuildAcceptanceEvidenceIfCheckNarrow(db: Database.Database): void {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'acceptance_evidence'`)
    .get() as { sql: string } | undefined;
  if (!row) return;

  // Key the decision on the constraint's literal set, never on the DDL's
  // formatting: any older shape whose CHECK is missing a literal gets rebuilt.
  const missing = EVIDENCE_TYPE_CHECK_LITERALS.filter(
    (literal) => !row.sql.includes(`'${literal}'`),
  );
  if (missing.length === 0) return;

  assertSupportedColumnShape(db, "acceptance_evidence", EVIDENCE_COLUMNS);

  db.exec(`
    DROP TABLE IF EXISTS acceptance_evidence_new;
    CREATE TABLE acceptance_evidence_new (
        evidence_id     TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
        artifact_id     TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
        run_id          TEXT REFERENCES runs(run_id) ON DELETE SET NULL,
        produced_by     TEXT NOT NULL,
        evidence_type   TEXT NOT NULL CHECK (evidence_type IN (
                           ${quotedList(EVIDENCE_TYPE_CHECK_LITERALS)}
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
    INSERT INTO acceptance_evidence_new (${EVIDENCE_COLUMNS.join(", ")})
        SELECT ${EVIDENCE_COLUMNS.join(", ")} FROM acceptance_evidence;
    DROP TABLE acceptance_evidence;
    ALTER TABLE acceptance_evidence_new RENAME TO acceptance_evidence;
    CREATE INDEX IF NOT EXISTS idx_acceptance_evidence_artifact ON acceptance_evidence(artifact_id);
    CREATE INDEX IF NOT EXISTS idx_acceptance_evidence_pass ON acceptance_evidence(artifact_id, pass);
    CREATE INDEX IF NOT EXISTS idx_acceptance_evidence_type ON acceptance_evidence(evidence_type);
  `);
}

/**
 * `events.type` is a CHECK-constrained column, so admitting a new event type
 * to an existing database requires the table rebuild SQLite demands for any
 * CHECK widening. Every widening (#154's 'remediation-confirmed-no-defect',
 * spec 013's 'approval-*', #217's 'adversary-*') funnels through this single
 * rebuild: the freshness check tests the whole literal set, so a database
 * missing one addition or both reaches the current constraint with at most
 * one table rebuild (#294). Fresh databases get the widened CHECK from
 * registry_schema.sql and this is a no-op there.
 */
function rebuildEventsIfCheckNarrow(db: Database.Database): void {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'events'`)
    .get() as { sql: string } | undefined;
  if (!row) return;

  // Key the decision on the constraint's literal set — never on comments or
  // formatting — so any supported older shape reaches the current constraint
  // through this one rebuild.
  const missing = EVENT_TYPE_CHECK_LITERALS.filter(
    (literal) => !row.sql.includes(`'${literal}'`),
  );
  if (missing.length === 0) return;

  assertSupportedColumnShape(db, "events", EVENTS_COLUMNS);

  // One rebuild to the current constraint, atomic within the surrounding
  // applySchema transaction:
  //  - drop a stale events_new left by an interrupted earlier rebuild so the
  //    upgrade stays repeatable rather than failing with "table events_new
  //    already exists";
  //  - drop trg_artifact_status_change first: it INSERTs into `events`, and
  //    SQLite's ALTER TABLE ... RENAME recompiles every trigger referencing
  //    the table being renamed — with `events` briefly absent (dropped, not
  //    yet renamed into place) the rename fails with a confusing "error in
  //    trigger trg_artifact_status_change: no such table: main.events" even
  //    though the trigger body never actually runs (the events-loss incident);
  //  - copy rows column-explicitly (robust to column-order drift, loud about
  //    anything unexpected), rename, recreate the indexes, and recreate the
  //    trigger identically to registry_schema.sql's definition.
  db.exec(`
    DROP TABLE IF EXISTS events_new;
    DROP TRIGGER IF EXISTS trg_artifact_status_change;
    CREATE TABLE events_new (
        event_id     TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
        ts           TEXT NOT NULL DEFAULT (datetime('now')),
        artifact_id  TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
        type         TEXT NOT NULL CHECK (type IN (
                         ${quotedList(EVENT_TYPE_CHECK_LITERALS)}
                     )),
        agent        TEXT NOT NULL,
        model        TEXT,
        summary      TEXT NOT NULL,
        event_data   TEXT
    );
    INSERT INTO events_new (${EVENTS_COLUMNS.join(", ")})
        SELECT ${EVENTS_COLUMNS.join(", ")} FROM events;
    DROP TABLE events;
    ALTER TABLE events_new RENAME TO events;
    CREATE INDEX IF NOT EXISTS idx_events_artifact ON events(artifact_id);
    CREATE INDEX IF NOT EXISTS idx_events_type     ON events(type);
    CREATE INDEX IF NOT EXISTS idx_events_ts       ON events(ts);
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
