import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { applySchema } from "../registry/db/schema";
import { makeTempDir } from "./truthful-run-state-fixtures";

/**
 * Foundational coverage for contracts/registry-schema.md.
 *
 * Two properties matter equally: the delta lands, and nothing pre-existing
 * moves. Every addition must be a new table or a nullable/defaulted column so
 * an existing workspace registry upgrades in place with no backfill.
 */

/** Schema objects that existed before this feature and MUST survive unchanged. */
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
];

const PRE_FEATURE_TRIGGERS = ["trg_artifact_status_change"];

/** The 20 `runs` columns that existed before this feature, in order. */
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

/** A registry created by the *pre-feature* schema: base section only, minus this feature's additions. */
function createLegacyRegistry(dbPath: string): void {
  const schemaPath = path.resolve(__dirname, "..", "registry_schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf8");
  const [base = ""] = sql.split(/--\s*─+ Migrations for existing databases/i);
  // Strip everything this feature adds, so the result is genuinely "old".
  const legacy = base
    .replace(/CREATE TABLE IF NOT EXISTS artifact_verifications[\s\S]*?\);/i, "")
    .replace(/CREATE INDEX IF NOT EXISTS idx_artifact_verifications_\w+[^;]*;/gi, "")
    .replace(/CREATE INDEX IF NOT EXISTS idx_runs_outcome_label[^;]*;/gi, "")
    .replace(new RegExp(`^\\s*(?:${NEW_RUNS_COLUMNS.join("|")})\\s+\\w+\\s*,?\\s*$`, "gmi"), "")
    // The stripped columns were the last members of CREATE TABLE runs; drop the
    // comma they left dangling before the closing paren, tolerating the comment
    // lines that introduced them.
    .replace(/,(\s*(?:--[^\n]*\n\s*)*)\)/g, "$1)");
  const db = new Database(dbPath);
  db.exec(legacy);
  // Sanity: the stripped schema really is missing the delta.
  assert.equal(names(db, "table").includes("artifact_verifications"), false,
    "legacy fixture should not already contain artifact_verifications");
  assert.equal(columns(db, "runs").some((c) => NEW_RUNS_COLUMNS.includes(c.name)), false,
    "legacy fixture should not already contain the new runs columns");
  db.close();
}

test("a fresh registry ends with artifact_verifications, all eight runs columns, and the three new indexes", () => {
  const db = new Database(":memory:");
  try {
    applySchema(db);

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
  } finally {
    db.close();
  }
});

test("an existing registry created before the feature upgrades in place with no backfill", () => {
  const dir = makeTempDir("guild-schema-delta-");
  const dbPath = path.join(dir, "legacy-registry.db");
  createLegacyRegistry(dbPath);

  const db = new Database(dbPath);
  try {
    // Historical rows must survive the upgrade untouched.
    db.prepare(`
      INSERT INTO artifacts (id, slug, kind, path, status)
      VALUES ('legacy-source:com.acme:Old', 'legacy-source-com-acme-old', 'legacy-source', 'legacy/Old.java', 'migrated')
    `).run();
    db.prepare("INSERT INTO runs (run_id, agent, status) VALUES ('old-run', 'code-writer-agent', 'completed')").run();

    applySchema(db);

    assert.ok(names(db, "table").includes("artifact_verifications"));
    const runsColumns = columns(db, "runs");
    for (const column of NEW_RUNS_COLUMNS) {
      const info = runsColumns.find((c) => c.name === column);
      assert.ok(info, `in-place upgrade did not add ${column}`);
      assert.equal(info.notnull, 0, `${column} must be nullable so existing rows need no backfill`);
    }
    for (const index of NEW_INDEXES) {
      assert.ok(names(db, "index").includes(index), `in-place upgrade did not add ${index}`);
    }

    const oldRun = db.prepare("SELECT * FROM runs WHERE run_id = 'old-run'").get() as Record<string, unknown>;
    assert.equal(oldRun["agent"], "code-writer-agent");
    assert.equal(oldRun["status"], "completed");
    for (const column of NEW_RUNS_COLUMNS) {
      assert.equal(oldRun[column], null, `${column} should read NULL on a pre-feature row`);
    }
    const oldArtifact = db.prepare("SELECT status FROM artifacts WHERE id = 'legacy-source:com.acme:Old'").get() as { status: string };
    assert.equal(oldArtifact.status, "migrated");

    // Applying twice must remain idempotent.
    applySchema(db);
    assert.equal(columns(db, "runs").filter((c) => c.name === "outcome_label").length, 1);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
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

    // The events type CHECK list is deliberately not extended (FR-010 travels
    // on the existing `filesystem-violation` type).
    const eventsDdl = ddl(db, "events");
    assert.match(eventsDdl, /'filesystem-violation'/);
    assert.equal(/out-of-scope/i.test(eventsDdl), false);

    // artifact_verifications must not link to acceptance_evidence (research R11).
    assert.equal(/acceptance_evidence/i.test(ddl(db, "artifact_verifications")), false);
    assert.equal(/artifact_verifications/i.test(ddl(db, "acceptance_evidence")), false);
    assert.equal(/artifact_verifications/i.test(ddl(db, "arbitration_decisions")), false);
  } finally {
    db.close();
  }
});
