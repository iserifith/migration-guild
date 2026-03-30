import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";

export function applySchema(db: Database.Database): void {
  const schemaPath = path.resolve(
    process.cwd(),
    "migration",
    "registry_schema.sql",
  );
  const sql = fs.readFileSync(schemaPath, "utf-8");
  db.exec(sql);
}
