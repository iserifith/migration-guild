/**
 * UI-consumer types for the legmod registry API.
 *
 * These types are intentionally maintained in the UI tree so the HTTP contract
 * is explicit from the consumer side. The canonical backend source of truth is
 * migration/registry/types.ts — keep string-literal unions in sync when the
 * backend adds new values.
 *
 * Layout:
 *  - Implemented-endpoint types  (currently served by serve.ts)
 *  - Forward-looking types        (stubs for planned monitoring slices)
 */

// ── Shared enumerations ────────────────────────────────────────────────────────

export type ArtifactKind =
  | "legacy-source"
  | "target-source"
  | "test"
  | "module"
  | "config"
  | "descriptor"
  | "sql-schema"
  | "properties"
  | "shared-constants";

export type ArtifactTier = "first-class" | "second-class";

export type ArtifactStatus =
  | "pending"
  | "planned"
  | "analyzed"
  | "in-progress"
  | "tests-written"
  | "migrated"
  | "reviewed"
  | "needs-rework"
  | "completed"
  | "blocked"
  | "skipped";

export type ArtifactRole =
  | "rest-endpoint"
  | "exception-handler"
  | "startup-config"
  | "filter"
  | "service"
  | "utility"
  | "model"
  | "test"
  | "module"
  | "entry-point"
  | "transformer"
  | "interface";

// ── Implemented endpoint shapes ────────────────────────────────────────────────

/**
 * Shape of each element returned by GET /api/artifacts
 *
 * NOTE: The current serve.ts does a raw `SELECT *` from the artifacts table,
 * so all DB columns are included. Fields present in the registry schema but not
 * yet in App.tsx (slug, tier, framework, claimed_*) are included here so
 * downstream slices can use them without a further API change.
 */
export interface Artifact {
  id: string;
  slug: string;
  kind: ArtifactKind;
  tier: ArtifactTier;
  path: string;
  module: string | null;
  role: ArtifactRole | null;
  framework: string | null;
  status: ArtifactStatus;
  wave: number | null;
  data_path: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  claimed_from: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Shape of each element returned by GET /api/events?id=<artifactId>
 *
 * serve.ts aliases: event_id→id, type→event_type, summary→note
 */
export interface ArtifactEvent {
  id: string;
  event_type: string;
  agent: string | null;
  model: string | null;
  /** Aliased from `summary` in the server response. */
  note: string | null;
  event_data: Record<string, unknown> | null;
  created_at: string;
}

/** Shape returned by GET /api/status */
export interface StatusResponse {
  files: {
    total: number;
    completed: number;
    in_progress: number;
    by_status: Record<string, number>;
  };
  /** Parsed JSON from operator_state.current_focus */
  current_focus: unknown | null;
  /** Parsed JSON from operator_state.next_action */
  next: unknown | null;
}

/** Shape of each element returned by GET /api/wave-plan */
export interface WavePlanEntry {
  wave: number;
  total: number;
  by_status: Record<string, number>;
}

// ── Forward-looking types for planned monitoring slices ───────────────────────
//
// These types describe planned API endpoints that are NOT yet implemented in
// serve.ts. Define them here so slice authors have a single authoritative
// reference and can implement the components without touching types.ts again.
// Shapes are based on the queries already present in registry/commands/queries.ts.

/**
 * /api/sessions — in-progress artifacts with claim ownership data.
 * Slice: "Sessions" tab (stalled agent sessions).
 * Backend query: showInProgress() in queries.ts.
 */
export interface SessionEntry {
  id: string;
  path: string;
  module: string | null;
  role: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  claimed_minutes_ago: number | null;
}

/**
 * /api/blockers — open blocker events (no matching unblocked).
 * Slice: "Blockers" tab.
 * Backend query: showBlockers(db, true) in queries.ts.
 */
export interface BlockerEntry {
  artifact_id: string;
  blocker_id: string | null;
  summary: string;
  since: string;
}

/**
 * /api/issues — open issue-opened events (no matching issue-resolved).
 * Slice: "Blockers" tab (issues panel).
 * Backend query: showIssues(db, true) in queries.ts.
 */
export interface IssueEntry {
  artifact_id: string;
  issue_id: string | null;
  severity: string | null;
  category: string | null;
  summary: string;
  ts: string;
}

/**
 * /api/evaluations — foundry evaluation results per artifact.
 * Slice: "Quality" tab.
 * Backend table: evaluations (eval_id, artifact_id, evaluator, score, pass…).
 */
export interface EvaluationEntry {
  eval_id: string;
  artifact_id: string;
  evaluator: string;
  score: number | null;
  pass: 0 | 1;
  feedback: string | null;
  model: string | null;
  eval_at: string;
}

/**
 * /api/traces — token and cost traces per span.
 * Slice: "Cost" tab.
 * Backend table: traces.
 */
export interface TraceEntry {
  trace_id: string;
  run_id: string | null;
  artifact_id: string | null;
  span_name: string;
  model: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  latency_ms: number | null;
  cost_usd: number | null;
  ts: string;
}

/**
 * /api/batch-jobs — foundry batch job queue.
 * Slice: "Batch Jobs" tab.
 * Backend table: batch_jobs.
 */
export interface BatchJobEntry {
  job_id: string;
  foundry_job_id: string | null;
  type: string;
  wave: number | null;
  status: string;
  /** JSON-encoded array of artifact IDs. */
  artifact_ids: string;
  submitted_at: string;
  completed_at: string | null;
  result_path: string | null;
}

/**
 * /api/dependencies — artifact dependency graph edges.
 * Slice: "Dependencies" tab.
 * Backend table: dependencies.
 */
export interface DependencyEntry {
  artifact_id: string;
  depends_on_id: string;
  relation: string;
}
