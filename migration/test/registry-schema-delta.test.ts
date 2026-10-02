import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
  applySchema,
  EVIDENCE_TYPE_CHECK_LITERALS,
  EVENT_TYPE_CHECK_LITERALS,
} from "../registry/db/schema";
import { makeTempDir } from "./truthful-run-state-fixtures";

/**
 * Foundational coverage for contracts/registry-schema.md.
 *
 * Two properties matter equally: the delta lands, and nothing pre-existing
 * moves. Every addition must be a new table or a nullable/defaulted column so
 * an existing workspace registry upgrades in place with no backfill.
 *
 * Issue #294 additionally pins the upgrade mechanism itself:
 *  - registry_schema.sql is fresh-schema creation only (no executable
 *    SQL-text migration section, no comment-parsed statements);
 *  - schema.ts applies one guarded, transactional, repeatable upgrade path and
 *    surfaces unexpected failures instead of tolerating them by message text;
 *  - every supported older events shape reaches the current `events.type`
 *    CHECK with at most one table rebuild;
 *  - historical rows, indexes, and the status-change trigger survive both the
 *    column upgrades and the CHECK rebuild.
 *
 * Historical shapes are declared explicitly below; the old fixture derived
 * them by regex-stripping registry_schema.sql, which tied the test to the SQL
 * file's formatting.
 */

/** Schema objects that existed before these features and MUST survive unchanged. */
const PRE_FEATURE_TABLES = [
  "acceptance_evidence", "agent_context", "approved_companion_outputs",
  "arbitration_decisions", "artifact_claims", "artifact_classifications",
  "artifact_tags", "artifacts", "audit_overrides", "benchmark_runs",
  "changelogs", "dependencies", "dependency_findings", "dependency_strategies",
  "events", "jvm_audit_findings", "operator_state", "run_operator_credentials",
  "runs", "source_dependencies", "stack_mappings",
];

const PRE_FEATURE_INDEXES = [
  "idx_acceptance_evidence_artifact", "idx_acceptance_evidence_pass",
  "idx_acceptance_evidence_type", "idx_arbitration_decisions_artifact",
  "idx_artifact_classifications_ambiguous", "idx_artifact_classifications_framework",
  "idx_artifacts_status", "idx_artifacts_tier", "idx_artifacts_wave",
  "idx_audit_overrides_finding", "idx_benchmark_runs_fixture",
  "idx_benchmark_runs_mode", "idx_benchmark_runs_started",
  "idx_claims_active_artifact", "idx_claims_artifact", "idx_claims_owner",
  "idx_claims_run", "idx_claims_state", "idx_companion_outputs_artifact",
  "idx_companion_outputs_path", "idx_dependency_findings_artifact",
  "idx_dependency_findings_severity", "idx_dependency_strategies_approved_by",
  "idx_events_artifact", "idx_events_ts", "idx_events_type",
  "idx_jvm_audit_artifact", "idx_jvm_audit_severity", "idx_runs_agent",
  "idx_runs_owner", "idx_runs_status", "idx_stack_mappings_confirmed",
  // Tables/indexes the old SQL-text migration section also declared; the base
  // schema's IF NOT EXISTS forms create them for existing databases.
  "idx_verify_slots_run", "idx_verify_slots_artifact", "idx_verify_slots_live",
];

const PRE_FEATURE_TRIGGERS = ["trg_artifact_status_change"];

/** The 20 `runs` columns that existed before the attempt-outcome feature, in order. */
const PRE_FEATURE_RUNS_COLUMNS = [
  "run_id", "agent", "owner_id", "phase", "model", "prompt", "log_file", "pid",
  "started_at", "finished_at", "exit_code", "termination_reason",
  "token_input", "token_output", "token_reasoning", "token_cache_read",
  "token_cache_write", "token_fresh", "token_total", "status",
];

const NEW_RUNS_COLUMNS = [
  "files_written_count", "files_written_source", "status_from", "status_to",
  "budget_consumed", "cleanup_outcome", "survivor_pids", "outcome_label",
];

const NEW_INDEXES = [
  "idx_artifact_verifications_state",
  "idx_artifact_verifications_run",
  "idx_runs_outcome_label",
];

