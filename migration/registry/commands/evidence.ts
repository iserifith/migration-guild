import type Database from "better-sqlite3";
import { RegistryError, validateId } from "../types";
import type {
  AcceptanceEvidence,
  ArbitrationDecision,
  ArbitrationDecisionValue,
  Artifact,
  EvidenceType,
} from "../types";
import { setArtifactStatus } from "./artifacts";
import { appendEvent } from "./events";

export interface AddAcceptanceEvidenceOptions {
  artifactId: string;
  runId?: string | null;
  producedBy: string;
  evidenceType: EvidenceType;
  command?: string | null;
  exitCode?: number | null;
  pass: 0 | 1;
  summary: string;
  outputPath?: string | null;
  outputExcerpt?: string | null;
}

export interface RecordArbitrationDecisionOptions {
  artifactId: string;
  arbiter: string;
  decision: ArbitrationDecisionValue;
  reason: string;
  evidenceIds: string[];
}

export interface CanApproveArtifactResult {
  ok: boolean;
  evidenceIds: string[];
  reason: string;
}

export interface ApproveArtifactWithEvidenceOptions {
  artifactId: string;
  arbiter: string;
  reason: string;
  evidenceIds?: string[];
}

export interface RejectArtifactWithEvidenceOptions {
  artifactId: string;
  arbiter: string;
  reason: string;
  evidenceIds?: string[];
}

const EXECUTABLE_EVIDENCE_TYPES: readonly EvidenceType[] = [
  "test-command",
  "build-command",
  "static-check",
];

function assertArtifactExists(db: Database.Database, artifactId: string): void {
  validateId(artifactId);
  if (!db.prepare("SELECT id FROM artifacts WHERE id = ?").get(artifactId)) {
    throw new RegistryError(2, `Artifact not found: "${artifactId}"`);
  }
}

export function addAcceptanceEvidence(
  db: Database.Database,
  opts: AddAcceptanceEvidenceOptions,
): AcceptanceEvidence {
  assertArtifactExists(db, opts.artifactId);
  if (!opts.producedBy.trim()) {
    throw new RegistryError(1, "Evidence producer is required");
  }
  if (!opts.summary.trim()) {
    throw new RegistryError(1, "Evidence summary is required");
  }

  const result = db.prepare(
    `INSERT INTO acceptance_evidence (
       artifact_id,
       run_id,
       produced_by,
       evidence_type,
       command,
       exit_code,
       pass,
       summary,
       output_path,
       output_excerpt
     ) VALUES (
       @artifact_id,
       @run_id,
       @produced_by,
       @evidence_type,
       @command,
       @exit_code,
       @pass,
       @summary,
       @output_path,
       @output_excerpt
     )`,
  ).run({
    artifact_id: opts.artifactId,
    run_id: opts.runId ?? null,
    produced_by: opts.producedBy,
    evidence_type: opts.evidenceType,
    command: opts.command ?? null,
    exit_code: opts.exitCode ?? null,
    pass: opts.pass,
    summary: opts.summary,
    output_path: opts.outputPath ?? null,
    output_excerpt: opts.outputExcerpt ?? null,
  });

  return db.prepare("SELECT * FROM acceptance_evidence WHERE rowid = ?").get(result.lastInsertRowid) as AcceptanceEvidence;
}

export function listAcceptanceEvidence(
  db: Database.Database,
  artifactId: string,
): AcceptanceEvidence[] {
  assertArtifactExists(db, artifactId);
  return db.prepare(
    `SELECT *
     FROM acceptance_evidence
     WHERE artifact_id = ?
     ORDER BY created_at DESC, rowid DESC`,
  ).all(artifactId) as AcceptanceEvidence[];
}

