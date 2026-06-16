import type Database from "better-sqlite3";
import { RegistryError, validateId } from "../types";
import type {
  AcceptanceEvidence,
  ArbitrationDecision,
  ArbitrationDecisionValue,
  EvidenceType,
} from "../types";

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
