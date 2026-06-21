import type Database from "better-sqlite3";
import { RegistryError, validateId } from "../types";
import type { Artifact, ArtifactTier, EventType, Kind, Status, Tag } from "../types";

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
  tier?: ArtifactTier;
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
  if (opts.tier) {
    conditions.push("a.tier = @tier");
    params["tier"] = opts.tier;
  }

  let sql = "SELECT DISTINCT a.* FROM artifacts a";
  if (opts.tag) {
    sql += " JOIN artifact_tags t ON t.artifact_id = a.id AND t.tag = @tag";
    params["tag"] = opts.tag;
  }
  if (conditions.length) sql += " WHERE " + conditions.join(" AND ");
  sql += " ORDER BY a.tier ASC, a.created_at";

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

  const rows = db.prepare(sql).all(params) as Array<Record<string, unknown> & { event_data?: string | null }>;
  return rows.map((row) => ({
    ...row,
    event_data: typeof row.event_data === "string" ? JSON.parse(row.event_data) : row.event_data ?? null,
  }));
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

/** Returns all planned first-class artifacts whose dependencies are all done — ready to claim now. */
export function listReadyToMigrate(
  db: Database.Database,
  wave?: number,
  tier?: string,
): Artifact[] {
  const params: Record<string, string | number> = {};
  let waveClause = "";
  let tierClause = "";
  let dependencyTierClause = "";
  if (wave !== undefined) {
    waveClause = "AND a.wave = @wave";
    params["wave"] = wave;
  }
  if (tier) {
    tierClause = "AND a.tier = @tier";
    params["tier"] = tier;
    dependencyTierClause = tier === "first-class" ? "AND dep.tier = 'first-class'" : "";
  } else {
    tierClause = "AND a.tier = 'first-class'";
    dependencyTierClause = "AND dep.tier = 'first-class'";
  }

  return db.prepare(`
    SELECT a.*
    FROM artifacts a
    WHERE a.status = 'planned'
      ${waveClause}
      ${tierClause}
      AND NOT EXISTS (
        SELECT 1
        FROM dependencies d
        JOIN artifacts dep ON dep.id = d.depends_on_id
        WHERE d.artifact_id = a.id
          ${dependencyTierClause}
          AND dep.status NOT IN ('migrated', 'reviewed', 'completed', 'skipped')
      )
    ORDER BY a.wave ASC, a.created_at ASC
  `).all(params) as Artifact[];
}