export function recordArbitrationDecision(
  db: Database.Database,
  opts: RecordArbitrationDecisionOptions,
): ArbitrationDecision {
  assertArtifactExists(db, opts.artifactId);
  if (!opts.arbiter.trim()) {
    throw new RegistryError(1, "Arbiter is required");
  }
  if (!opts.reason.trim()) {
    throw new RegistryError(1, "Arbitration reason is required");
  }

  const result = db.prepare(
    `INSERT INTO arbitration_decisions (
       artifact_id,
       arbiter,
       decision,
       reason,
       evidence_ids
     ) VALUES (
       @artifact_id,
       @arbiter,
       @decision,
       @reason,
       @evidence_ids
     )`,
  ).run({
    artifact_id: opts.artifactId,
    arbiter: opts.arbiter,
    decision: opts.decision,
    reason: opts.reason,
    evidence_ids: JSON.stringify(opts.evidenceIds),
  });

  return db.prepare("SELECT * FROM arbitration_decisions WHERE rowid = ?").get(result.lastInsertRowid) as ArbitrationDecision;
}

export function getLatestArbitrationDecision(
  db: Database.Database,
  artifactId: string,
): ArbitrationDecision | null {
  assertArtifactExists(db, artifactId);
  const decision = db.prepare(
    `SELECT *
     FROM arbitration_decisions
     WHERE artifact_id = ?
     ORDER BY decided_at DESC, rowid DESC
     LIMIT 1`,
  ).get(artifactId) as ArbitrationDecision | undefined;
  return decision ?? null;
}

function getArtifact(db: Database.Database, artifactId: string): Artifact | null {
  validateId(artifactId);
  const artifact = db.prepare("SELECT * FROM artifacts WHERE id = ?").get(artifactId) as Artifact | undefined;
  return artifact ?? null;
}

function getLatestExecutableEvidence(
  db: Database.Database,
  artifactId: string,
): AcceptanceEvidence | null {
  const evidence = db.prepare(
    `SELECT *
     FROM acceptance_evidence
     WHERE artifact_id = @artifact_id
       AND evidence_type IN ('test-command', 'build-command', 'static-check')
     ORDER BY created_at DESC, rowid DESC
     LIMIT 1`,
  ).get({ artifact_id: artifactId }) as AcceptanceEvidence | undefined;
  return evidence ?? null;
}

function getEvidenceByIds(
  db: Database.Database,
  artifactId: string,
  evidenceIds: string[],
): AcceptanceEvidence[] {
  if (evidenceIds.length === 0) return [];
  const placeholders = evidenceIds.map((_, index) => `@id${index}`).join(", ");
  const params: Record<string, string> = { artifact_id: artifactId };
  evidenceIds.forEach((id, index) => {
    params[`id${index}`] = id;
  });
  return db.prepare(
    `SELECT *
     FROM acceptance_evidence
     WHERE artifact_id = @artifact_id
       AND evidence_id IN (${placeholders})`,
  ).all(params) as AcceptanceEvidence[];
}

function assertEvidenceIdsBelongToArtifact(
  db: Database.Database,
  artifactId: string,
  evidenceIds: string[],
): void {
  const uniqueEvidenceIds = [...new Set(evidenceIds)];
  const rows = getEvidenceByIds(db, artifactId, uniqueEvidenceIds);
  if (rows.length !== uniqueEvidenceIds.length) {
    throw new RegistryError(2, "One or more evidence records were not found for this artifact");
  }
}

function assertApprovalEvidenceIsIndependent(
  db: Database.Database,
  artifactId: string,
  evidenceIds: string[],
  arbiter: string,
): void {
  if (evidenceIds.length === 0) {
    throw new RegistryError(1, "Approval requires at least one evidence record");
  }
  const rows = getEvidenceByIds(db, artifactId, [...new Set(evidenceIds)]);
  if (rows.length !== new Set(evidenceIds).size) {
    throw new RegistryError(2, "One or more evidence records were not found for this artifact");
  }
  const invalid = rows.find((row) => !EXECUTABLE_EVIDENCE_TYPES.includes(row.evidence_type) || row.pass !== 1);
  if (invalid) {
    throw new RegistryError(1, "Approval evidence must be passing executable evidence");
  }
  const selfApproved = rows.find((row) => row.produced_by === arbiter);
  if (selfApproved) {
    throw new RegistryError(1, "Arbiter must be independent from the evidence producer");
  }
}

