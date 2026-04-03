import Database from "better-sqlite3";
import * as path from "path";
import { applySchema } from "./schema";

export const DEFAULT_DB_PATH = path.resolve(
  __dirname,   // registry/dist/
  "..",        // registry/
  "..",        // migration/
  "registry.db",
);

let _db: Database.Database | null = null;
let _dbPath: string | null = null;

export function getDb(dbPath?: string): Database.Database {
  // Use || not ?? — empty string from REGISTRY_DB= in .env should fall back to default
  const resolved = dbPath || process.env["REGISTRY_DB"] || DEFAULT_DB_PATH;
  if (_db && _dbPath === resolved) return _db;

  const db = new Database(resolved);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000"); // wait up to 5s on concurrent writes

  // Auto-initialize schema on first open — safe to call on existing DBs too
  applySchema(db);

  _db = db;
  _dbPath = resolved;
  return db;
}
