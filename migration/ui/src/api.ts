/**
 * Typed HTTP client for the Migration Guild registry API.
 *
 * All fetch calls in the UI should go through this module so that:
 *  - The API contract is visible in one place
 *  - Endpoint URLs never drift between components
 *  - Error handling is uniform
 */

import type {
  Artifact,
  ArtifactEvent,
  ArtifactKind,
  ArtifactStatus,
  ArtifactTier,
  BlockerListResult,
  BlockerQuery,
  BlockerEntry,
  IssueFilters,
  IssueListResult,
  IssueQuery,
  IssueEntry,
  PagedResult,
  RunEntry,
  RunFilters,
  RunListResult,
  RunQuery,
  SessionFilters,
  SessionListResult,
  SessionQuery,
  SessionEntry,
  StatusResponse,
  WavePlanEntry,
} from "./types";

// ── Internal helpers ──────────────────────────────────────────────────────────

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`API error ${res.status} ${res.statusText} — ${url}`);
  }
  return res.json() as Promise<T>;
}

async function getText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`API error ${res.status} ${res.statusText} — ${url}`);
  }
  return res.text();
}

function buildUrl(base: string, params: object): string {
  const qs = new URLSearchParams(
    Object.entries(params)
      .filter(
        (entry): entry is [string, string | number] =>
          (typeof entry[1] === "string" || typeof entry[1] === "number") &&
          entry[1] !== "",
      )
      .map(([key, value]) => [key, String(value)]),
  ).toString();
  return qs ? `${base}?${qs}` : base;
}

function normalizePagedResult<T, TFilters = never>(
  payload: T[] | ApiPagedPayload<T, TFilters>,
): PagedResult<T, TFilters> {
  if (Array.isArray(payload)) {
    return {
      items: payload,
      total: null,
      page: 1,
      page_size: payload.length,
      total_pages: null,
    };
  }

  return {
    items: payload.items,
    total: payload.total,
    page: payload.page,
    page_size: payload.page_size,
    total_pages: payload.total_pages,
    available_filters: payload.available_filters,
  };
}

interface ApiPagedPayload<T, TFilters = never> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
  available_filters?: TFilters;
}

// ── Query parameter shapes ────────────────────────────────────────────────────

export interface ArtifactQuery {
  status?: ArtifactStatus;
  module?: string;
  kind?: ArtifactKind;
  tier?: ArtifactTier;
}

export interface EventQuery {
  id: string;
  limit?: number;
}

// ── Live endpoints (served by migration/registry/commands/serve.ts) ──────────

/** GET /api/artifacts — list all artifacts, optionally filtered. */
export function fetchArtifacts(query: ArtifactQuery = {}): Promise<Artifact[]> {
  return get<Artifact[]>(buildUrl("/api/artifacts", query));
}

/** GET /api/status — registry summary plus operator state. */
export function fetchStatus(): Promise<StatusResponse> {
  return get<StatusResponse>("/api/status");
}

/** GET /api/wave-plan — per-wave status breakdown for first-class artifacts. */
export function fetchWavePlan(): Promise<WavePlanEntry[]> {
  return get<WavePlanEntry[]>("/api/wave-plan");
}

/** GET /api/events?id=<artifactId>[&limit=<n>] — event log for one artifact. */
export function fetchEvents({ id, limit }: EventQuery): Promise<ArtifactEvent[]> {
  return get<ArtifactEvent[]>(buildUrl("/api/events", { id, limit }));
}

/** GET /api/sessions[?stall_minutes=<n>] — in-progress artifacts with stall flag. */
export async function fetchSessions(
  query: SessionQuery = {},
): Promise<SessionListResult> {
  const payload = await get<
    SessionEntry[] | ApiPagedPayload<SessionEntry, SessionFilters>
  >(buildUrl("/api/sessions", query));
  return normalizePagedResult(payload);
}

/** GET /api/blockers — open blocker events. */
export async function fetchBlockers(
  query: BlockerQuery = {},
): Promise<BlockerListResult> {
  const payload = await get<
    BlockerEntry[] | ApiPagedPayload<BlockerEntry>
  >(buildUrl("/api/blockers", query));
  return normalizePagedResult(payload);
}

/** GET /api/issues — open issue events. */
export async function fetchIssues(query: IssueQuery = {}): Promise<IssueListResult> {
  const payload = await get<
    IssueEntry[] | ApiPagedPayload<IssueEntry, IssueFilters>
  >(buildUrl("/api/issues", query));
  return normalizePagedResult(payload);
}

/** GET /api/runs[?agent=<name>&status=<status>&limit=<n>] — run history. */
export async function fetchRuns(query: RunQuery = {}): Promise<RunListResult> {
  const payload = await get<
    RunEntry[] | ApiPagedPayload<RunEntry, RunFilters>
  >(buildUrl("/api/runs", query));
  return normalizePagedResult(payload);
}

/** GET /api/runs/<runId>/log — plain-text log contents for one run. */
export function fetchRunLog(runId: string): Promise<string> {
  return getText(`/api/runs/${encodeURIComponent(runId)}/log`);
}
