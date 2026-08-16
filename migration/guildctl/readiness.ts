import type Database from "better-sqlite3";
import {
  listDependencyFindings,
  listJvmAuditFindings,
} from "../registry/commands/modernization";
import type { DependencyFindingWithStrategy } from "../registry/commands/modernization";
import { listDispositions } from "../registry/commands/dispositions";
import { getUndecidedModules } from "../registry/commands/scope";
import type { ModuleScopeSummary } from "../registry/commands/scope";
import type { DependencyDisposition, JvmAuditFinding } from "../registry/types";

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
  // ISSUE-68: modules with first-class artifacts and no recorded keep/drop
  // scope decision. Planning is blocked until every module has one.
  unresolvedScopeModules: ModuleScopeSummary[];
  // ISSUE-61 US2: disposition rows awaiting confirmation — status='proposed'
  // OR a confirmed row carrying a pending re-proposal (FR-006/FR-007).
  unconfirmedDispositions: DependencyDisposition[];
}

function summarizeArtifacts(findings: Array<{ artifact_id: string }>): string {
  return [...new Set(findings.map((finding) => finding.artifact_id))].slice(0, 3).join(", ");
}

export function evaluatePlanningReadiness(db: Database.Database): PlanningReadiness {
  const allJvm = listJvmAuditFindings(db);
  const jvm = allJvm.filter((finding) => finding.dismissed_at == null);
  const blockingJvmFindings = jvm.filter((finding) => finding.severity === "critical");
  const warningJvmFindings = jvm.filter((finding) => finding.severity === "warning");
  const dependencyFindings = listDependencyFindings(db);
  const openDependencies = dependencyFindings.filter((finding) => finding.dismissed_at == null);
  // ISSUE-61: a finding whose library carries a confirmed non-keep disposition
  // counts as resolved — the disposition IS the resolution (the library will
  // not be carried into the target). Kept libraries' findings still require
  // approved strategies exactly as today.
  const dispositionResolved = new Set(
    (db.prepare(`
      SELECT f.finding_id
      FROM dependency_findings f
      WHERE NOT EXISTS (
        SELECT 1 FROM dependency_dispositions d
        WHERE d.library_name = f.dependency_name
          AND d.status = 'confirmed'
          AND d.disposition != 'keep'
      )
    `).all() as Array<{ finding_id: string }>).map((row) => row.finding_id),
  );
  const dispositions = listDispositions(db);
  return {
    blockingJvmFindings,
    warningJvmFindings,
    unresolvedDependencyFindings: openDependencies.filter(
      (finding) => finding.strategy == null && dispositionResolved.has(finding.finding_id),
    ),
    approvedDependencyFindings: openDependencies.filter((finding) => finding.strategy != null),
    unresolvedScopeModules: getUndecidedModules(db),
    unconfirmedDispositions: dispositions.filter(
      (row) => row.status === "proposed" || row.pending_disposition != null,
    ),
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
  if (readiness.unresolvedScopeModules.length > 0) {
    const modules = readiness.unresolvedScopeModules.map((m) => m.module).slice(0, 5).join(", ");
    return {
      summary: "Planning blocked by undecided module scope.",
      reason: `${readiness.unresolvedScopeModules.length} module(s) have no keep/drop scope decision yet${modules ? ` (${modules}${readiness.unresolvedScopeModules.length > 5 ? ", …" : ""})` : ""}. Every module needs a decision before planning proceeds.`,
      command: "node migration/guildctl/dist/cli.js scope",
    };
  }

  if (readiness.blockingJvmFindings.length > 0) {
    const sampleArtifacts = summarizeArtifacts(readiness.blockingJvmFindings);
    return {
      summary: "Planning blocked by critical compatibility findings.",
      reason: `${readiness.blockingJvmFindings.length} critical finding(s) remain open${sampleArtifacts ? ` across ${sampleArtifacts}` : ""}. These block planning until resolved, dismissed, or overridden.`,
      command: "node migration/registry/dist/cli.js findings list --severity critical\n  # Acknowledge (no delete): node migration/registry/dist/cli.js findings dismiss --id <finding_id> --reason \"<text>\"\n  # Or sanctioned bypass:        node migration/guildctl/dist/cli.js plan --override-audit",
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

  // ISSUE-61 US2: disposition branch is evaluated AFTER scope → JVM →
  // dependency — those remain the most fundamental blockers (contracts/
  // registry-schema.md "Readiness integration").
  if (readiness.unconfirmedDispositions.length > 0) {
    const sample = readiness.unconfirmedDispositions.map((row) => row.library_name).slice(0, 5).join(", ");
    const count = readiness.unconfirmedDispositions.length;
    return {
      summary: "Planning blocked by unconfirmed dependency dispositions.",
      reason: `${count} librar${count === 1 ? "y" : "ies"} lack a confirmed keep / replace-with-native / inline disposition (${sample}${count > 5 ? ", …" : ""}). Every in-scope library needs a confirmed disposition before planning sign-off.`,
      command: "node migration/dist/registry/cli.js list-dispositions --status proposed",
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
