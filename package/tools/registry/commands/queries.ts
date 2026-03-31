import type Database from "better-sqlite3";
import { RegistryError, validateId } from "../types";
import type { Artifact, EventType, Kind, Status, Tag } from "../types";

export function getArtifactById(db: Database.Database, id: string): Artifact {
  validateId(id);
  const row = db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as
    | Artifact
    | undefined;
  if (!row) throw new RegistryError(2, `Artifact not found: "${id}"`);
  return row;
}

export function getArtifactByPath(
  db: Database.Database,
  filePath: string,
): Artifact {
  const row = db
    .prepare("SELECT * FROM artifacts WHERE path = ?")
    .get(filePath) as Artifact | undefined;
  if (!row)
    throw new RegistryError(2, `No artifact found for path: "${filePath}"`);
  return row;
}

export interface ListArtifactsOptions {
  kind?: Kind;
  status?: Status;
  tag?: Tag;
  module?: string;
}

export function listArtifacts(
  db: Database.Database,
  opts: ListArtifactsOptions = {},
): Artifact[] {
  const conditions: string[] = [];
  const params: Record<string, string> = {};

  if (opts.kind) {
    conditions.push("a.kind = @kind");
    params["kind"] = opts.kind;
  }
  if (opts.status) {
    conditions.push("a.status = @status");
    params["status"] = opts.status;
  }
  if (opts.module) {
    conditions.push("a.module = @module");
    params["module"] = opts.module;
  }

  let sql = "SELECT DISTINCT a.* FROM artifacts a";
  if (opts.tag) {
    sql += " JOIN artifact_tags t ON t.artifact_id = a.id AND t.tag = @tag";
    params["tag"] = opts.tag;
  }
  if (conditions.length) sql += " WHERE " + conditions.join(" AND ");
  sql += " ORDER BY a.created_at";

  return db.prepare(sql).all(params) as Artifact[];
}

export function getEventsQuery(
  db: Database.Database,
  id: string,
  type?: EventType,
  limit?: number,
) {
  validateId(id);
  if (!db.prepare("SELECT id FROM artifacts WHERE id = ?").get(id)) {
    throw new RegistryError(2, `Artifact not found: "${id}"`);
  }

  const params: Record<string, string | number> = { id };
  let sql = "SELECT * FROM events WHERE artifact_id = @id";
  if (type) {
    sql += " AND type = @type";
    params["type"] = type;
  }
  sql += " ORDER BY ts DESC";
  if (limit) {
    sql += " LIMIT @limit";
    params["limit"] = limit;
  }

  return db.prepare(sql).all(params);
}

export function showStatus(db: Database.Database) {
  const stateRow = (key: string) =>
    db.prepare("SELECT value FROM operator_state WHERE key = ?").get(key) as
      | { value: string }
      | undefined;

  const openBlockers = db
    .prepare(
      `
    SELECT e.artifact_id,
           json_extract(e.event_data, '$.blocker_id') AS blocker_id,
           e.summary, e.ts AS since
    FROM events e
    WHERE e.type = 'blocked'
      AND NOT EXISTS (
        SELECT 1 FROM events u
        WHERE u.artifact_id = e.artifact_id
          AND u.type = 'unblocked'
          AND json_extract(u.event_data, '$.blocker_id') = json_extract(e.event_data, '$.blocker_id')
      )
  `,
    )
    .all();

  const openIssues = db
    .prepare(
      `
    SELECT e.artifact_id,
           json_extract(e.event_data, '$.issue_id')  AS issue_id,
           json_extract(e.event_data, '$.severity')  AS severity,
           e.summary, e.ts
    FROM events e
    WHERE e.type = 'issue-opened'
      AND NOT EXISTS (
        SELECT 1 FROM events r
        WHERE r.type = 'issue-resolved'
          AND json_extract(r.event_data, '$.issue_id') = json_extract(e.event_data, '$.issue_id')
      )
  `,
    )
    .all();

  const fileCounts = db
    .prepare(
      `
    SELECT status, COUNT(*) AS count FROM artifacts
    WHERE kind IN ('legacy-source', 'target-source')
    GROUP BY status
  `,
    )
    .all() as { status: string; count: number }[];

  const countMap: Record<string, number> = {};
  let total = 0;
  for (const r of fileCounts) {
    countMap[r.status] = r.count;
    total += r.count;
  }

  const focusRow = stateRow("current_focus");
  const nextRow = stateRow("next");
  const doneRow = stateRow("completed");

  return {
    current_focus: focusRow ? JSON.parse(focusRow.value) : null,
    next: nextRow ? JSON.parse(nextRow.value) : null,
    completed_count: doneRow
      ? (JSON.parse(doneRow.value) as unknown[]).length
      : 0,
    open_issues: openIssues,
    open_blockers: openBlockers,
    files: {
      total,
      completed: countMap["completed"] ?? 0,
      in_progress: countMap["in-progress"] ?? 0,
      pending: countMap["pending"] ?? 0,
      by_status: countMap,
    },
  };
}

export function showTask(db: Database.Database) {
  const row = db
    .prepare("SELECT value FROM operator_state WHERE key = 'current_focus'")
    .get() as { value: string } | undefined;
  if (!row) return { current_focus: null, recent_events: [] };

  const focus = JSON.parse(row.value) as { legacyFile?: string };
  let recentEvents: unknown[] = [];

  if (focus.legacyFile) {
    const artifact = db
      .prepare("SELECT id FROM artifacts WHERE path = ?")
      .get(focus.legacyFile) as { id: string } | undefined;
    if (artifact) {
      recentEvents = db
        .prepare(
          "SELECT * FROM events WHERE artifact_id = ? ORDER BY ts DESC LIMIT 5",
        )
        .all(artifact.id);
    }
  }

  return { current_focus: focus, recent_events: recentEvents };
}

