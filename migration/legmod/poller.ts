import type Database from "better-sqlite3";

export interface RegistryEvent {
  event_id: string;
  ts: string;
  artifact_id: string;
  type: string;
  agent: string;
  summary: string;
  path: string;
  module: string | null;
}

export function startPolling(
  db: Database.Database,
  onChange: (events: RegistryEvent[]) => void,
  intervalMs = 2000,
): () => void {
  // Use SQLite datetime format
  let lastTs = new Date()
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, "");

  const stmt = db.prepare<[string]>(`
    SELECT e.event_id, e.ts, e.artifact_id, e.type, e.agent, e.summary,
           a.path, a.module
    FROM events e
    JOIN artifacts a ON e.artifact_id = a.id
    WHERE e.ts > ?
    ORDER BY e.ts ASC
  `);

  const handle = setInterval(() => {
    const rows = stmt.all(lastTs) as RegistryEvent[];
    if (rows.length > 0) {
      lastTs = rows[rows.length - 1]!.ts;
      onChange(rows);
    }
  }, intervalMs);

  return () => clearInterval(handle);
}
