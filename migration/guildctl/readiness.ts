import type Database from "better-sqlite3";
import {
  listDependencyFindings,
  listJvmAuditFindings,
} from "../registry/commands/modernization";
import type { DependencyFindingWithStrategy } from "../registry/commands/modernization";
import type { JvmAuditFinding } from "../registry/types";

// TASK-03: downstream phases must fast-fail (no agent spawn) on an empty registry.
export class EmptyRegistryError extends Error {
  constructor(phase: string) {
    super(`Cannot run ${phase}: the registry has 0 artifacts. Run 'guildctl run inventory' first.`);
    this.name = "EmptyRegistryError";
  }
}

export function requireNonEmptyRegistry(db: Database.Database, phase: string): void {
  const count = (db.prepare("SELECT COUNT(*) AS n FROM artifacts").get() as { n: number }).n;
  if (count === 0) throw new EmptyRegistryError(phase);
}

export interface PlanningReadiness {
  blockingJvmFindings: JvmAuditFinding[];
  warningJvmFindings: JvmAuditFinding[];
  unresolvedDependencyFindings: DependencyFindingWithStrategy[];
  approvedDependencyFindings: DependencyFindingWithStrategy[];
}

function summarizeArtifacts(findings: Array<{ artifact_id: string }>): string {
  return [...new Set(findings.map((finding) => finding.artifact_id))].slice(0, 3).join(", ");
}

export function evaluatePlanningReadiness(db: Database.Database): PlanningReadiness {
  const blockingJvmFindings = listJvmAuditFindings(db, { severity: "critical" });
  const warningJvmFindings = listJvmAuditFindings(db, { severity: "warning" });
  const dependencyFindings = listDependencyFindings(db);
  return {
    blockingJvmFindings,
    warningJvmFindings,
    unresolvedDependencyFindings: dependencyFindings.filter((finding) => finding.strategy == null),
    approvedDependencyFindings: dependencyFindings.filter((finding) => finding.strategy != null),
  };
}

export function evaluateMigrationReadiness(
  db: Database.Database,
  wave?: number,
): Pick<PlanningReadiness, "unresolvedDependencyFindings"> {
  const params = wave != null ? { wave } : {};
  const rows = db.prepare(`
    SELECT f.finding_id
    FROM dependency_findings f
    JOIN artifacts a ON a.id = f.artifact_id
    LEFT JOIN dependency_strategies s ON s.finding_id = f.finding_id
    WHERE a.tier = 'first-class'
      AND a.status IN ('planned', 'analyzed', 'tests-written', 'in-progress')
      ${wave != null ? "AND a.wave = @wave" : ""}
      AND s.finding_id IS NULL
  `).all(params) as Array<{ finding_id: string }>;

  const unresolvedIds = new Set(rows.map((row) => row.finding_id));
  return {
    unresolvedDependencyFindings: listDependencyFindings(db).filter((finding) => unresolvedIds.has(finding.finding_id)),
  };
}

export function formatPlanningBlockMessage(readiness: PlanningReadiness): {
  summary: string;
  reason: string;
  command: string;
} | null {
  if (readiness.blockingJvmFindings.length > 0) {
    const sampleArtifacts = summarizeArtifacts(readiness.blockingJvmFindings);
    return {
      summary: "Planning blocked by critical JVM compatibility findings.",
      reason: `${readiness.blockingJvmFindings.length} critical JVM finding(s) remain open${sampleArtifacts ? ` across ${sampleArtifacts}` : ""}. Resolve removed/internal API usage or downgrade the risk by changing the source before rerunning planning.`,
      command: "node migration/registry/dist/cli.js list-jvm-findings --severity critical",
    };
  }

  if (readiness.unresolvedDependencyFindings.length > 0) {
    const sampleArtifacts = summarizeArtifacts(readiness.unresolvedDependencyFindings);
    return {
      summary: "Planning blocked by unresolved dependency modernization strategies.",
      reason: `${readiness.unresolvedDependencyFindings.length} risky dependency finding(s) still need an approved upgrade or replacement strategy${sampleArtifacts ? ` across ${sampleArtifacts}` : ""}.`,
      command: "node migration/registry/dist/cli.js list-dependency-findings --unresolved-only",
    };
  }

  return null;
}

export function formatMigrationBlockMessage(
  findings: DependencyFindingWithStrategy[],
): string | null {
  if (findings.length === 0) return null;
  const sampleArtifacts = summarizeArtifacts(findings);
  return `Dependency modernization gate blocked migration: ${findings.length} finding(s) still need approved upgrade or replacement strategies${sampleArtifacts ? ` (${sampleArtifacts})` : ""}. Run \`node migration/registry/dist/cli.js list-dependency-findings --unresolved-only\` and approve each strategy before retrying.`;
}