/** Returns a wave summary for first-class artifacts only. */
export function wavePlan(db: Database.Database): {
  wave: number;
  total: number;
  by_status: Record<string, number>;
}[] {
  const rows = db.prepare(`
    SELECT wave, status, COUNT(*) AS count
    FROM artifacts
    WHERE wave IS NOT NULL
      AND tier = 'first-class'
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

// ─── Monitoring Dashboard API query helpers ───────────────────────────────────
// These are the ONLY functions serve.ts should call to populate API responses.
// All raw SQL for the monitoring layer lives here; serve.ts stays a thin router.

import type {
  ApiArtifactRow,
  ApiStatusResponse,
  ApiWavePlanEntry,
  ApiEventRow,
  ApiPagedResponse,
  ApiSessionRow,
  ApiSessionFilters,
  ApiBlockerRow,
  ApiIssueRow,
  ApiIssueFilters,
  ApiRunRow,
  ApiRunFilters,
  ApiEvalSummary,
  ApiCostSummary,
  ApiCostByModel,
} from "../types";

/** Safe JSON.parse — returns the raw string if the value is not valid JSON. */
function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

function normalizePositiveInt(
  value: number | undefined,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (value == null || !Number.isFinite(value)) {
    return fallback;
  }

  const normalized = Math.trunc(value);
  if (normalized < 1) {
    return fallback;
  }

  return Math.min(normalized, max);
}

function buildPageResult<T, TFilters = never>(
  items: T[],
  total: number,
  page: number,
  pageSize: number,
  availableFilters?: TFilters,
): ApiPagedResponse<T, TFilters> {
  return {
    items,
    total,
    page,
    page_size: pageSize,
    total_pages: Math.max(1, Math.ceil(total / pageSize)),
    ...(availableFilters === undefined ? {} : { available_filters: availableFilters }),
  };
}

function distinctStrings(
  db: Database.Database,
  sql: string,
  params: Record<string, string | number> = {},
): string[] {
  return (db.prepare(sql).all(params) as Array<{ value: string | null }>)
    .map((row) => row.value)
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => left.localeCompare(right));
}


function classifyAcceptanceState(artifact: { status: string }, evidence: Array<{ pass: 0 | 1; evidence_type: string }>, decision: { decision: string } | null): "Proposed" | "Evidence Passed" | "Rejected" | "Accepted" {
  if (decision?.decision === "rejected" || artifact.status === "needs-rework") return "Rejected";
  if ((artifact.status === "reviewed" || artifact.status === "completed") && decision?.decision === "approved") return "Accepted";
  const hasPassingExecutable = evidence.some((e) => e.pass === 1 && ["test-command", "build-command", "static-check"].includes(e.evidence_type));
  if (artifact.status === "migrated" && hasPassingExecutable) return "Evidence Passed";
  return "Proposed";
}

function evidenceGateCounts(db: Database.Database) {
  return {
    migrated_pending_evidence: (db.prepare(`SELECT COUNT(*) AS n FROM artifacts a WHERE a.status = 'migrated' AND NOT EXISTS (SELECT 1 FROM acceptance_evidence e WHERE e.artifact_id = a.id)`).get() as { n: number }).n,
    evidence_passed_awaiting_arbitration: (db.prepare(`SELECT COUNT(*) AS n FROM artifacts a WHERE a.status = 'migrated' AND EXISTS (SELECT 1 FROM acceptance_evidence e WHERE e.artifact_id = a.id AND e.pass = 1 AND e.evidence_type IN ('test-command','build-command','static-check')) AND NOT EXISTS (SELECT 1 FROM arbitration_decisions d WHERE d.artifact_id = a.id AND d.decision = 'approved')`).get() as { n: number }).n,
    approved_arbitration_count: (db.prepare(`SELECT COUNT(*) AS n FROM arbitration_decisions WHERE decision = 'approved'`).get() as { n: number }).n,
    rejected_arbitration_count: (db.prepare(`SELECT COUNT(*) AS n FROM arbitration_decisions WHERE decision = 'rejected'`).get() as { n: number }).n,
  };
}

// ── /api/artifacts ─────────────────────────────────────────────────────────

/** Returns all artifacts, optionally filtered. Typed as the stable DTO. */
export function queryArtifactsForUI(
  db: Database.Database,
  opts: { status?: string; module?: string; kind?: string; tier?: string } = {},
): ApiArtifactRow[] {
  const conditions: string[] = ["1=1"];
  const params: string[] = [];
  if (opts.status) { conditions.push("status = ?"); params.push(opts.status); }
  if (opts.module) { conditions.push("module = ?"); params.push(opts.module); }
  if (opts.kind)   { conditions.push("kind = ?");   params.push(opts.kind);   }
  if (opts.tier)   { conditions.push("tier = ?");   params.push(opts.tier);   }
  const sql = `
    SELECT * FROM artifacts
    WHERE ${conditions.join(" AND ")}
    ORDER BY wave ASC NULLS LAST, id ASC
  `;
  const rows = db.prepare(sql).all(...params) as ApiArtifactRow[];
  return rows.map((row) => {
    const evidence = db.prepare(`SELECT * FROM acceptance_evidence WHERE artifact_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 10`).all(row.id) as ApiArtifactRow["evidence"];
    const latest = db.prepare(`SELECT * FROM arbitration_decisions WHERE artifact_id = ? ORDER BY decided_at DESC, rowid DESC LIMIT 1`).get(row.id) as ApiArtifactRow["latest_arbitration"] | undefined;
    return {
      ...row,
      evidence,
      latest_arbitration: latest ?? null,
      acceptance_state: classifyAcceptanceState(row, evidence ?? [], latest ?? null),
    };
  });
}

// ── /api/status ─────────────────────────────────────────────────────────────

/**
 * Returns the overall migration status summary for the monitoring dashboard.
 *
 * IMPORTANT: operator_state uses the key "next" (not "next_action").
 * The old serve.ts had a bug where it queried "next_action" and always
 * returned null.  This helper uses the correct key.
 */
export function queryStatusSummary(db: Database.Database): ApiStatusResponse {
  const rows = db.prepare(
    "SELECT status, COUNT(*) AS n FROM artifacts GROUP BY status",
  ).all() as { status: string; n: number }[];

  const by_status: Record<string, number> = {};
  let total = 0, in_progress = 0, completed = 0, pending = 0;
  for (const r of rows) {
    by_status[r.status] = r.n;
    total += r.n;
    if (r.status === "in-progress")  in_progress = r.n;
    if (r.status === "pending")      pending     = r.n;
    if (["migrated", "reviewed", "completed", "skipped"].includes(r.status)) {
      completed += r.n;
    }
  }

  const stateVal = (key: string): unknown | null => {
    const row = db
      .prepare("SELECT value FROM operator_state WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row ? tryParseJson(row.value) : null;
  };

  return {
    files: { total, completed, in_progress, pending, by_status },
    current_focus: stateVal("current_focus"),
    next:          stateVal("next"),            // ← correct key (was "next_action")
    open_blockers: queryOpenBlockers(db),
    open_issues:   queryOpenIssues(db),
    evidence_gate: evidenceGateCounts(db),
  };
}

// ── /api/wave-plan ──────────────────────────────────────────────────────────

/** Returns first-class artifact progress by wave, shaped as the API DTO. */
export function queryWavePlanForUI(db: Database.Database): ApiWavePlanEntry[] {
  // wavePlan() already filters tier = 'first-class'; re-use it.
  return wavePlan(db);
}

// ── /api/events ─────────────────────────────────────────────────────────────

/**
 * Returns the event log for a single artifact, with column aliases matching
 * what ArtifactDetail.tsx expects:
 *   event_id → id,  type → event_type,  summary → note,  ts → created_at
 */
export function queryEventsForUI(
  db: Database.Database,
  artifactId: string,
  limit = 50,
): ApiEventRow[] {
  type RawRow = Omit<ApiEventRow, "event_data"> & { event_data: string | null };
  const rows = db.prepare(`
    SELECT
      event_id  AS id,
      type      AS event_type,
      agent,
      model,
      summary   AS note,
      event_data,
      ts        AS created_at
    FROM events
    WHERE artifact_id = ?
    ORDER BY ts DESC
    LIMIT ?
  `).all(artifactId, limit) as RawRow[];

  return rows.map((row) => ({
    ...row,
    event_data: row.event_data
      ? (tryParseJson(row.event_data) as Record<string, unknown>)
      : null,
  }));
}

// ── /api/sessions ───────────────────────────────────────────────────────────

/**
 * Returns all in-progress artifacts annotated with stall detection.
 * An artifact is "stalled" when it has been claimed for more than
 * `thresholdMinutes` without a status change.  Default threshold: 60 min.
 */
export function queryStalledSessions(
  db: Database.Database,
  thresholdMinutes = 60,
): ApiSessionRow[] {
  type RawRow = Omit<ApiSessionRow, "stalled"> & { claimed_minutes_ago: number | null };
  const rows = db.prepare(`
    SELECT
      id, path, module, role, status,
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
  `).all() as RawRow[];

  return rows.map((r) => ({
    ...r,
    stalled:
      r.claimed_minutes_ago != null &&
      r.claimed_minutes_ago > thresholdMinutes,
  }));
}

export function queryStalledSessionsPage(
  db: Database.Database,
  opts: {
    thresholdMinutes?: number;
    status?: string;
    stalled?: "all" | "stalled" | "active";
    sort?: "age-desc" | "age-asc" | "artifact";
    page?: number;
    pageSize?: number;
  } = {},
): ApiPagedResponse<ApiSessionRow, ApiSessionFilters> {
  const thresholdMinutes = normalizePositiveInt(opts.thresholdMinutes, 60, 24 * 60);
  const page = normalizePositiveInt(opts.page, 1);
  const pageSize = normalizePositiveInt(opts.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const params: Record<string, string | number> = {
    thresholdMinutes,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  };
  const conditions = ["1=1"];

  if (opts.status) {
    conditions.push("status = @status");
    params.status = opts.status;
  }
  if (opts.stalled === "stalled") {
    conditions.push("claimed_minutes_ago > @thresholdMinutes");
  } else if (opts.stalled === "active") {
    conditions.push("(claimed_minutes_ago IS NULL OR claimed_minutes_ago <= @thresholdMinutes)");
  }

  let orderBy = "claimed_at ASC";
  if (opts.sort === "age-asc") {
    orderBy = "CASE WHEN claimed_minutes_ago IS NULL THEN 1 ELSE 0 END ASC, claimed_minutes_ago ASC, id ASC";
  } else if (opts.sort === "artifact") {
    orderBy = "id ASC";
  } else {
    orderBy = "CASE WHEN claimed_minutes_ago IS NULL THEN 1 ELSE 0 END ASC, claimed_minutes_ago DESC, id ASC";
  }

  const baseSql = `
    WITH session_rows AS (
      SELECT
        id,
        path,
        module,
        role,
        status,
        claimed_by,
        claimed_at,
        CASE
          WHEN claimed_at IS NOT NULL
          THEN CAST(ROUND((julianday('now') - julianday(claimed_at)) * 1440) AS INTEGER)
          ELSE NULL
        END AS claimed_minutes_ago
      FROM artifacts
      WHERE status = 'in-progress'
    )
  `;
  const whereSql = `WHERE ${conditions.join(" AND ")}`;
  const total = (db.prepare(
    `${baseSql}
     SELECT COUNT(*) AS total
     FROM session_rows
     ${whereSql}`,
  ).get(params) as { total: number }).total;
  const rows = db.prepare(
    `${baseSql}
     SELECT
       id,
       path,
       module,
       role,
       status,
       claimed_by,
       claimed_at,
       claimed_minutes_ago,
       CASE
         WHEN claimed_minutes_ago IS NOT NULL AND claimed_minutes_ago > @thresholdMinutes
         THEN 1
         ELSE 0
       END AS stalled
     FROM session_rows
     ${whereSql}
     ORDER BY ${orderBy}
     LIMIT @limit OFFSET @offset`,
  ).all(params) as Array<Omit<ApiSessionRow, "stalled"> & { stalled: number }>;

  return buildPageResult(rows.map((row) => ({ ...row, stalled: row.stalled === 1 })), total, page, pageSize, {
    statuses: distinctStrings(
      db,
      `
        SELECT DISTINCT status AS value
        FROM artifacts
        WHERE status = 'in-progress'
        ORDER BY status
      `,
    ) as ApiSessionFilters["statuses"],
  });
}

// ── /api/blockers ───────────────────────────────────────────────────────────

/** Returns all currently open blockers (not yet unblocked). */
export function queryOpenBlockers(db: Database.Database): ApiBlockerRow[] {
  return db.prepare(`
    SELECT
      e.artifact_id,
      json_extract(e.event_data, '$.blocker_id') AS blocker_id,
      e.summary,
      e.ts AS since
    FROM events e
    WHERE e.type = 'blocked'
      AND NOT EXISTS (
        SELECT 1 FROM events u
        WHERE u.artifact_id = e.artifact_id
          AND u.type = 'unblocked'
          AND json_extract(u.event_data, '$.blocker_id')
              = json_extract(e.event_data, '$.blocker_id')
      )
    ORDER BY e.ts ASC
  `).all() as ApiBlockerRow[];
}

export function queryOpenBlockersPage(
  db: Database.Database,
  opts: {
    q?: string;
    sort?: "oldest" | "newest" | "artifact";
    page?: number;
    pageSize?: number;
  } = {},
): ApiPagedResponse<ApiBlockerRow> {
  const page = normalizePositiveInt(opts.page, 1);
  const pageSize = normalizePositiveInt(opts.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const params: Record<string, string | number> = {
    limit: pageSize,
    offset: (page - 1) * pageSize,
  };
  const conditions = ["1=1"];

  if (opts.q?.trim()) {
    conditions.push("LOWER(artifact_id || ' ' || COALESCE(blocker_id, '') || ' ' || summary) LIKE @query");
    params.query = `%${opts.q.trim().toLowerCase()}%`;
  }

  const orderBy =
    opts.sort === "artifact"
      ? "artifact_id ASC, since ASC"
      : opts.sort === "newest"
        ? "since DESC, artifact_id ASC"
        : "since ASC, artifact_id ASC";
  const baseSql = `
    WITH blocker_rows AS (
      SELECT
        e.artifact_id,
        json_extract(e.event_data, '$.blocker_id') AS blocker_id,
        e.summary,
        e.ts AS since
      FROM events e
      WHERE e.type = 'blocked'
        AND NOT EXISTS (
          SELECT 1 FROM events u
          WHERE u.artifact_id = e.artifact_id
            AND u.type = 'unblocked'
            AND json_extract(u.event_data, '$.blocker_id')
                = json_extract(e.event_data, '$.blocker_id')
        )
    )
  `;
  const whereSql = `WHERE ${conditions.join(" AND ")}`;
  const total = (db.prepare(
    `${baseSql}
     SELECT COUNT(*) AS total
     FROM blocker_rows
     ${whereSql}`,
  ).get(params) as { total: number }).total;
  const rows = db.prepare(
    `${baseSql}
     SELECT artifact_id, blocker_id, summary, since
     FROM blocker_rows
     ${whereSql}
     ORDER BY ${orderBy}
     LIMIT @limit OFFSET @offset`,
  ).all(params) as ApiBlockerRow[];

  return buildPageResult(rows, total, page, pageSize);
}

// ── /api/issues ─────────────────────────────────────────────────────────────

/** Returns all currently open issues (not yet resolved). */
export function queryOpenIssues(db: Database.Database): ApiIssueRow[] {
  return db.prepare(`
    SELECT
      e.artifact_id,
      json_extract(e.event_data, '$.issue_id')  AS issue_id,
      json_extract(e.event_data, '$.severity')  AS severity,
      json_extract(e.event_data, '$.category')  AS category,
      e.summary,
      e.ts
    FROM events e
    WHERE e.type = 'issue-opened'
      AND NOT EXISTS (
        SELECT 1 FROM events r
        WHERE r.type = 'issue-resolved'
          AND json_extract(r.event_data, '$.issue_id')
              = json_extract(e.event_data, '$.issue_id')
      )
    ORDER BY e.ts ASC
  `).all() as ApiIssueRow[];
}

export function queryOpenIssuesPage(
  db: Database.Database,
  opts: {
    severity?: string;
    category?: string;
    sort?: "severity" | "latest" | "artifact";
    page?: number;
    pageSize?: number;
  } = {},
): ApiPagedResponse<ApiIssueRow, ApiIssueFilters> {
  const page = normalizePositiveInt(opts.page, 1);
  const pageSize = normalizePositiveInt(opts.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const params: Record<string, string | number> = {
    limit: pageSize,
    offset: (page - 1) * pageSize,
  };
  const conditions = ["1=1"];

  if (opts.severity) {
    conditions.push("severity = @severity");
    params.severity = opts.severity;
  }
  if (opts.category) {
    conditions.push("category = @category");
    params.category = opts.category;
  }

  const orderBy =
    opts.sort === "latest"
      ? "ts DESC, artifact_id ASC"
      : opts.sort === "artifact"
        ? "artifact_id ASC, ts ASC"
        : "COALESCE(severity, '') ASC, COALESCE(category, '') ASC, artifact_id ASC";
  const baseSql = `
    WITH issue_rows AS (
      SELECT
        e.artifact_id,
        json_extract(e.event_data, '$.issue_id') AS issue_id,
        json_extract(e.event_data, '$.severity') AS severity,
        json_extract(e.event_data, '$.category') AS category,
        e.summary,
        e.ts
      FROM events e
      WHERE e.type = 'issue-opened'
        AND NOT EXISTS (
          SELECT 1 FROM events r
          WHERE r.type = 'issue-resolved'
            AND json_extract(r.event_data, '$.issue_id')
                = json_extract(e.event_data, '$.issue_id')
        )
    )
  `;
  const whereSql = `WHERE ${conditions.join(" AND ")}`;
  const total = (db.prepare(
    `${baseSql}
     SELECT COUNT(*) AS total
     FROM issue_rows
     ${whereSql}`,
  ).get(params) as { total: number }).total;
  const rows = db.prepare(
    `${baseSql}
     SELECT artifact_id, issue_id, severity, category, summary, ts
     FROM issue_rows
     ${whereSql}
     ORDER BY ${orderBy}
     LIMIT @limit OFFSET @offset`,
  ).all(params) as ApiIssueRow[];

  return buildPageResult(rows, total, page, pageSize, {
    severities: distinctStrings(
      db,
      `
        WITH issue_rows AS (
          SELECT json_extract(e.event_data, '$.severity') AS value
          FROM events e
          WHERE e.type = 'issue-opened'
            AND NOT EXISTS (
              SELECT 1 FROM events r
              WHERE r.type = 'issue-resolved'
                AND json_extract(r.event_data, '$.issue_id')
                    = json_extract(e.event_data, '$.issue_id')
            )
        )
        SELECT DISTINCT value
        FROM issue_rows
        WHERE value IS NOT NULL
        ORDER BY value
      `,
    ),
    categories: distinctStrings(
      db,
      `
        WITH issue_rows AS (
          SELECT json_extract(e.event_data, '$.category') AS value
          FROM events e
          WHERE e.type = 'issue-opened'
            AND NOT EXISTS (
              SELECT 1 FROM events r
              WHERE r.type = 'issue-resolved'
                AND json_extract(r.event_data, '$.issue_id')
                    = json_extract(e.event_data, '$.issue_id')
            )
        )
        SELECT DISTINCT value
        FROM issue_rows
        WHERE value IS NOT NULL
        ORDER BY value
      `,
    ),
  });
}

// ── /api/runs ───────────────────────────────────────────────────────────────

/** Returns agent run history, optionally filtered by agent or status. */
export function queryRunHistory(
  db: Database.Database,
  opts: { agent?: string; status?: string; limit?: number } = {},
): ApiRunRow[] {
  const conditions: string[] = ["1=1"];
  const params: (string | number)[] = [];
  if (opts.agent)  { conditions.push("agent = ?");  params.push(opts.agent);  }
  if (opts.status) { conditions.push("status = ?"); params.push(opts.status); }
  params.push(opts.limit ?? 100);
  const sql = `
    SELECT run_id, agent, model, status, started_at, finished_at, exit_code, log_file
    FROM runs
    WHERE ${conditions.join(" AND ")}
    ORDER BY started_at DESC
    LIMIT ?
  `;
  return db.prepare(sql).all(...params) as ApiRunRow[];
}

export function queryRunHistoryPage(
  db: Database.Database,
  opts: {
    agent?: string;
    status?: string;
    model?: string;
    sort?: "newest" | "oldest" | "agent" | "duration";
    page?: number;
    pageSize?: number;
  } = {},
): ApiPagedResponse<ApiRunRow, ApiRunFilters> {
  const page = normalizePositiveInt(opts.page, 1);
  const pageSize = normalizePositiveInt(opts.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const params: Record<string, string | number> = {
    limit: pageSize,
    offset: (page - 1) * pageSize,
  };
  const conditions = ["1=1"];

  if (opts.agent) {
    conditions.push("agent = @agent");
    params.agent = opts.agent;
  }
  if (opts.status) {
    conditions.push("status = @status");
    params.status = opts.status;
  }
  if (opts.model) {
    conditions.push("model = @model");
    params.model = opts.model;
  }

  const orderBy =
    opts.sort === "oldest"
      ? "started_at ASC, run_id ASC"
      : opts.sort === "agent"
        ? "agent ASC, started_at DESC, run_id ASC"
        : opts.sort === "duration"
          ? `
            CASE
              WHEN finished_at IS NULL THEN 9223372036854775807
              ELSE CAST((julianday(finished_at) - julianday(started_at)) * 86400000 AS INTEGER)
            END DESC,
            started_at DESC,
            run_id ASC
          `
          : "started_at DESC, run_id ASC";
  const whereSql = `WHERE ${conditions.join(" AND ")}`;
  const total = (db.prepare(`
    SELECT COUNT(*) AS total
    FROM runs
    ${whereSql}
  `).get(params) as { total: number }).total;
  const rows = db.prepare(`
    SELECT run_id, agent, model, status, started_at, finished_at, exit_code, log_file
    FROM runs
    ${whereSql}
    ORDER BY ${orderBy}
    LIMIT @limit OFFSET @offset
  `).all(params) as ApiRunRow[];

  return buildPageResult(rows, total, page, pageSize, {
    agents: distinctStrings(
      db,
      `
        SELECT DISTINCT agent AS value
        FROM runs
        WHERE agent IS NOT NULL
        ORDER BY agent
      `,
    ),
    statuses: distinctStrings(
      db,
      `
        SELECT DISTINCT status AS value
        FROM runs
        WHERE status IS NOT NULL
        ORDER BY status
      `,
    ),
    models: distinctStrings(
      db,
      `
        SELECT DISTINCT model AS value
        FROM runs
        WHERE model IS NOT NULL
        ORDER BY model
      `,
    ),
  });
}

// ── /api/evaluations ────────────────────────────────────────────────────────

/**
 * Returns evaluation pass/fail/score summary grouped by evaluator.
 * Optionally scope to a single artifact by passing its ID.
 */
export function queryEvaluationSummary(
  db: Database.Database,
  artifactId?: string,
): ApiEvalSummary[] {
  const conditions: string[] = [];
  const params: string[] = [];
  if (artifactId) {
    conditions.push("artifact_id = ?");
    params.push(artifactId);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `
    SELECT
      evaluator,
      COUNT(*)                                        AS total,
      SUM(CASE WHEN pass = 1 THEN 1 ELSE 0 END)      AS passed,
      SUM(CASE WHEN pass = 0 THEN 1 ELSE 0 END)      AS failed,
      AVG(score)                                      AS avg_score
    FROM evaluations
    ${where}
    GROUP BY evaluator
    ORDER BY evaluator
  `;
  return db.prepare(sql).all(...params) as ApiEvalSummary[];
}

// ── /api/cost ───────────────────────────────────────────────────────────────

/** Returns token-usage and cost totals, broken down by model. */
export function queryCostSummary(db: Database.Database): ApiCostSummary {
  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(tokens_in),  0) AS total_tokens_in,
      COALESCE(SUM(tokens_out), 0) AS total_tokens_out,
      COALESCE(SUM(cost_usd),   0) AS total_cost_usd,
      COUNT(*)                     AS total_calls
    FROM traces
  `).get() as {
    total_tokens_in: number;
    total_tokens_out: number;
    total_cost_usd: number;
    total_calls: number;
  };

  const by_model = db.prepare(`
    SELECT
      COALESCE(model, '(unknown)') AS model,
      COUNT(*)                     AS calls,
      COALESCE(SUM(tokens_in),  0) AS tokens_in,
      COALESCE(SUM(tokens_out), 0) AS tokens_out,
      COALESCE(SUM(cost_usd),   0) AS cost_usd
    FROM traces
    GROUP BY model
    ORDER BY cost_usd DESC
  `).all() as ApiCostByModel[];

  return { ...totals, by_model };
}
