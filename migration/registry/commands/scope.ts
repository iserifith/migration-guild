import type Database from "better-sqlite3";
import { RegistryError } from "../types";
import type { ScopeDecision, ScopeDecisionKind } from "../types";
import { setArtifactStatus } from "./artifacts";

// Pre-migration states a "drop" decision is allowed to bulk-transition to
// skipped. Anything past this point represents work already in flight or
// done, and is left alone — see recordScopeDecision.
const PRE_MIGRATION_STATUSES = ["pending", "planned", "analyzed"] as const;

export interface ModuleScopeSummary {
  module: string;
  artifact_count: number;
  first_class_count: number;
  second_class_count: number;
  decision: ScopeDecisionKind | null;
  reason: string | null;
  decided_by: string | null;
  decided_at: string | null;
  /** Modules with a non-drop artifact that imports/inherits from this module. */
  depended_on_by: Array<{ module: string; edge_count: number }>;
}

export function getModuleScopeSummary(db: Database.Database): ModuleScopeSummary[] {
  const modules = db.prepare(`
    SELECT
      module,
      COUNT(*) AS artifact_count,
      SUM(CASE WHEN tier = 'first-class' THEN 1 ELSE 0 END) AS first_class_count,
      SUM(CASE WHEN tier = 'second-class' THEN 1 ELSE 0 END) AS second_class_count
    FROM artifacts
    WHERE module IS NOT NULL
    GROUP BY module
    ORDER BY module
  `).all() as Array<{
    module: string;
    artifact_count: number;
    first_class_count: number;
    second_class_count: number;
  }>;

  const decisions = new Map(
    (db.prepare("SELECT * FROM scope_decisions").all() as ScopeDecision[]).map((d) => [d.module, d]),
  );

  const crossModuleEdges = db.prepare(`
    SELECT dep_artifact.module AS dependency_module, dependent_artifact.module AS dependent_module,
           COUNT(*) AS edge_count
    FROM source_dependencies sd
    JOIN artifacts dependent_artifact ON dependent_artifact.id = sd.dependent_id
    JOIN artifacts dep_artifact ON dep_artifact.id = sd.dependency_id
    WHERE dep_artifact.module IS NOT NULL
      AND dependent_artifact.module IS NOT NULL
      AND dep_artifact.module != dependent_artifact.module
    GROUP BY dependency_module, dependent_module
  `).all() as Array<{ dependency_module: string; dependent_module: string; edge_count: number }>;

  const dependedOnByModule = new Map<string, Array<{ module: string; edge_count: number }>>();
  for (const edge of crossModuleEdges) {
    const list = dependedOnByModule.get(edge.dependency_module) ?? [];
    list.push({ module: edge.dependent_module, edge_count: edge.edge_count });
    dependedOnByModule.set(edge.dependency_module, list);
  }

  return modules.map((m) => {
    const decision = decisions.get(m.module);
    return {
      module: m.module,
      artifact_count: m.artifact_count,
      first_class_count: m.first_class_count,
      second_class_count: m.second_class_count,
      decision: decision?.decision ?? null,
      reason: decision?.reason ?? null,
      decided_by: decision?.decided_by ?? null,
      decided_at: decision?.decided_at ?? null,
      depended_on_by: dependedOnByModule.get(m.module) ?? [],
    };
  });
}

/** Modules with at least one first-class artifact and no recorded decision. */
export function getUndecidedModules(db: Database.Database): ModuleScopeSummary[] {
  return getModuleScopeSummary(db).filter((m) => m.decision === null && m.first_class_count > 0);
}

export interface RecordScopeDecisionOptions {
  module: string;
  decision: ScopeDecisionKind;
  reason: string;
  decidedBy: string;
}

export interface RecordScopeDecisionResult {
  decision: ScopeDecision;
  /** Pre-migration artifacts transitioned to 'skipped' (only when decision === 'drop'). */
  skippedArtifactIds: string[];
  /** Artifacts left alone because they were already past the pre-migration stage. */
  inFlightArtifactIds: string[];
  /** Kept/other modules whose artifacts import from this one — informational only. */
  crossModuleWarnings: Array<{ module: string; edge_count: number }>;
}

export function recordScopeDecision(
  db: Database.Database,
  opts: RecordScopeDecisionOptions,
): RecordScopeDecisionResult {
  if (!opts.module.trim()) throw new RegistryError(1, "--module is required.");
  if (opts.decision !== "keep" && opts.decision !== "drop") {
    throw new RegistryError(1, `--decision must be "keep" or "drop", got "${opts.decision}".`);
  }
  if (!opts.reason.trim()) throw new RegistryError(1, "--reason is required.");
  if (!opts.decidedBy.trim()) throw new RegistryError(1, "--decided-by is required.");

  const module = opts.module.trim();
  const exists = db.prepare("SELECT 1 FROM artifacts WHERE module = ?").get(module);
  if (!exists) throw new RegistryError(2, `No artifacts found for module: "${module}"`);

  const result = db.transaction((): RecordScopeDecisionResult => {
    db.prepare(`
      INSERT INTO scope_decisions (module, decision, reason, decided_by, decided_at, updated_at)
      VALUES (@module, @decision, @reason, @decided_by, datetime('now'), datetime('now'))
      ON CONFLICT(module) DO UPDATE SET
        decision = excluded.decision,
        reason = excluded.reason,
        decided_by = excluded.decided_by,
        updated_at = datetime('now')
    `).run({
      module,
      decision: opts.decision,
      reason: opts.reason.trim(),
      decided_by: opts.decidedBy.trim(),
    });

    const skippedArtifactIds: string[] = [];
    const inFlightArtifactIds: string[] = [];
    let crossModuleWarnings: Array<{ module: string; edge_count: number }> = [];

    if (opts.decision === "drop") {
      const rows = db.prepare(`
        SELECT id, status FROM artifacts WHERE module = ?
      `).all(module) as Array<{ id: string; status: string }>;

      for (const row of rows) {
        if ((PRE_MIGRATION_STATUSES as readonly string[]).includes(row.status)) {
          setArtifactStatus(db, row.id, "skipped", {
            agent: opts.decidedBy.trim(),
            reason: `Module "${module}" dropped from scope: ${opts.reason.trim()}`,
          });
          skippedArtifactIds.push(row.id);
        } else {
          inFlightArtifactIds.push(row.id);
        }
      }

      const summary = getModuleScopeSummary(db).find((m) => m.module === module);
      crossModuleWarnings = summary?.depended_on_by ?? [];
    }

    return {
      decision: db.prepare("SELECT * FROM scope_decisions WHERE module = ?").get(module) as ScopeDecision,
      skippedArtifactIds,
      inFlightArtifactIds,
      crossModuleWarnings,
    };
  })();

  return result;
}

export function listScopeDecisions(db: Database.Database): ScopeDecision[] {
  return db.prepare("SELECT * FROM scope_decisions ORDER BY module").all() as ScopeDecision[];
}
