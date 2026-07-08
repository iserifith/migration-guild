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
  | "planned"
  | "claimed"
  | "claim-heartbeat"
  | "claim-completed"
  | "claim-released"
  | "claim-expired"
  | "run-reaped"
  | "registered"
  | "analyzed"
  | "scaffolded"
  | "migrated"
  | "proposal-submitted"
  | "evidence-submitted"
  | "critique-issued"
  | "arbitration-approved"
  | "arbitration-rejected"
  | "conflict-opened"
  | "conflict-resolved"
  | "benchmark-recorded"
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
  | "thread-created"
  | "dependency-strategy-set";

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

export type EvidenceType =
  | "test-command"
  | "build-command"
  | "static-check"
  | "review-verdict"
  | "benchmark-result";

export interface AcceptanceEvidence {
  evidence_id: string;
  artifact_id: string;
  run_id: string | null;
  produced_by: string;
  evidence_type: EvidenceType;
  command: string | null;
  exit_code: number | null;
  pass: 0 | 1;
  summary: string;
  output_path: string | null;
  output_excerpt: string | null;
  created_at: string;
}

export type ArbitrationDecisionValue = "approved" | "rejected";

export interface ArbitrationDecision {
  decision_id: string;
  artifact_id: string;
  arbiter: string;
  decision: ArbitrationDecisionValue;
  reason: string;
  evidence_ids: string;
  decided_at: string;
}


export type BenchmarkMode = "single-agent" | "guild";
export type BenchmarkVerdict = "pass" | "fail";

export interface BenchmarkRun {
  benchmark_id: string;
  mode: BenchmarkMode;
  fixture: string;
  started_at: string;
  finished_at: string;
  elapsed_ms: number;
  total_runs: number;
  failed_runs: number;
  artifacts_planned: number;
  artifacts_completed: number;
  evidence_pass_rate: number;
  rework_count: number;
  total_cost_usd: number | null;
  verdict: BenchmarkVerdict;
  notes: string | null;
}

export interface BenchmarkComparison {
  baseline: BenchmarkRun;
  guild: BenchmarkRun;
  deltas: {
    elapsed_ms: number;
    failed_runs: number;
    completion_rate: number;
    evidence_pass_rate: number;
    rework_count: number;
    total_cost_usd: number | null;
  };
}

export type ClaimState =
  | "active"
  | "completed"
  | "released"
  | "expired"
  | "failed";

export interface ArtifactClaim {
  claim_id: string;
  artifact_id: string;
  run_id: string | null;
  owner_id: string;
  agent: string;
  from_status: Status;
  claim_token: string;
  state: ClaimState;
  attempt_no: number;
  claimed_at: string;
  heartbeat_at: string;
  lease_expires_at: string;
  finished_at: string | null;
  finish_reason: string | null;
}

export interface ClaimedArtifact extends Artifact {
  claim_id: string;
  claim_token: string;
  claim_run_id: string | null;
  claim_owner_id: string;
  lease_expires_at: string;
  heartbeat_at: string;
  attempt_no: number;
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

export type FindingSeverity = "critical" | "warning";

export type JvmAuditCategory =
  | "internal-api"
  | "removed-api"
  | "deprecated-api"
  | "python-compat";

export interface JvmAuditFinding {
  finding_id: string;
  artifact_id: string;
  tool: string;
  category: JvmAuditCategory;
  severity: FindingSeverity;
  symbol: string | null;
  summary: string;
  evidence: string | null;
  remediation: string;
  detected_at: string;
  dismissed_at: string | null;
  override_id: string | null;
}

export interface AuditOverride {
  override_id: string;
  finding_id: string;
  finding_table: "jvm_audit_findings" | "dependency_findings";
  action: "dismiss" | "reopen";
  reason: string;
  dismissed_by: string;
  created_at: string;
}

export type DependencyRiskCategory =
  | "outdated"
  | "eol"
  | "incompatible";

export interface DependencyFinding {
  finding_id: string;
  artifact_id: string;
  dependency_name: string;
  current_version: string | null;
  target_hint: string | null;
  category: DependencyRiskCategory;
  severity: FindingSeverity;
  summary: string;
  details: string | null;
  remediation: string;
  detected_at: string;
  dismissed_at: string | null;
  override_id: string | null;
}

export type DependencyStrategyKind = "upgrade" | "replace" | "remove";

export interface DependencyStrategyDecision {
  finding_id: string;
  strategy: DependencyStrategyKind;
  target_dependency: string | null;
  target_version: string | null;
  rationale: string;
  approved_by: string;
  approved_at: string;
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
  acceptance_state?: "Proposed" | "Evidence Passed" | "Rejected" | "Accepted";
  evidence?: AcceptanceEvidence[];
  latest_arbitration?: ArbitrationDecision | null;
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
  evidence_gate: {
    migrated_pending_evidence: number;
    evidence_passed_awaiting_arbitration: number;
    approved_arbitration_count: number;
    rejected_arbitration_count: number;
  };
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

export interface ApiPagedResponse<T, TFilters = never> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
  available_filters?: TFilters;
}

export interface ApiSessionFilters {
  statuses: Status[];
}

/** One row in GET /api/blockers. */
export interface ApiBlockerRow {
  artifact_id: string;
  blocker_id: string | null;
  summary: string;
  since: string;
}

export interface ApiIssueFilters {
  severities: string[];
  categories: string[];
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
  token_input: number;
  token_output: number;
  token_reasoning: number;
  token_cache_read: number;
  token_cache_write: number;
  token_fresh: number;
  token_total: number;
}

export interface ApiRunFilters {
  agents: string[];
  statuses: string[];
  models: string[];
}