export function canApproveArtifact(
  db: Database.Database,
  artifactId: string,
  arbiter: string,
): CanApproveArtifactResult {
  const artifact = getArtifact(db, artifactId);
  if (!artifact) {
    return { ok: false, evidenceIds: [], reason: `Artifact not found: "${artifactId}"` };
  }
  if (artifact.status !== "migrated") {
    return {
      ok: false,
      evidenceIds: [],
      reason: `Artifact status must be migrated before arbitration approval; current status is ${artifact.status}.`,
    };
  }

  const latestEvidence = getLatestExecutableEvidence(db, artifactId);
  if (!latestEvidence) {
    return {
      ok: false,
      evidenceIds: [],
      reason: "Artifact has no passing executable evidence (test-command, build-command, or static-check).",
    };
  }
  if (latestEvidence.pass !== 1) {
    return {
      ok: false,
      evidenceIds: [latestEvidence.evidence_id],
      reason: "Latest executable evidence failed; arbitration approval requires the latest executable evidence to pass.",
    };
  }
  if (!EXECUTABLE_EVIDENCE_TYPES.includes(latestEvidence.evidence_type)) {
    return {
      ok: false,
      evidenceIds: [],
      reason: "Artifact has no passing executable evidence (test-command, build-command, or static-check).",
    };
  }
  if (latestEvidence.produced_by === arbiter) {
    return {
      ok: false,
      evidenceIds: [latestEvidence.evidence_id],
      reason: "Arbiter must be independent from the evidence producer.",
    };
  }

  return {
    ok: true,
    evidenceIds: [latestEvidence.evidence_id],
    reason: "Artifact has independent passing executable evidence.",
  };
}

export function approveArtifactWithEvidence(
  db: Database.Database,
  opts: ApproveArtifactWithEvidenceOptions,
): ArbitrationDecision {
  const tx = db.transaction(() => {
    const approval = canApproveArtifact(db, opts.artifactId, opts.arbiter);
    if (!approval.ok) {
      throw new RegistryError(1, approval.reason);
    }
    const evidenceIds = opts.evidenceIds ?? approval.evidenceIds;
    assertApprovalEvidenceIsIndependent(db, opts.artifactId, evidenceIds, opts.arbiter);

    const decision = recordArbitrationDecision(db, {
      artifactId: opts.artifactId,
      arbiter: opts.arbiter,
      decision: "approved",
      reason: opts.reason,
      evidenceIds,
    });
    appendEvent(db, {
      id: opts.artifactId,
      type: "arbitration-approved",
      agent: opts.arbiter,
      summary: `Arbiter approved artifact: ${opts.reason}`,
      data: JSON.stringify({
        role: "arbiter",
        decision_id: decision.decision_id,
        evidence_ids: evidenceIds,
        target_status: "reviewed",
      }),
    });
    setArtifactStatus(db, opts.artifactId, "reviewed");
    return decision;
  });

  return tx();
}

export function rejectArtifactWithEvidence(
  db: Database.Database,
  opts: RejectArtifactWithEvidenceOptions,
): ArbitrationDecision {
  const tx = db.transaction(() => {
    assertArtifactExists(db, opts.artifactId);
    const evidenceIds = opts.evidenceIds ?? [];
    assertEvidenceIdsBelongToArtifact(db, opts.artifactId, evidenceIds);

    const decision = recordArbitrationDecision(db, {
      artifactId: opts.artifactId,
      arbiter: opts.arbiter,
      decision: "rejected",
      reason: opts.reason,
      evidenceIds,
    });
    appendEvent(db, {
      id: opts.artifactId,
      type: "arbitration-rejected",
      agent: opts.arbiter,
      summary: `Arbiter rejected artifact: ${opts.reason}`,
      data: JSON.stringify({
        role: "arbiter",
        decision_id: decision.decision_id,
        evidence_ids: evidenceIds,
        target_status: "needs-rework",
      }),
    });
    setArtifactStatus(db, opts.artifactId, "needs-rework");
    return decision;
  });

  return tx();
}
