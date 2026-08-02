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
