import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import { applyIndexDbSchema } from "./schema";
import { resolveIndexDbPath } from "../guildctl/config";

/**
 * .guild/index.db connection (007-doc-rag-lookup). Mirrors
 * registry/db/connection.ts's getDb: WAL mode, foreign keys on, 5s busy
 * timeout, schema auto-applied on first open.
 */
let _db: Database.Database | null = null;
let _dbPath: string | null = null;

export function getIndexDb(dbPath?: string, workspaceRoot?: string): Database.Database {
  const resolved = dbPath || resolveIndexDbPath({ workspaceRoot });
  if (_db && _dbPath === resolved) return _db;

  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new Database(resolved);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  applyIndexDbSchema(db);

  _db = db;
  _dbPath = resolved;
  return db;
}
