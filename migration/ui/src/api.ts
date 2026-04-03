/**
 * Typed HTTP client for the legmod registry API.
 *
 * All fetch calls in the UI should go through this module so that:
 *  - The API contract is visible in one place
 *  - Endpoint URLs never drift between components
 *  - Error handling is uniform
 *
 * Functions for endpoints not yet implemented in serve.ts are marked with a
 * "NOT YET IMPLEMENTED" comment — they will 404 in development until the
 * backend is extended, but are defined here so slice authors don't need to
 * touch this file when the server side lands.
 */

import type {
  Artifact,
  ArtifactEvent,
  StatusResponse,
  WavePlanEntry,
  SessionEntry,
  BlockerEntry,
  IssueEntry,
  EvaluationEntry,
  TraceEntry,
  BatchJobEntry,
  DependencyEntry,
} from "./types";

// ── Internal helpers ──────────────────────────────────────────────────────────

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`API error ${res.status} ${res.statusText} — ${url}`);
  }
  return res.json() as Promise<T>;
}

function buildUrl(base: string, params: Record<string, string | undefined>): string {
  const qs = new URLSearchParams(
    Object.entries(params).filter((entry): entry is [string, string] =>
      entry[1] !== undefined && entry[1] !== ""
    )
  ).toString();
  return qs ? `${base}?${qs}` : base;
}

// ── Query parameter shapes ────────────────────────────────────────────────────

export interface ArtifactQuery {
  status?: string;
  module?: string;
  kind?: string;
}

// ── Implemented endpoints (served by migration/registry/commands/serve.ts) ───

/** GET /api/artifacts — list all artifacts, optionally filtered. */
export function fetchArtifacts(query: ArtifactQuery = {}): Promise<Artifact[]> {
  return get<Artifact[]>(buildUrl("/api/artifacts", query));
}

/** GET /api/status — registry summary + operator state. */
export function fetchStatus(): Promise<StatusResponse> {
  return get<StatusResponse>("/api/status");
}

/** GET /api/wave-plan — per-wave status breakdown (first-class artifacts only). */
export function fetchWavePlan(): Promise<WavePlanEntry[]> {
  return get<WavePlanEntry[]>("/api/wave-plan");
}

/** GET /api/events?id=<artifactId> — event log for one artifact (newest first). */
export function fetchEvents(artifactId: string): Promise<ArtifactEvent[]> {
  return get<ArtifactEvent[]>(
    `/api/events?id=${encodeURIComponent(artifactId)}`
  );
}

// ── Planned endpoints (NOT YET IMPLEMENTED in serve.ts) ─────────────────────
// These will 404 until the API foundation agent extends serve.ts.
// Defined here so slice components can be written against a stable contract.

/** GET /api/sessions — in-progress artifacts with claim ownership data. */
export function fetchSessions(): Promise<SessionEntry[]> {
  return get<SessionEntry[]>("/api/sessions");
}

/** GET /api/blockers — open blocker events. */
export function fetchBlockers(): Promise<BlockerEntry[]> {
  return get<BlockerEntry[]>("/api/blockers");
}

/** GET /api/issues — open issue-opened events. */
export function fetchIssues(): Promise<IssueEntry[]> {
  return get<IssueEntry[]>("/api/issues");
}

/** GET /api/evaluations[?id=<artifactId>] — foundry evaluation results. */
export function fetchEvaluations(artifactId?: string): Promise<EvaluationEntry[]> {
  return get<EvaluationEntry[]>(
    buildUrl("/api/evaluations", { id: artifactId })
  );
}

/** GET /api/traces[?id=<artifactId>] — token/cost traces. */
export function fetchTraces(artifactId?: string): Promise<TraceEntry[]> {
  return get<TraceEntry[]>(buildUrl("/api/traces", { id: artifactId }));
}

/** GET /api/batch-jobs — foundry batch job queue. */
export function fetchBatchJobs(): Promise<BatchJobEntry[]> {
  return get<BatchJobEntry[]>("/api/batch-jobs");
}

/** GET /api/dependencies[?id=<artifactId>] — artifact dependency graph. */
export function fetchDependencies(artifactId?: string): Promise<DependencyEntry[]> {
  return get<DependencyEntry[]>(
    buildUrl("/api/dependencies", { id: artifactId })
  );
}
