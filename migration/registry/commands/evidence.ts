import type Database from "better-sqlite3";
import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import { signRuntimeEvidence } from "../../guildctl/verify";
import { RegistryError, validateId } from "../types";
import type {
  AcceptanceEvidence,
  ApprovedCompanionOutput,
  ArbitrationDecision,
  ArbitrationDecisionValue,
  Artifact,
  EvidenceType,
} from "../types";
import { setArtifactStatus } from "./artifacts";
import { validateRunOperatorCredential } from "./claim";
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
  logSha256?: string | null;
  durationMs?: number | null;
  authenticity?: string | null;
  contentSha256?: string | null;
  signatureJson?: string | null;
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
  runId?: string | null;
  operatorToken?: string | null;
}

export interface RejectArtifactWithEvidenceOptions {
  artifactId: string;
  arbiter: string;
  reason: string;
  evidenceIds?: string[];
}

const EXECUTABLE_EVIDENCE_TYPES: readonly EvidenceType[] = [
  "runtime",
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
  if (opts.evidenceType === "runtime") {
    throw new RegistryError(3, "runtime evidence must be recorded by guildctl verify");
  }
  return insertAcceptanceEvidence(db, opts);
}

function insertAcceptanceEvidence(
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
       output_excerpt,
       log_sha256,
       duration_ms,
       authenticity,
       content_sha256,
       signature_json
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
       @output_excerpt,
       @log_sha256,
       @duration_ms,
       @authenticity,
       @content_sha256,
       @signature_json
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
    log_sha256: opts.logSha256 ?? null,
    duration_ms: opts.durationMs ?? null,
    authenticity: opts.authenticity ?? null,
    content_sha256: opts.contentSha256 ?? null,
    signature_json: opts.signatureJson ?? null,
  });

  return db.prepare("SELECT * FROM acceptance_evidence WHERE rowid = ?").get(result.lastInsertRowid) as AcceptanceEvidence;
}

export function addVerifierRuntimeEvidence(
  db: Database.Database,
  opts: Omit<AddAcceptanceEvidenceOptions, "evidenceType" | "producedBy"> & {
    producedBy?: string;
    logSha256: string;
    durationMs: number;
    authenticity: string;
  },
): AcceptanceEvidence {
  if (!opts.logSha256.match(/^[a-f0-9]{64}$/)) {
    throw new RegistryError(1, "Runtime evidence requires a SHA-256 log digest");
  }
  if (!opts.authenticity.trim()) {
    throw new RegistryError(1, "Runtime evidence requires verifier authenticity data");
  }
  return insertAcceptanceEvidence(db, {
    artifactId: opts.artifactId,
    runId: opts.runId,
    command: opts.command,
    exitCode: opts.exitCode,
    pass: opts.pass,
    summary: opts.summary,
    outputPath: opts.outputPath,
    outputExcerpt: opts.outputExcerpt,
    logSha256: opts.logSha256,
    durationMs: opts.durationMs,
    authenticity: opts.authenticity,
    evidenceType: "runtime",
    producedBy: opts.producedBy ?? "guildctl-verify",
  });
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
       AND evidence_type = 'runtime'
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
  runId: string | null | undefined,
  operatorToken: string | null | undefined,
): void {
  if (evidenceIds.length === 0) {
    throw new RegistryError(1, "Approval requires at least one evidence record");
  }
  const rows = getEvidenceByIds(db, artifactId, [...new Set(evidenceIds)]);
  if (rows.length !== new Set(evidenceIds).size) {
    throw new RegistryError(2, "One or more evidence records were not found for this artifact");
  }
  const invalid = rows.find((row) =>
    !EXECUTABLE_EVIDENCE_TYPES.includes(row.evidence_type) ||
    row.pass !== 1 ||
    !row.authenticity ||
    !row.log_sha256
  );
  if (invalid) {
    throw new RegistryError(1, "Approval evidence must be passing verifier-generated runtime evidence");
  }
  const selfApproved = rows.find((row) => row.produced_by === arbiter);
  if (selfApproved) {
    throw new RegistryError(1, "Arbiter must be independent from the evidence producer");
  }
  for (const row of rows) {
    const validation = validateRuntimeEvidence(db, row, runId, operatorToken);
    if (!validation.ok) {
      throw new RegistryError(1, validation.reason);
    }
  }
}

