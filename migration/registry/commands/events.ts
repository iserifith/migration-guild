import type Database from "better-sqlite3";
import { RegistryError, validateId } from "../types";
import type { Event, EventType } from "../types";

const VALID_EVENT_TYPES: readonly EventType[] = [
  "planned",
  "claimed",
  "claim-heartbeat",
  "claim-completed",
  "claim-released",
  "claim-expired",
  "run-reaped",
  "registered",
  "analyzed",
  "scaffolded",
  "migrated",
  "proposal-submitted",
  "evidence-submitted",
  "critique-issued",
  "arbitration-approved",
  "arbitration-rejected",
  "conflict-opened",
  "conflict-resolved",
  "benchmark-recorded",
  "reviewed",
  "remediated",
  "blocked",
  "unblocked",
  "completed",
  "issue-opened",
  "issue-resolved",
  "tag-added",
  "tag-removed",
  "context-written",
  "status-changed",
  "evaluated",
  "auto-completed",
  "auto-rework",
  "filesystem-violation",
  "thread-created",
  "dependency-strategy-set",
];

export interface AppendEventOptions {
  id: string;
  type: EventType;
  agent: string;
  model?: string;
  summary: string;
  data?: string;
}

export function appendEvent(
  db: Database.Database,
  opts: AppendEventOptions,
): void {
  validateId(opts.id);

  if (!VALID_EVENT_TYPES.includes(opts.type)) {
    throw new RegistryError(1, `Invalid event type: "${opts.type}"`);
  }
  if (!db.prepare("SELECT id FROM artifacts WHERE id = ?").get(opts.id)) {
    throw new RegistryError(2, `Artifact not found: "${opts.id}"`);
  }
  if (opts.data) {
    try {
      JSON.parse(opts.data);
    } catch {
      throw new RegistryError(1, "--data must be valid JSON");
    }
  }

  db.prepare(
    `INSERT INTO events (artifact_id, type, agent, model, summary, event_data)
     VALUES (@artifact_id, @type, @agent, @model, @summary, @event_data)`,
  ).run({
    artifact_id: opts.id,
    type: opts.type,
    agent: opts.agent,
    model: opts.model ?? null,
    summary: opts.summary,
    event_data: opts.data ?? null,
  });
}

export function getEvents(
  db: Database.Database,
  id: string,
  type?: EventType,
  limit?: number,
): Event[] {
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

  return db.prepare(sql).all(params) as Event[];
}
