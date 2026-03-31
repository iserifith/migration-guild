export type Kind =
  | "legacy-source"
  | "target-source"
  | "test"
  | "module"
  | "config"
  | "shared-constants";

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
  | "status-changed";

export type Agent =
  | "context-agent"
  | "analyze-agent"
  | "test-agent"
  | "codegen-agent"
  | "planner-agent"
  | "migration-agent"
  | "review-agent"
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
] as const;

export type Tag = (typeof TAG_VOCABULARY)[number];

export interface Artifact {
  id: string;
  slug: string;
  kind: Kind;
  path: string;
  module: string | null;
  role: Role | null;
  framework: string | null;
  status: Status;
  wave: number | null;
  data_path: string | null;
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
} as const;

export class RegistryError extends Error {
  constructor(
    public readonly code: 1 | 2 | 3,
    message: string,
  ) {
    super(message);
    this.name = "RegistryError";
  }
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
