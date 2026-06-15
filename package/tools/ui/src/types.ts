/**
 * UI-consumer types for the Migration Guild registry API.
 *
 * These mirror the DTOs currently served by migration/registry/commands/serve.ts
 * and shaped by migration/registry/commands/queries.ts.
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

// ── Live endpoint shapes ───────────────────────────────────────────────────────

/** Shape of each element returned by GET /api/artifacts. */
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
  created_at: string;
  updated_at: string;
}

/** Shape of each element returned by GET /api/events?id=<artifactId>. */
export interface ArtifactEvent {
  id: string;
  event_type: string;
  agent: string;
  model: string | null;
  note: string;
  event_data: Record<string, unknown> | null;
  created_at: string;
}

export type TimeDisplayMode = "utc" | "local";

export interface PagedResult<T, TFilters = never> {
  items: T[];
  total: number | null;
  page: number;
  page_size: number;
  total_pages: number | null;
  available_filters?: TFilters;
}

export interface SessionFilters {
  statuses: ArtifactStatus[];
}

export interface IssueFilters {
  severities: string[];
  categories: string[];
}

export interface RunFilters {
  agents: string[];
  statuses: string[];
  models: string[];
}

export interface SessionQuery {
  stall_minutes?: number;
  status?: ArtifactStatus | "";
  stalled?: "all" | "stalled" | "active";
  sort?: "age-desc" | "age-asc" | "artifact";
  page?: number;
  page_size?: number;
}

export interface BlockerQuery {
  q?: string;
  sort?: "oldest" | "newest" | "artifact";
  page?: number;
  page_size?: number;
}

export interface IssueQuery {
  severity?: string;
  category?: string;
  sort?: "severity" | "latest" | "artifact";
  page?: number;
  page_size?: number;
}

export interface RunQuery {
  agent?: string;
  status?: string;
  model?: string;
  sort?: "newest" | "oldest" | "agent" | "duration";
  limit?: number;
  page?: number;
  page_size?: number;
}

/** Shape returned by GET /api/status. */
export interface StatusResponse {
  files: {
    total: number;
    completed: number;
    in_progress: number;
    pending: number;
    by_status: Record<string, number>;
  };
  current_focus: unknown | null;
  next: unknown | null;
  open_blockers: BlockerEntry[];
  open_issues: IssueEntry[];
}

/** Shape of each element returned by GET /api/wave-plan. */
export interface WavePlanEntry {
  wave: number;
  total: number;
  by_status: Record<string, number>;
}

/** Shape of each element returned by GET /api/sessions. */
export interface SessionEntry {
  id: string;
  path: string;
  module: string | null;
  role: string | null;
  status: ArtifactStatus;
  claimed_by: string | null;
  claimed_at: string | null;
  claimed_minutes_ago: number | null;
  stalled: boolean;
}

export type SessionListResult = PagedResult<SessionEntry, SessionFilters>;

/** Shape of each element returned by GET /api/blockers. */
export interface BlockerEntry {
  artifact_id: string;
  blocker_id: string | null;
  summary: string;
  since: string;
}

export type BlockerListResult = PagedResult<BlockerEntry>;

/** Shape of each element returned by GET /api/issues. */
export interface IssueEntry {
  artifact_id: string;
  issue_id: string | null;
  severity: string | null;
  category: string | null;
  summary: string;
  ts: string;
}

export type IssueListResult = PagedResult<IssueEntry, IssueFilters>;

/** Shape of each element returned by GET /api/runs. */
export interface RunEntry {
  run_id: string;
  agent: string;
  model: string | null;
  status: string;
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  log_file: string | null;
}

export type RunListResult = PagedResult<RunEntry, RunFilters>;

/** Shape of each element returned by GET /api/evaluations. */
export interface EvaluationSummary {
  evaluator: string;
  total: number;
  passed: number;
  failed: number;
  avg_score: number | null;
}

export interface CostByModelEntry {
  model: string;
  calls: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
}

/** Shape returned by GET /api/cost. */
export interface CostSummary {
  total_tokens_in: number;
  total_tokens_out: number;
  total_cost_usd: number;
  total_calls: number;
  by_model: CostByModelEntry[];
}