export function showNext(db: Database.Database) {
  const row = db
    .prepare("SELECT value FROM operator_state WHERE key = 'next'")
    .get() as { value: string } | undefined;
  return row ? JSON.parse(row.value) : null;
}

export function showIssues(db: Database.Database, openOnly = false) {
  let sql = `
    SELECT e.artifact_id,
           json_extract(e.event_data, '$.issue_id')  AS issue_id,
           json_extract(e.event_data, '$.severity')  AS severity,
           json_extract(e.event_data, '$.category')  AS category,
           e.summary, e.ts
    FROM events e
    WHERE e.type = 'issue-opened'
  `;
  if (openOnly) {
    sql += `
      AND NOT EXISTS (
        SELECT 1 FROM events r
        WHERE r.type = 'issue-resolved'
          AND json_extract(r.event_data, '$.issue_id') = json_extract(e.event_data, '$.issue_id')
      )
    `;
  }
  return db.prepare(sql).all();
}

export function showCompleted(db: Database.Database) {
  const row = db
    .prepare("SELECT value FROM operator_state WHERE key = 'completed'")
    .get() as { value: string } | undefined;
  return row ? JSON.parse(row.value) : [];
}

export function showBlockers(db: Database.Database, openOnly = false) {
  let sql = `
    SELECT e.artifact_id,
           json_extract(e.event_data, '$.blocker_id') AS blocker_id,
           e.summary, e.ts AS since
    FROM events e
    WHERE e.type = 'blocked'
  `;
  if (openOnly) {
    sql += `
      AND NOT EXISTS (
        SELECT 1 FROM events u
        WHERE u.artifact_id = e.artifact_id
          AND u.type = 'unblocked'
          AND json_extract(u.event_data, '$.blocker_id') = json_extract(e.event_data, '$.blocker_id')
      )
    `;
  }
  return db.prepare(sql).all();
}

export function showFileStatus(db: Database.Database, filePath: string) {
  const artifact = db
    .prepare("SELECT * FROM artifacts WHERE path = ?")
    .get(filePath) as Artifact | undefined;
  if (!artifact)
    throw new RegistryError(2, `No artifact found for path: "${filePath}"`);

  const tags = (
    db
      .prepare("SELECT tag FROM artifact_tags WHERE artifact_id = ?")
      .all(artifact.id) as { tag: string }[]
  ).map((t) => t.tag);

  const events = db
    .prepare(
      "SELECT * FROM events WHERE artifact_id = ? ORDER BY ts DESC LIMIT 10",
    )
    .all(artifact.id);

  const context = db
    .prepare(
      "SELECT agent, summary, updated_at FROM agent_context WHERE artifact_id = ?",
    )
    .all(artifact.id);

  return { artifact, tags, recent_events: events, agent_context: context };
}

/** Returns all artifacts currently in-progress, with claim ownership and age. */
export function showInProgress(db: Database.Database): {
  id: string;
  path: string;
  module: string | null;
  role: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  claimed_minutes_ago: number | null;
}[] {
  return db.prepare(`
    SELECT
      id, path, module, role,
      claimed_by,
      claimed_at,
      CASE
        WHEN claimed_at IS NOT NULL
        THEN CAST(ROUND((julianday('now') - julianday(claimed_at)) * 1440) AS INTEGER)
        ELSE NULL
      END AS claimed_minutes_ago
    FROM artifacts
    WHERE status = 'in-progress'
    ORDER BY claimed_at ASC
  `).all() as ReturnType<typeof showInProgress>;
}

/** Returns all planned artifacts whose dependencies are all done — ready to claim now. */
export function listReadyToMigrate(
  db: Database.Database,
  wave?: number,
): Artifact[] {
  const params: Record<string, string | number> = {};
  let waveClause = "";
  if (wave !== undefined) {
    waveClause = "AND a.wave = @wave";
    params["wave"] = wave;
  }

  return db.prepare(`
    SELECT a.*
    FROM artifacts a
    WHERE a.status = 'planned'
      ${waveClause}
      AND NOT EXISTS (
        SELECT 1
        FROM dependencies d
        JOIN artifacts dep ON dep.id = d.depends_on_id
        WHERE d.artifact_id = a.id
          AND dep.status NOT IN ('migrated', 'reviewed', 'completed', 'skipped')
      )
    ORDER BY a.wave ASC, a.created_at ASC
  `).all(params) as Artifact[];
}

/** Returns a summary of all waves: wave number, total files, and counts per status. */
export function wavePlan(db: Database.Database): {
  wave: number;
  total: number;
  by_status: Record<string, number>;
}[] {
  const rows = db.prepare(`
    SELECT wave, status, COUNT(*) AS count
    FROM artifacts
    WHERE wave IS NOT NULL
    GROUP BY wave, status
    ORDER BY wave ASC
  `).all() as { wave: number; status: string; count: number }[];

  const waves: Record<number, { total: number; by_status: Record<string, number> }> = {};
  for (const row of rows) {
    if (!waves[row.wave]) waves[row.wave] = { total: 0, by_status: {} };
    waves[row.wave].by_status[row.status] = row.count;
    waves[row.wave].total += row.count;
  }

  return Object.entries(waves).map(([wave, data]) => ({
    wave: Number(wave),
    ...data,
  }));
}