export function canApproveArtifact(
  db: Database.Database,
  artifactId: string,
  arbiter: string,
  opts: { runId?: string | null; operatorToken?: string | null } = {},
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
    reason: "Artifact has no verifier-generated runtime evidence.",
    };
  }
  if (latestEvidence.pass !== 1) {
    return {
      ok: false,
      evidenceIds: [latestEvidence.evidence_id],
      reason: "latest runtime evidence failed; arbitration approval requires the latest verifier evidence to pass.",
    };
  }
  if (!EXECUTABLE_EVIDENCE_TYPES.includes(latestEvidence.evidence_type)) {
    return {
      ok: false,
      evidenceIds: [],
    reason: "Artifact has no verifier-generated runtime evidence.",
    };
  }
  if (!latestEvidence.authenticity || !latestEvidence.log_sha256) {
    return {
      ok: false,
      evidenceIds: [latestEvidence.evidence_id],
      reason: "Runtime evidence is missing verifier authenticity data.",
    };
  }
  if (latestEvidence.produced_by === arbiter) {
    return {
      ok: false,
      evidenceIds: [latestEvidence.evidence_id],
      reason: "Arbiter must be independent from the evidence producer.",
    };
  }
  const validation = validateRuntimeEvidence(db, latestEvidence, opts.runId, opts.operatorToken);
  if (!validation.ok) {
    return {
      ok: false,
      evidenceIds: [latestEvidence.evidence_id],
      reason: validation.reason,
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
    const approval = canApproveArtifact(db, opts.artifactId, opts.arbiter, {
      runId: opts.runId,
      operatorToken: opts.operatorToken,
    });
    if (!approval.ok) {
      throw new RegistryError(1, approval.reason);
    }
    const evidenceIds = opts.evidenceIds ?? approval.evidenceIds;
    assertApprovalEvidenceIsIndependent(db, opts.artifactId, evidenceIds, opts.arbiter, opts.runId, opts.operatorToken);

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

function sha256File(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function validateRuntimeEvidence(
  db: Database.Database,
  row: AcceptanceEvidence,
  runId: string | null | undefined,
  operatorToken: string | null | undefined,
): { ok: true } | { ok: false; reason: string } {
  if (row.evidence_type !== "runtime") return { ok: false, reason: "Approval evidence must be runtime evidence." };
  if (!row.run_id) return { ok: false, reason: "Runtime evidence is missing run binding." };
  if (runId && runId !== row.run_id) return { ok: false, reason: "Approval run credential does not match runtime evidence." };
  if (!validateRunOperatorCredential(db, row.run_id, operatorToken)) {
    return { ok: false, reason: "Approval requires a valid run operator credential." };
  }
  if (!row.command || row.exit_code == null || !row.log_sha256 || !row.authenticity) {
    return { ok: false, reason: "Runtime evidence is missing verifier authenticity data." };
  }
  if (!row.output_path || !fs.existsSync(row.output_path)) {
    return { ok: false, reason: "Runtime evidence log is missing." };
  }
  const actualLogSha = sha256File(row.output_path);
  if (!safeEqual(actualLogSha, row.log_sha256)) {
    return { ok: false, reason: "Runtime evidence log digest does not match output_path." };
  }
  const expected = signRuntimeEvidence({
    artifactId: row.artifact_id,
    runId: row.run_id,
    command: row.command,
    exitCode: row.exit_code,
    pass: row.pass,
    logSha256: row.log_sha256,
  }, operatorToken ?? "");
  if (!safeEqual(expected, row.authenticity)) {
    return { ok: false, reason: "Runtime evidence authenticity check failed." };
  }
  return { ok: true };
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

// ─── Approved Companion Outputs ──────────────────────────────────────────────

export interface AddCompanionOutputOptions {
  artifactId: string;
  outputPath: string;
  contentSha256: string;
  signatureJson?: string | null;
  approvedBy: string;
}

export function addApprovedCompanionOutput(
  db: Database.Database,
  opts: AddCompanionOutputOptions,
): ApprovedCompanionOutput {
  assertArtifactExists(db, opts.artifactId);
  if (!opts.outputPath.trim()) {
    throw new RegistryError(1, "Companion output path is required");
  }
  if (!opts.contentSha256.match(/^[a-f0-9]{64}$/)) {
    throw new RegistryError(1, "Companion output requires a SHA-256 content digest");
  }
  if (!opts.approvedBy.trim()) {
    throw new RegistryError(1, "Companion output approver is required");
  }

  const result = db.prepare(
    `INSERT INTO approved_companion_outputs (
       artifact_id,
       output_path,
       content_sha256,
       signature_json,
       approved_by
     ) VALUES (
       @artifact_id,
       @output_path,
       @content_sha256,
       @signature_json,
       @approved_by
     )
     ON CONFLICT(artifact_id, output_path) DO UPDATE SET
       content_sha256 = excluded.content_sha256,
       signature_json = excluded.signature_json,
       approved_by = excluded.approved_by,
       approved_at = datetime('now')`,
  ).run({
    artifact_id: opts.artifactId,
    output_path: opts.outputPath,
    content_sha256: opts.contentSha256,
    signature_json: opts.signatureJson ?? null,
    approved_by: opts.approvedBy,
  });

  return db.prepare(
    "SELECT * FROM approved_companion_outputs WHERE artifact_id = ? AND output_path = ?",
  ).get(opts.artifactId, opts.outputPath) as ApprovedCompanionOutput;
}

export function listApprovedCompanionOutputs(
  db: Database.Database,
  artifactId: string,
): ApprovedCompanionOutput[] {
  assertArtifactExists(db, artifactId);
  return db.prepare(
    `SELECT * FROM approved_companion_outputs
     WHERE artifact_id = ?
     ORDER BY rowid DESC`,
  ).all(artifactId) as ApprovedCompanionOutput[];
}

export function getApprovedCompanionOutput(
  db: Database.Database,
  artifactId: string,
  outputPath: string,
): ApprovedCompanionOutput | null {
  return db.prepare(
    "SELECT * FROM approved_companion_outputs WHERE artifact_id = ? AND output_path = ?",
  ).get(artifactId, outputPath) as ApprovedCompanionOutput | undefined ?? null;
}
