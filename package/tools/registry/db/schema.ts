import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";

export function applySchema(db: Database.Database): void {
  // Resolve schema relative to this file's location so it works regardless of
  // CWD — the schema ships alongside the compiled registry in migration/.
  const schemaPath = path.resolve(
    __dirname,
    "..",  // registry/dist → registry/
    "..",  // registry/ → migration/
    "registry_schema.sql",
  );
  const sql = fs.readFileSync(schemaPath, "utf-8");

  // Split at the migrations section — ALTER TABLE statements for existing DBs
  // are run individually so failures (duplicate column) are silently ignored.
  const [base, migrations = ""] = sql.split(/--\s*─+ Migrations for existing databases/i);

  db.exec(base);

  for (const stmt of migrations.split(";").map(s => s.trim()).filter(Boolean)) {
    try {
      db.exec(stmt + ";");
    } catch {
      // Column already exists — safe to ignore
    }
  }
}
