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

export type AcceptanceState = "Proposed" | "Evidence Passed" | "Rejected" | "Accepted";

export interface AcceptanceEvidenceRow { evidence_id: string; artifact_id: string; run_id: string | null; produced_by: string; evidence_type: string; command: string | null; exit_code: number | null; pass: 0 | 1; summary: string; output_path: string | null; output_excerpt: string | null; created_at: string; }
export interface ArbitrationDecisionRow { decision_id: string; artifact_id: string; arbiter: string; decision: "approved" | "rejected"; reason: string; evidence_ids: string; decided_at: string; }

export type SocietyRole = "builder" | "critic" | "arbiter";
export type MetricTone = "neutral" | "success" | "warning";
export type WaveTone = "success" | "accent" | "warning";
export type ActivityTone = SocietyRole | "danger";
export interface MissionMetric { label: string; value: string; suffix?: string; detail: string; tone: MetricTone; }
export interface MissionSocietyRole { role: SocietyRole; action: string; count: string; }
export interface MissionWave { label: string; status: string; progress: number; tone: WaveTone; }
export interface MissionActivity { id: string; role: string; message: string; relativeTime: string; tone: ActivityTone; }
export interface MissionControlData { metrics: MissionMetric[]; society: MissionSocietyRole[]; waves: MissionWave[]; activity: MissionActivity[]; }

export interface SocietyArtifactChip {
  artifactId: string;
  name: string;
  agentId: string | null;
  state: string;
  rejected?: boolean;
}

export interface SocietyLane {
  role: SocietyRole;
  activeLabel: string;
  artifacts: SocietyArtifactChip[];
}

export interface LifecycleStep {
  id: string;
  kind: SocietyRole | "gate" | "rejection";
  title: string;
  relativeTime?: string;
  description?: string;
  evidence?: AcceptanceEvidenceRow[];
  decision?: ArbitrationDecisionRow;
}

export interface SocietyLifecycle {
  artifactId: string;
  artifactName: string;
  status: string;
  steps: LifecycleStep[];
}
export interface SocietyViewData { lanes: SocietyLane[]; lifecycles: SocietyLifecycle[]; initialArtifactId: string; }

export interface SocietyResponse {
  roles: Record<string, number>;
  task_division: {
    by_status: Record<string, number>;
    by_wave: Record<string, number>;
    by_tier: Record<string, number>;
    active_claims: number;
  };
  dialogue: Record<string, number>;
  conflict_resolution: {
    claim_releases: number;
    claim_expirations: number;
    reaped_runs: number;
    arbitration_approved: number;
    arbitration_rejected: number;
  };
  evidence: {
    total: number;
    passed: number;
    failed: number;
    pass_rate: number;
    artifacts_awaiting_evidence: number;
    artifacts_awaiting_arbitration: number;
  };
  efficiency: {
    elapsed_runtime_ms: number | null;
    failed_runs: number;
    reworked_artifacts: number;
  };
  artifact?: {
    id: string;
    evidence: AcceptanceEvidenceRow[];
    arbitration: ArbitrationDecisionRow[];
  };
}

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
  acceptance_state?: AcceptanceState;
  evidence?: AcceptanceEvidenceRow[];
  latest_arbitration?: ArbitrationDecisionRow | null;
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
  evidence_gate?: { migrated_pending_evidence: number; evidence_passed_awaiting_arbitration: number; approved_arbitration_count: number; rejected_arbitration_count: number };
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
  token_input: number;
  token_output: number;
  token_reasoning: number;
  token_cache_read: number;
  token_cache_write: number;
  token_fresh: number;
  token_total: number;
}

export type RunListResult = PagedResult<RunEntry, RunFilters>;
