import type Database from "better-sqlite3";

export interface FocusState {
  legacyFile: string;
  phase: string;
  targetPath: string;
  status: string;
  summary: string;
}

export interface NextState {
  summary: string;
  reason: string;
  recommendedCommand: string;
}

export interface CompletedEntry {
  id: string;
  type: string;
  summary: string;
  artifactIds: string[];
}

function upsertState(db: Database.Database, key: string, value: unknown): void {
  db.prepare(
    `
    INSERT INTO operator_state (key, value, updated_at)
    VALUES (@key, @value, datetime('now'))
    ON CONFLICT (key) DO UPDATE SET
      value      = excluded.value,
      updated_at = excluded.updated_at
  `,
  ).run({ key, value: JSON.stringify(value) });
}

function readState<T>(db: Database.Database, key: string): T | null {
  const row = db
    .prepare("SELECT value FROM operator_state WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : null;
}

export function setFocus(db: Database.Database, focus: FocusState): void {
  upsertState(db, "current_focus", focus);
}

export function setNext(db: Database.Database, next: NextState): void {
  upsertState(db, "next", next);
}

export function addCompleted(
  db: Database.Database,
  entry: CompletedEntry,
): void {
  const existing = readState<CompletedEntry[]>(db, "completed") ?? [];
  existing.push(entry);
  upsertState(db, "completed", existing);
}
