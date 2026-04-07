export type Kind =
  | "legacy-source"
  | "target-source"
  | "test"
  | "module"
  | "config"
  | "descriptor"
  | "sql-schema"
  | "properties"
  | "shared-constants";

/** Kinds that follow the full first-class migration pipeline. */
export const FIRST_CLASS_KINDS: Kind[] = ["legacy-source"];

export type ArtifactTier = "first-class" | "second-class";

export type Role =
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

export type Status =
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

export type Relation =
  | "source-of"
  | "produced-by"
  | "verified-by"
  | "part-of"
  | "related-issue";

export type EventType =
  | "registered"
  | "analyzed"
  | "scaffolded"
  | "migrated"
  | "reviewed"
  | "remediated"
  | "blocked"
  | "unblocked"
  | "completed"
  | "issue-opened"
  | "issue-resolved"
  | "tag-added"
  | "tag-removed"
  | "context-written"
  | "status-changed"
  | "evaluated"
  | "auto-completed"
  | "auto-rework"
  | "batch-submitted"
  | "batch-applied"
  | "thread-created";

export type Agent =
  | "context-agent"
  | "analyze-agent"
  | "test-agent"
  | "codegen-agent"
  | "planner-agent"
  | "stack-advisor"
  | "migration-agent"
  | "review-agent"
  | "reference-agent"
  | "test-writer-agent"
  | "code-writer-agent"
  | "migration-orchestrator"
  | "remediation-agent"
  | "orchestrator";

export const TAG_VOCABULARY = [
  "analyzed",
  "scaffolded",
  "migrated",
  "tests-written",
  "reviewed",
  "ready-for-human-review",
  "needs-follow-up",
  "behavior-risk",
  "test-gap",
  "config-follow-up",
  "dependency-extracted",
  "no-legacy-deps",
  "blocked-external",
  "blocked-human-decision",
  "eval-passed",
  "eval-failed",
  "eval-partial",
  "batch-analyzed",
  "thread-active",
] as const;

export type Tag = (typeof TAG_VOCABULARY)[number];

export interface Artifact {
  id: string;
  slug: string;
  kind: Kind;
  tier: ArtifactTier;
  path: string;
  module: string | null;
  role: Role | null;
  framework: string | null;
  status: Status;
  wave: number | null;
  data_path: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  claimed_from: string | null;
  created_at: string;
  updated_at: string;
}

export interface ArtifactTag {
  artifact_id: string;
  tag: string;
}

export interface Dependency {
  artifact_id: string;
  depends_on_id: string;
  relation: Relation;
}

export interface Event {
  event_id: string;
  ts: string;
  artifact_id: string;
  type: EventType;
  agent: string;
  model: string | null;
  summary: string;
  event_data: string | null;
}

export interface AgentContext {
  artifact_id: string;
  agent: Agent;
  file_path: string;
  summary: string | null;
  updated_at: string;
}

export interface Changelog {
  artifact_id: string;
  file_path: string;
  last_entry: string | null;
  updated_at: string;
}

export interface OperatorState {
  key: string;
  value: string;
  updated_at: string;
}

export const EXIT_CODES = {
  SUCCESS: 0,
  VALIDATION_ERROR: 1,
  NOT_FOUND: 2,
  CONFLICT: 3,
  ALL_DONE: 4,
  NEEDS_CONFIRMATION: 5,
} as const;

export class RegistryError extends Error {
  constructor(
    public readonly code: 1 | 2 | 3 | 4 | 5,
    message: string,
  ) {
    super(message);
    this.name = "RegistryError";
  }
}

export type MappingStrategy = "direct" | "adapter" | "rewrite";

export interface StackMapping {
  id: string;
  legacy_framework: string;
  target_framework: string;
  strategy: MappingStrategy | null;
  notes: string | null;
  confirmed: number; // 0 | 1 (SQLite boolean)
  confirmed_by: string | null;
  confirmed_at: string | null;
  created_at: string;
}

/** `legacy:pcsl:BadRequestExceptionHandler` → `legacy--pcsl--badrequestexceptionhandler` */
export function idToSlug(id: string): string {
  return id.replace(/:/g, "--").toLowerCase();
}

export function validateId(id: string): void {
  const parts = id.split(":");
  if (parts.length !== 3 || parts.some((p) => !p)) {
    throw new RegistryError(
      1,
      `Invalid artifact ID format: "${id}". Expected <kind>:<module>:<ClassName>`,
    );
  }
}