/** Columns the guarded upgrade path must reinstate on older databases. */
const UPGRADED_COLUMNS_BY_TABLE: Readonly<Record<string, readonly string[]>> = {
  artifacts: ["claimed_by", "claimed_at", "claimed_from"],
  runs: [
    "pid", "phase", "termination_reason", "token_input", "token_output",
    "token_reasoning", "token_cache_read", "token_cache_write", "token_fresh",
    "token_total", ...NEW_RUNS_COLUMNS,
  ],
  artifact_claims: ["expected_output_paths"],
  acceptance_evidence: ["log_sha256", "duration_ms", "authenticity", "content_sha256", "signature_json"],
};

interface ColumnInfo { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }

function columns(db: Database.Database, table: string): ColumnInfo[] {
  // `notnull` is a SQLite keyword; it must be quoted when selected by name.
  return db.prepare(`SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?)`).all(table) as ColumnInfo[];
}

function names(db: Database.Database, type: "table" | "index" | "trigger"): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .pluck()
    .all(type) as string[];
}

function ddl(db: Database.Database, name: string): string {
  return (db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").pluck().get(name) as string | null) ?? "";
}

/**
 * Extract the quoted literal list of `CHECK (<column> IN ('a','b',...))` from a
 * sqlite_master DDL string — the semantic constraint content, independent of
 * the DDL's formatting.
 */
function checkLiterals(ddlText: string, column: string): string[] {
  const marker = `CHECK (${column} IN (`;
  const start = ddlText.indexOf(marker);
  assert.notEqual(start, -1, `DDL has no CHECK (${column} IN (...)) constraint`);
  const rest = ddlText.slice(start + marker.length);
  const end = rest.indexOf("))");
  assert.notEqual(end, -1, "unterminated CHECK literal list in DDL");
  return [...rest.slice(0, end).matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

/** Collapse whitespace so textually different but identical DDLs compare equal. */
function normalized(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Count events-table rebuilds by intercepting `db.exec`. The rebuild is the
 * only statement sequence that creates the `events_new` staging table, so this
 * count pins the "at most one table rebuild" contract directly.
 */
function spyEventsRebuilds(db: Database.Database): { count(): number; restore(): void } {
  const original = db.exec.bind(db);
  let eventsRebuilds = 0;
  (db as unknown as { exec?: unknown }).exec = (sql: string): unknown => {
    if (typeof sql === "string" && sql.includes("CREATE TABLE events_new")) eventsRebuilds += 1;
    return original(sql);
  };
  return {
    count: () => eventsRebuilds,
    restore: () => { delete (db as unknown as { exec?: unknown }).exec; },
  };
}

/** Apply the schema and report how many events-table rebuilds it performed. */
function runApplySchema(db: Database.Database): number {
  const spy = spyEventsRebuilds(db);
  try {
    applySchema(db);
  } finally {
    spy.restore();
  }
  return spy.count();
}

function insertEvent(db: Database.Database, type: string, summary: string): void {
  db.prepare(
    "INSERT INTO events (artifact_id, type, agent, summary) VALUES ('legacy-source:com.acme:Old', ?, 'code-writer-agent', ?)",
  ).run(type, summary);
}

function eventCount(db: Database.Database): number {
  return (db.prepare("SELECT count(*) AS c FROM events").get() as { c: number }).c;
}

function createFreshRegistry(): Database.Database {
  const fresh = new Database(":memory:");
  applySchema(fresh);
  return fresh;
}

// ─── Historical fixtures ─────────────────────────────────────────────────────────────────────

/**
 * The event-type additions each historical shape predates. Expressing shapes
 * as "the current CHECK minus these literals" keeps the fixtures aligned with
 * the canonical vocabulary instead of duplicating a hand-copied list.
 */
const REMEDIATION_ADDITION = "remediation-confirmed-no-defect";
const APPROVAL_ADDITIONS = ["approval-gated", "approval-approved", "approval-rejected"];
const ADVERSARY_ADDITIONS = ["adversary-flagged", "adversary-inconclusive", "adversary-probe-passed"];

function eventTypesOmitting(omitted: readonly string[]): string[] {
  return EVENT_TYPE_CHECK_LITERALS.filter((literal) => !omitted.includes(literal));
}

/** Event vocabulary of a registry opened by a kit older than #154 (US2). */
const PRE_154_EVENT_TYPES = eventTypesOmitting([
  REMEDIATION_ADDITION, ...APPROVAL_ADDITIONS, ...ADVERSARY_ADDITIONS,
]);

interface LegacyOptions {
  /** The event-type CHECK vocabulary the legacy events table carries. */
  eventTypes: readonly string[];
  /** Simulate a table reshaped beyond any supported version (failure surfacing). */
  omitEventColumn?: string;
  omitEvidenceColumn?: string;
}

/**
 * Column definitions for the legacy events table. Building the DDL from a
 * name→definition map lets a variant drop one column (simulating a shape no
 * supported version produced) without string surgery.
 */
const EVENTS_TABLE_COLUMN_DEFS: Readonly<Record<string, string>> = {
  event_id: "event_id     TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8))))",
  ts: "ts           TEXT NOT NULL DEFAULT (datetime('now'))",
  artifact_id: "artifact_id  TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE",
  type: "type         TEXT NOT NULL CHECK (type IN (@EVENT_TYPES@))",
  agent: "agent        TEXT NOT NULL",
  model: "model        TEXT",
  summary: "summary      TEXT NOT NULL",
  event_data: "event_data   TEXT",
};

const EVENTS_TABLE_COLUMN_ORDER = [
  "event_id", "ts", "artifact_id", "type", "agent", "model", "summary", "event_data",
];

/** Legacy evidence table: pre-authenticity shape (no guarded columns, narrow CHECK). */
const EVIDENCE_TABLE_COLUMN_DEFS: Readonly<Record<string, string>> = {
  evidence_id: "evidence_id     TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8))))",
  artifact_id: "artifact_id     TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE",
  run_id: "run_id          TEXT REFERENCES runs(run_id) ON DELETE SET NULL",
  produced_by: "produced_by     TEXT NOT NULL",
  evidence_type: "evidence_type   TEXT NOT NULL CHECK (evidence_type IN (@EVIDENCE_TYPES@))",
  command: "command         TEXT",
  exit_code: "exit_code       INTEGER",
  pass: "pass            INTEGER NOT NULL CHECK (pass IN (0, 1))",
  summary: "summary         TEXT NOT NULL",
  output_path: "output_path     TEXT",
  output_excerpt: "output_excerpt  TEXT",
  created_at: "created_at      TEXT NOT NULL DEFAULT (datetime('now'))",
};

const EVIDENCE_TABLE_COLUMN_ORDER = [
  "evidence_id", "artifact_id", "run_id", "produced_by", "evidence_type",
  "command", "exit_code", "pass", "summary", "output_path", "output_excerpt",
  "created_at",
];

function createTableFromDefs(
  db: Database.Database,
  table: string,
  defs: Readonly<Record<string, string>>,
  order: readonly string[],
  omit: string | undefined,
  placeholder: string,
  literals: readonly string[],
): void {
  const literalList = literals.map((literal) => `'${literal}'`).join(", ");
  const columnsSql = order
    .filter((name) => name !== omit)
    .map((name) => "        " + defs[name].replace(placeholder, literalList))
    .join(",\n");
  db.exec(`CREATE TABLE ${table} (\n${columnsSql}\n    );`);
}

/**
 * The oldest registry shape that still opens today: every column any base
 * `CREATE INDEX` references is present (that is what gates opening), while
 * every column the guarded upgrade path reinstates is absent. Historical rows
 * are seeded so preservation can be asserted after the upgrade.
 */
function createLegacyRegistry(db: Database.Database, opts: LegacyOptions): void {
  db.pragma("foreign_keys = ON");

  // No claimed_by/claimed_at/claimed_from: pre-lease era. tier is present —
  // idx_artifacts_tier (base schema) cannot be created without it. The status
  // CHECK predates 'pending-approval' (see the reported compat risk in the
  // issue write-up: artifacts.status CHECK widening has no upgrade path).
  db.exec(`
    CREATE TABLE artifacts (
        id           TEXT PRIMARY KEY,
        slug         TEXT NOT NULL UNIQUE,
        kind         TEXT NOT NULL CHECK (kind IN (
                         'legacy-source', 'target-source', 'test', 'module',
                         'config', 'descriptor', 'sql-schema', 'properties',
                         'shared-constants'
                     )),
        tier         TEXT NOT NULL DEFAULT 'second-class' CHECK (tier IN ('first-class', 'second-class')),
        path         TEXT NOT NULL,
        module       TEXT,
        role         TEXT CHECK (role IS NULL OR role IN (
                         'rest-endpoint', 'exception-handler', 'startup-config',
                         'filter', 'service', 'utility', 'model', 'test',
                         'module', 'entry-point', 'transformer', 'interface'
                     )),
        framework    TEXT,
        status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                         'pending', 'planned', 'analyzed', 'in-progress',
                         'tests-written', 'migrated', 'reviewed', 'needs-rework',
                         'completed', 'blocked', 'skipped'
                     )),
        wave         INTEGER,
        data_path    TEXT,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // owner_id present (idx_runs_owner), but no pid/phase/termination_reason,
  // no token columns, and no attempt-outcome columns.
  db.exec(`
    CREATE TABLE runs (
        run_id       TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
        agent        TEXT NOT NULL,
        owner_id     TEXT,
        model        TEXT,
        prompt       TEXT,
        log_file     TEXT,
        started_at   TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at  TEXT,
        exit_code    INTEGER,
        status       TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed'))
    );
  `);

  // No expected_output_paths.
  db.exec(`
    CREATE TABLE artifact_claims (
        claim_id          TEXT PRIMARY KEY,
        artifact_id       TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
        run_id            TEXT REFERENCES runs(run_id) ON DELETE SET NULL,
        owner_id          TEXT NOT NULL,
        agent             TEXT NOT NULL,
        from_status       TEXT NOT NULL CHECK (from_status IN (
                             'pending', 'planned', 'analyzed', 'in-progress',
                             'tests-written', 'migrated', 'reviewed', 'needs-rework',
                             'completed', 'blocked', 'skipped'
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
  `);

  // Pre-authenticity evidence table: no log_sha256/duration_ms/authenticity/
  // content_sha256/signature_json, and a CHECK without 'characterization-fixture'.
  createTableFromDefs(
    db,
    "acceptance_evidence",
    EVIDENCE_TABLE_COLUMN_DEFS,
    EVIDENCE_TABLE_COLUMN_ORDER,
    opts.omitEvidenceColumn,
    "@EVIDENCE_TYPES@",
    EVIDENCE_TYPE_CHECK_LITERALS.filter((literal) => literal !== "characterization-fixture"),
  );

  // The trigger exists on every real old database. Its body references
  // claimed_by, which this artifacts table lacks — SQLite compiles trigger
  // bodies lazily, so creation succeeds here and the upgrade must heal the
  // column before the trigger next fires.
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

  // The events table with its era's CHECK vocabulary.
  createTableFromDefs(
    db,
    "events",
    EVENTS_TABLE_COLUMN_DEFS,
    EVENTS_TABLE_COLUMN_ORDER,
    opts.omitEventColumn,
    "@EVENT_TYPES@",
    opts.eventTypes,
  );

  // Sanity: the fixture's shapes really are what the test intends.
  assert.equal(columns(db, "artifacts").some((c) => c.name === "claimed_by"), false);
  assert.equal(columns(db, "runs").some((c) => NEW_RUNS_COLUMNS.includes(c.name)), false);
  assert.equal(columns(db, "runs").some((c) => c.name === "token_input"), false);
  assert.equal(columns(db, "artifact_claims").some((c) => c.name === "expected_output_paths"), false);
  assert.equal(columns(db, "acceptance_evidence").some((c) => c.name === "log_sha256"), false);
  assert.deepEqual(checkLiterals(ddl(db, "events"), "type"), [...opts.eventTypes]);
  assert.equal(ddl(db, "acceptance_evidence").includes("'characterization-fixture'"), false);

  // Historical rows that must survive every upgrade untouched.
  db.prepare(`
    INSERT INTO artifacts (id, slug, kind, path, status)
    VALUES ('legacy-source:com.acme:Old', 'legacy-source-com-acme-old', 'legacy-source', 'legacy/Old.java', 'migrated')
  `).run();
  db.prepare("INSERT INTO runs (run_id, agent, status) VALUES ('old-run', 'code-writer-agent', 'completed')").run();
  db.prepare(`
    INSERT INTO artifact_claims (claim_id, artifact_id, run_id, owner_id, agent, from_status, claim_token, state, attempt_no, lease_expires_at)
    VALUES ('claim-1', 'legacy-source:com.acme:Old', 'old-run', 'owner-1', 'code-writer-agent', 'migrated', 'token-1', 'completed', 1, '2026-01-01T00:00:00')
  `).run();
  insertEvent(db, "claimed", "seeded before upgrade");
  db.prepare(`
    INSERT INTO acceptance_evidence (artifact_id, produced_by, evidence_type, pass, summary)
    VALUES ('legacy-source:com.acme:Old', 'code-writer-agent', 'test-command', 1, 'seeded before upgrade')
  `).run();
}

// ─── Fresh databases ─────────────────────────────────────────────────────────────────────────

test("a fresh registry ends with artifact_verifications, all eight runs columns, and the three new indexes", () => {
  const db = new Database(":memory:");
  try {
    // A fresh database needs no events rebuild at all.
    assert.equal(runApplySchema(db), 0);

    assert.ok(names(db, "table").includes("artifact_verifications"));

    const verificationColumns = columns(db, "artifact_verifications");
    assert.deepEqual(verificationColumns.map((c) => c.name), [
      "artifact_id", "state", "method", "reason", "detail", "scope_json",
      "budget_ms", "duration_ms", "run_id", "determined_at",
    ]);
    assert.equal(verificationColumns.find((c) => c.name === "artifact_id")?.pk, 1);
    assert.equal(verificationColumns.find((c) => c.name === "state")?.notnull, 1);
    assert.equal(verificationColumns.find((c) => c.name === "method")?.notnull, 1);
    assert.equal(verificationColumns.find((c) => c.name === "determined_at")?.notnull, 1);

    const verificationDdl = ddl(db, "artifact_verifications");
    for (const state of ["verified", "unverified", "verification-failed"]) {
      assert.match(verificationDdl, new RegExp(`'${state}'`));
    }
    assert.match(verificationDdl, /REFERENCES\s+artifacts\(id\)\s+ON DELETE CASCADE/i);
    assert.match(verificationDdl, /REFERENCES\s+runs\(run_id\)\s+ON DELETE SET NULL/i);

    const runsColumns = columns(db, "runs").map((c) => c.name);
    for (const column of NEW_RUNS_COLUMNS) {
      assert.ok(runsColumns.includes(column), `runs is missing ${column}`);
    }

    const indexes = names(db, "index");
    for (const index of NEW_INDEXES) {
      assert.ok(indexes.includes(index), `missing index ${index}`);
    }

    // The fresh events CHECK carries the full current vocabulary, and the
    // status-change trigger exists.
    assert.deepEqual(checkLiterals(ddl(db, "events"), "type"), EVENT_TYPE_CHECK_LITERALS);
    assert.deepEqual(
      checkLiterals(ddl(db, "acceptance_evidence"), "evidence_type"),
      EVIDENCE_TYPE_CHECK_LITERALS,
    );
    assert.ok(names(db, "trigger").includes("trg_artifact_status_change"));
  } finally {
    db.close();
  }
});

test("repeated application on a fresh registry is a no-op", () => {
  const db = new Database(":memory:");
  try {
    applySchema(db);
    const before = db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
    assert.equal(runApplySchema(db), 0);
    const after = db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
    assert.deepEqual(after, before);
    assert.equal(columns(db, "runs").filter((c) => c.name === "outcome_label").length, 1);
  } finally {
    db.close();
  }
});

test("no pre-existing table, column, CHECK, trigger, or index is modified or dropped", () => {
  const db = new Database(":memory:");
  try {
    applySchema(db);

    for (const table of PRE_FEATURE_TABLES) {
      assert.ok(names(db, "table").includes(table), `table ${table} was dropped`);
    }
    for (const index of PRE_FEATURE_INDEXES) {
      assert.ok(names(db, "index").includes(index), `index ${index} was dropped`);
    }
    for (const trigger of PRE_FEATURE_TRIGGERS) {
      assert.ok(names(db, "trigger").includes(trigger), `trigger ${trigger} was dropped`);
    }

    // The pre-feature runs columns keep their identity, order, and constraints;
    // the new columns are appended after them.
    const runsColumns = columns(db, "runs");
    assert.deepEqual(
      runsColumns.slice(0, PRE_FEATURE_RUNS_COLUMNS.length).map((c) => c.name),
      PRE_FEATURE_RUNS_COLUMNS,
    );
    assert.deepEqual(
      runsColumns.slice(PRE_FEATURE_RUNS_COLUMNS.length).map((c) => c.name).sort(),
      [...NEW_RUNS_COLUMNS].sort(),
    );
    const runsDdl = ddl(db, "runs");
    assert.match(runsDdl, /token_total\s+INTEGER NOT NULL DEFAULT 0 CHECK \(token_total >= 0\)/i);
    assert.match(runsDdl, /status\s+TEXT NOT NULL DEFAULT 'running' CHECK \(status IN \('running', 'completed', 'failed'\)\)/i);
    // Every new column is nullable and constraint-free, per the contract.
    for (const column of NEW_RUNS_COLUMNS) {
      const info = runsColumns.find((c) => c.name === column)!;
      assert.equal(info.notnull, 0, `${column} must be nullable`);
      assert.equal(info.dflt_value, null, `${column} must not carry a default`);
    }

    // The events type CHECK list carries exactly the canonical vocabulary —
    // never a stale or invented literal.
    const eventsDdl = ddl(db, "events");
    assert.match(eventsDdl, /'filesystem-violation'/);
    assert.equal(/out-of-scope/i.test(eventsDdl), false);
    assert.deepEqual(checkLiterals(eventsDdl, "type"), EVENT_TYPE_CHECK_LITERALS);

    // artifact_verifications must not link to acceptance_evidence (research R11).
    assert.equal(/acceptance_evidence/i.test(ddl(db, "artifact_verifications")), false);
    assert.equal(/artifact_verifications/i.test(ddl(db, "acceptance_evidence")), false);
    assert.equal(/artifact_verifications/i.test(ddl(db, "arbitration_decisions")), false);
  } finally {
    db.close();
  }
});

// ─── In-place upgrades of supported historical shapes ────────────────────────

test("an existing registry created before the feature upgrades in place with no backfill", () => {
  const dir = makeTempDir("guild-schema-delta-");
  const dbPath = path.join(dir, "legacy-registry.db");
  const db = new Database(dbPath);
  try {
    createLegacyRegistry(db, { eventTypes: PRE_154_EVENT_TYPES });

    // One rebuild reaches the current events constraint from the oldest shape.
    assert.equal(runApplySchema(db), 1);

    // Every guarded column is reinstated.
    for (const [table, expected] of Object.entries(UPGRADED_COLUMNS_BY_TABLE)) {
      const upgraded = columns(db, table).map((c) => c.name);
      for (const column of expected) {
        assert.ok(upgraded.includes(column), `in-place upgrade did not add ${table}.${column}`);
      }
    }
    assert.ok(names(db, "table").includes("artifact_verifications"));
    for (const index of [...NEW_INDEXES, ...PRE_FEATURE_INDEXES]) {
      assert.ok(names(db, "index").includes(index), `in-place upgrade did not add ${index}`);
    }

    // Historical rows survive untouched; defaults/backfills land as documented.
    const oldRun = db.prepare("SELECT * FROM runs WHERE run_id = 'old-run'").get() as Record<string, unknown>;
    assert.equal(oldRun["agent"], "code-writer-agent");
    assert.equal(oldRun["status"], "completed");
    for (const column of NEW_RUNS_COLUMNS) {
      assert.equal(oldRun[column], null, `${column} should read NULL on a pre-feature row`);
    }
    assert.equal(oldRun["token_input"], 0, "token columns must backfill to their guarded default");
    const oldArtifact = db
      .prepare("SELECT * FROM artifacts WHERE id = 'legacy-source:com.acme:Old'")
      .get() as Record<string, unknown>;
    assert.equal(oldArtifact["status"], "migrated");
    assert.equal(oldArtifact["tier"], "second-class");
    assert.equal(oldArtifact["claimed_by"], null);
    const oldClaim = db.prepare("SELECT * FROM artifact_claims WHERE claim_id = 'claim-1'").get() as Record<string, unknown>;
    assert.equal(oldClaim["state"], "completed");
    assert.equal(oldClaim["expected_output_paths"], null);
    const oldEvidence = db
      .prepare("SELECT * FROM acceptance_evidence WHERE artifact_id = 'legacy-source:com.acme:Old'")
      .get() as Record<string, unknown>;
    assert.equal(oldEvidence["evidence_type"], "test-command");
    assert.equal(oldEvidence["pass"], 1);

    // The upgraded column sets equal a fresh registry's (order-insensitively:
    // guarded ADD COLUMNs append where the old base CREATE TABLE did not).
    const freshForColumns = createFreshRegistry();
    try {
      for (const table of ["artifacts", "runs", "artifact_claims", "acceptance_evidence", "events"]) {
        assert.deepEqual(
          columns(db, table).map((c) => c.name).sort(),
          columns(freshForColumns, table).map((c) => c.name).sort(),
          `${table} columns after upgrade must match a fresh registry`,
        );
      }
    } finally {
      freshForColumns.close();
    }

    // The rebuilt events table enforces the current constraint.
    assert.deepEqual(checkLiterals(ddl(db, "events"), "type"), EVENT_TYPE_CHECK_LITERALS);
    insertEvent(db, "remediation-confirmed-no-defect", "post-upgrade event");
    insertEvent(db, "adversary-probe-passed", "post-upgrade event");
    assert.throws(
      () => insertEvent(db, "not-an-event-type", "rejected"),
      /CHECK constraint failed/,
    );
    assert.deepEqual(
      checkLiterals(ddl(db, "acceptance_evidence"), "evidence_type"),
      EVIDENCE_TYPE_CHECK_LITERALS,
    );

    // The events indexes were recreated with the rebuilt table.
    for (const index of ["idx_events_artifact", "idx_events_type", "idx_events_ts"]) {
      assert.ok(names(db, "index").includes(index), `rebuilt events lost ${index}`);
    }

    // The trigger was dropped and recreated identically, and it still works.
    const freshForTrigger = createFreshRegistry();
    let freshTrigger: string;
    try {
      freshTrigger = ddl(freshForTrigger, "trg_artifact_status_change");
    } finally {
      freshForTrigger.close();
    }
    assert.equal(
      normalized(ddl(db, "trg_artifact_status_change").replace(/IF NOT EXISTS\s+/i, "")),
      normalized(freshTrigger.replace(/IF NOT EXISTS\s+/i, "")),
      "the recreated trigger must be identical to the fresh-schema definition",
    );
    db.prepare("UPDATE artifacts SET status = 'reviewed' WHERE id = 'legacy-source:com.acme:Old'").run();
    const statusChange = db
      .prepare("SELECT agent, summary FROM events WHERE type = 'status-changed'")
      .get() as { agent: string; summary: string };
    assert.equal(statusChange.agent, "system");
    assert.match(statusChange.summary, /migrated → reviewed/);

    // Repeated application: nothing changes, nothing rebuilds, no duplicates.
    assert.equal(runApplySchema(db), 0);
    assert.equal(columns(db, "runs").filter((c) => c.name === "outcome_label").length, 1);
    assert.equal(eventCount(db), 4); // 1 seeded + 2 post-upgrade + 1 trigger event
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("each supported older events shape reaches the current constraint with at most one table rebuild", () => {
  const shapes: ReadonlyArray<{ name: string; omitted: readonly string[] }> = [
    {
      name: "pre-#154 (missing the remediation and adversary additions)",
      omitted: [REMEDIATION_ADDITION, ...ADVERSARY_ADDITIONS],
    },
    {
      name: "post-#154 (missing the approval and adversary additions)",
      omitted: [...APPROVAL_ADDITIONS, ...ADVERSARY_ADDITIONS],
    },
    {
      name: "spec-013 era (missing only the adversary additions)",
      omitted: ADVERSARY_ADDITIONS,
    },
    {
      name: "adversary without remediation (the guard keys on any missing literal)",
      omitted: [REMEDIATION_ADDITION],
    },
  ];

  for (const shape of shapes) {
    const db = new Database(":memory:");
    try {
      createLegacyRegistry(db, { eventTypes: eventTypesOmitting(shape.omitted) });
      assert.equal(eventCount(db), 1);

      assert.equal(runApplySchema(db), 1, shape.name);
      assert.equal(eventCount(db), 1, `${shape.name}: historical events must survive`);
      assert.deepEqual(
        checkLiterals(ddl(db, "events"), "type"),
        EVENT_TYPE_CHECK_LITERALS,
        shape.name,
      );
      insertEvent(db, "remediation-confirmed-no-defect", "accepted after upgrade");
      insertEvent(db, "adversary-inconclusive", "accepted after upgrade");

      // Re-opening the upgraded database never rebuilds again.
      assert.equal(runApplySchema(db), 0, `${shape.name}: repeat application must not rebuild`);
      assert.equal(eventCount(db), 3);
    } finally {
      db.close();
    }
  }
});

test("a stale events_new left by an interrupted rebuild does not block the upgrade", () => {
  const db = new Database(":memory:");
  try {
    createLegacyRegistry(db, { eventTypes: PRE_154_EVENT_TYPES });
    db.exec("CREATE TABLE events_new (junk TEXT)"); // interrupted earlier rebuild

    assert.equal(runApplySchema(db), 1);

    assert.equal(names(db, "table").includes("events_new"), false);
    assert.deepEqual(checkLiterals(ddl(db, "events"), "type"), EVENT_TYPE_CHECK_LITERALS);
    assert.equal(eventCount(db), 1, "historical events must survive the rebuild");
  } finally {
    db.close();
  }
});

test("unexpected upgrade failures surface instead of being silently tolerated", () => {
  // An events table reshaped beyond any supported version must fail loudly,
  // and the failed upgrade must leave the database exactly as it was.
  const db = new Database(":memory:");
  try {
    createLegacyRegistry(db, { eventTypes: PRE_154_EVENT_TYPES, omitEventColumn: "model" });
    assert.throws(() => applySchema(db), /Unsupported events schema shape/);

    const eventsDdl = ddl(db, "events");
    assert.equal(eventsDdl.includes("'adversary-flagged'"), false, "events must be untouched after a failed upgrade");
    assert.equal(eventCount(db), 1);
    assert.ok(names(db, "trigger").includes("trg_artifact_status_change"));
    // Everything the aborted transaction had done rolled back with it.
    assert.equal(columns(db, "artifacts").some((c) => c.name === "claimed_by"), false);
    assert.equal(columns(db, "acceptance_evidence").some((c) => c.name === "log_sha256"), false);
    assert.equal(names(db, "index").includes("idx_runs_outcome_label"), false);
  } finally {
    db.close();
  }

  // Same for an acceptance_evidence table outside the supported shape family.
  const db2 = new Database(":memory:");
  try {
    createLegacyRegistry(db2, { eventTypes: PRE_154_EVENT_TYPES, omitEvidenceColumn: "output_excerpt" });
    assert.throws(() => applySchema(db2), /Unsupported acceptance_evidence schema shape/);

    assert.equal(columns(db2, "acceptance_evidence").some((c) => c.name === "log_sha256"), false);
    assert.equal(ddl(db2, "acceptance_evidence").includes("'characterization-fixture'"), false);
    assert.equal(columns(db2, "runs").some((c) => c.name === "outcome_label"), false);
  } finally {
    db2.close();
  }
});

test("registry_schema.sql and schema.ts agree on the CHECK vocabularies, and the SQL-text migration mechanism is gone", () => {
  const sql = fs.readFileSync(path.resolve(__dirname, "..", "registry_schema.sql"), "utf8");

  // Fresh-schema SQL only: no migration section, no executable ALTER text
  // (statements in this file start at column 0; the only "ALTER TABLE" text
  // left is inside explanatory comments).
  assert.equal(sql.includes("Migrations for existing databases"), false);
  assert.equal(/^\s*ALTER TABLE/im.test(sql), false);

  const eventsBlock = sql.slice(
    sql.indexOf("CREATE TABLE IF NOT EXISTS events"),
    sql.indexOf("CREATE INDEX IF NOT EXISTS idx_events_artifact"),
  );
  assert.deepEqual(checkLiterals(eventsBlock, "type"), EVENT_TYPE_CHECK_LITERALS);

  const evidenceBlock = sql.slice(
    sql.indexOf("CREATE TABLE IF NOT EXISTS acceptance_evidence"),
    sql.indexOf("CREATE TABLE IF NOT EXISTS arbitration_decisions"),
  );
  assert.deepEqual(checkLiterals(evidenceBlock, "evidence_type"), EVIDENCE_TYPE_CHECK_LITERALS);

  // The upgrade path surfaces failures: no catch blocks, no message matching,
  // no warn-and-continue path anywhere in schema.ts.
  const schemaSource = fs.readFileSync(path.resolve(__dirname, "..", "registry", "db", "schema.ts"), "utf8");
  assert.equal(/catch\s*\(/.test(schemaSource), false, "schema.ts must not swallow failures");
  assert.equal(schemaSource.includes("console.warn"), false, "schema.ts must not warn-and-continue");
  assert.equal(schemaSource.includes("Migrations for existing databases"), false);
});