// ─── Foundry types ────────────────────────────────────────────────────────────

export type EvaluatorName =
  | "no-legacy-imports"
  | "signature-preservation"
  | "test-coverage"
  | "correctness";

export interface Evaluation {
  eval_id: string;
  artifact_id: string;
  evaluator: EvaluatorName;
  score: number | null;
  pass: 0 | 1;
  feedback: string | null;
  model: string | null;
  eval_at: string;
}

export type BatchJobType = "inventory" | "embed" | "evaluate";
export type BatchJobStatus = "submitted" | "running" | "completed" | "failed";

export interface BatchJob {
  job_id: string;
  foundry_job_id: string | null;
  type: BatchJobType;
  wave: number | null;
  status: BatchJobStatus;
  artifact_ids: string; // JSON array
  submitted_at: string;
  completed_at: string | null;
  result_path: string | null;
}

export interface Trace {
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

export type AgentThreadType = "migration" | "review" | "context";

export interface AgentThread {
  artifact_id: string;
  thread_id: string;
  agent_type: AgentThreadType;
  created_at: string;
  last_message_at: string | null;
}

// ─── Monitoring Dashboard API DTOs ────────────────────────────────────────────
// Stable response shapes for the monitoring dashboard HTTP endpoints.
// All future feature slices MUST extend these rather than invent new shapes.
// serve.ts is the only allowed consumer of these types on the server side.

/** GET /api/artifacts — one row per artifact, full detail. */
export interface ApiArtifactRow {
  id: string;
  slug: string;
  kind: Kind;
  tier: ArtifactTier;
  path: string;
  module: string | null;
  role: Role | null;
  framework: string | null;
  status: Status;
  wave: number | null;
  data_path: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** GET /api/status — overall migration progress summary. */
export interface ApiStatusResponse {
  files: {
    total: number;
    completed: number;
    in_progress: number;
    pending: number;
    by_status: Record<string, number>;
  };
  /** Parsed value of operator_state key "current_focus" (null if unset). */
  current_focus: unknown | null;
  /** Parsed value of operator_state key "next" (null if unset). */
  next: unknown | null;
  open_blockers: ApiBlockerRow[];
  open_issues: ApiIssueRow[];
}

/** One entry in GET /api/wave-plan. */
export interface ApiWavePlanEntry {
  wave: number;
  total: number;
  by_status: Record<string, number>;
}

/**
 * One row in GET /api/events.
 * Column aliases preserve the names ArtifactDetail.tsx already depends on:
 *   event_id → id, type → event_type, summary → note, ts → created_at
 */
export interface ApiEventRow {
  id: string;
  event_type: string;
  agent: string;
  model: string | null;
  note: string;
  event_data: Record<string, unknown> | null;
  created_at: string;
}

/** One row in GET /api/sessions — in-progress artifact with claim info. */
export interface ApiSessionRow {
  id: string;
  path: string;
  module: string | null;
  role: string | null;
  status: Status;
  claimed_by: string | null;
  claimed_at: string | null;
  claimed_minutes_ago: number | null;
  /** True when claimed_minutes_ago exceeds the stall threshold. */
  stalled: boolean;
}

/** One row in GET /api/blockers. */
export interface ApiBlockerRow {
  artifact_id: string;
  blocker_id: string | null;
  summary: string;
  since: string;
}

/** One row in GET /api/issues. */
export interface ApiIssueRow {
  artifact_id: string;
  issue_id: string | null;
  severity: string | null;
  category: string | null;
  summary: string;
  ts: string;
}

/** One row in GET /api/runs. */
export interface ApiRunRow {
  run_id: string;
  agent: string;
  model: string | null;
  status: string;
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  log_file: string | null;
}

/** One row in GET /api/evaluations — aggregated per evaluator. */
export interface ApiEvalSummary {
  evaluator: EvaluatorName;
  total: number;
  passed: number;
  failed: number;
  avg_score: number | null;
}

/** Top-level shape of GET /api/cost. */
export interface ApiCostSummary {
  total_tokens_in: number;
  total_tokens_out: number;
  total_cost_usd: number;
  total_calls: number;
  by_model: ApiCostByModel[];
}

/** Per-model cost breakdown inside GET /api/cost. */
export interface ApiCostByModel {
  model: string;
  calls: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
}
