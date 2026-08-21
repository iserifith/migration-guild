/**
 * Reusable fixture helpers for the approval-gate suites (spec 013).
 *
 * Deliberately NOT named `*.test.ts`: the runtime suite glob is
 * `test/*.test.ts` (see migration/package.json), and this file exports helpers
 * rather than tests.
 *
 * Each factory builds an in-memory registry seeded with:
 *  (a) an above-cutoff HIGH-risk artifact — `artifact_risk_assessments.high_risk = 1`
 *      because its scoreArtifact risk score exceeds the stack pack's
 *      high_risk_score_cutoff (default 50 — see guildctl/risk.ts), and
 *  (b) a below-cutoff LOW-risk artifact — same valid signed runtime evidence,
 *      `high_risk = 0`,
 * both seeded through the real registerArtifact → applyRiskAssessment →
 * addVerifierRuntimeEvidence pipeline with signRuntimeEvidence /
 * createRunOperatorCredential HMAC credentials, mirroring the pattern in
 * arbitrate-manual-approval.test.ts. Imported by the downstream approval-gate
 * test files (T003/T012).
 */
import Database from "better-sqlite3";
import { applySchema } from "../registry/db/schema";
import { registerArtifact } from "../registry/commands/artifacts";
import {
  addVerifierRuntimeEvidence,
  recordArbitrationDecision,
} from "../registry/commands/evidence";
import { createRunOperatorCredential } from "../registry/commands/claim";
import {
  applyRiskAssessment,
  resolveRiskSpec,
  scoreArtifact,
  type RiskAssessmentRecord,
} from "../guildctl/risk";
import { sha256, signRuntimeEvidence } from "../guildctl/verify";

/**
 * The built-in high-risk cutoff from guildctl/risk.ts (0-100 score scale) —
 * scores strictly above it persist `high_risk = 1` and fall in the approval
 * gate's scope.
 */
export const APPROVAL_GATE_CUTOFF = resolveRiskSpec(undefined).highRiskScoreCutoff;

export const HIGH_RISK_ARTIFACT_ID = "legacy-source:com.acme.high:HighRiskThing";
export const LOW_RISK_ARTIFACT_ID = "legacy-source:com.acme.low:LowRiskThing";

/** The verifier command recorded on all seeded runtime evidence rows. */
export const FIXTURE_VERIFY_COMMAND = "npx vitest run";

/**
 * Source-text profile engineered to score above the default cutoff: a
 * reflective Class.forName call (30 pts) plus a god-method far over the
 * 80-line limit and cyclomatic complexity far over the limit of 15 (the two
 * overage terms cap at 35 pts each) — the same signal mix as
 * risk-scanner.test.ts's worst-case fixture.
 */
const HIGH_RISK_SOURCE_TEXT = [
  "public class HighRiskThing {",
  "  public void migrate(Object entity) {",
  "    Class.forName(\"com.acme.legacy.Handler\");",
  ...Array.from({ length: 200 }, () => "    if (flag) { doWork(); }"),
  "  }",
  "}",
].join("\n");

/** Source-text profile with no risky signals — scores 0, well below cutoff. */
const LOW_RISK_SOURCE_TEXT = [
  "public class LowRiskThing {",
  "  public int add(int a, int b) { return a + b; }",
  "}",
].join("\n");

export interface SignedEvidenceInput {
  artifactId: string;
  runId: string;
  operatorToken: string;
  /** Command string recorded on the evidence row. Default: FIXTURE_VERIFY_COMMAND. */
  command?: string;
  /** Log content — hashed into log_sha256. Default: "ok". */
  logContent?: string;
  exitCode?: number;
  pass?: 0 | 1;
}

/**
 * Build the exact `{ authenticity, signatureJson }` pair that
 * addVerifierRuntimeEvidence's HMAC verifier accepts, signed with the given
 * run-scoped operator token. Mirrors the signed-evidence pattern in
 * arbitrate-manual-approval.test.ts ("operator token minted for the run...").
 */
export function makeSignedEvidence(input: SignedEvidenceInput): {
  authenticity: string;
  signatureJson: string;
  logSha256: string;
} {
  const command = input.command ?? FIXTURE_VERIFY_COMMAND;
  const exitCode = input.exitCode ?? 0;
  const pass = input.pass ?? 1;
  const logSha256 = sha256(input.logContent ?? "ok");
  const authenticity = JSON.stringify({
    artifact_id: input.artifactId,
    run_id: input.runId,
    command,
    exit_code: exitCode,
    pass,
    log_sha256: logSha256,
  });
  const signatureJson = signRuntimeEvidence(
    {
      artifactId: input.artifactId,
      runId: input.runId,
      command,
      exitCode,
      pass,
      logSha256,
    },
    input.operatorToken,
  );
  return { authenticity, signatureJson, logSha256 };
}

export interface ApprovalGateDb {
  db: Database.Database;
  runId: string;
  /** Run-scoped operator token — passes operator_token_hash verification. */
  operatorToken: string;
}

/**
 * Fresh in-memory registry with the schema applied and one `runs` row plus a
 * run-scoped operator credential minted, matching the seeded DB shape used by
 * the arbitrate-manual-approval tests.
 */
export function createApprovalGateDb(runId = "run-approval-gate"): ApprovalGateDb {
  const db = new Database(":memory:");
  applySchema(db);
  db.prepare("INSERT INTO runs (run_id, inputs_json) VALUES (?, '{}')").run(runId);
  const { token: operatorToken } = createRunOperatorCredential(db, runId);
  return { db, runId, operatorToken };
}

export interface SeedArtifactOptions {
  /** Override the seeded artifact id. Default: HIGH_RISK_ARTIFACT_ID / LOW_RISK_ARTIFACT_ID. */
  artifactId?: string;
  /** Lifecycle status to seed at. Default: "migrated" (the status the gate intercepts from). */
  status?: string;
  /** Override the source text fed to scoreArtifact (advanced cases). */
  sourceText?: string;
}

function seedArtifact(gate: ApprovalGateDb, opts: SeedArtifactOptions, defaultId: string, defaultSource: string): string {
  const artifactId = opts.artifactId ?? defaultId;
  registerArtifact(gate.db, {
    id: artifactId,
    kind: "legacy-source",
    path: `legacy/src/main/java/${artifactId.split(":").pop()}.java`,
  });
  const status = opts.status ?? "migrated";
  if (status !== "pending") {
    gate.db.prepare("UPDATE artifacts SET status = ? WHERE id = ?").run(status, artifactId);
  }
  const record: RiskAssessmentRecord = scoreArtifact(
    artifactId,
    opts.sourceText ?? defaultSource,
    resolveRiskSpec(undefined),
  );
  applyRiskAssessment(gate.db, record);
  const { authenticity, signatureJson, logSha256 } = makeSignedEvidence({
    artifactId,
    runId: gate.runId,
    operatorToken: gate.operatorToken,
  });
  addVerifierRuntimeEvidence(gate.db, {
    artifactId,
    command: FIXTURE_VERIFY_COMMAND,
    exitCode: 0,
    pass: 1,
    summary: "runtime verifier passed",
    logSha256,
    durationMs: 500,
    authenticity,
    signatureJson,
  });
  return artifactId;
}

/**
 * Seed an above-cutoff high-risk artifact carrying valid signed runtime
 * evidence. After this call `artifact_risk_assessments.high_risk` is 1 for the
 * artifact, so an approving arbiter verdict must gate instead of completing
 * the `migrated → reviewed` transition.
 */
export function seedHighRiskArtifact(gate: ApprovalGateDb, opts: SeedArtifactOptions = {}): string {
  return seedArtifact(gate, opts, HIGH_RISK_ARTIFACT_ID, HIGH_RISK_SOURCE_TEXT);
}

/**
 * Seed a below-cutoff low-risk artifact carrying the same valid signed runtime
 * evidence. After this call `artifact_risk_assessments.high_risk` is 0, so the
 * gate must let the `migrated → reviewed` transition proceed unchanged.
 */
export function seedLowRiskArtifact(gate: ApprovalGateDb, opts: SeedArtifactOptions = {}): string {
  return seedArtifact(gate, opts, LOW_RISK_ARTIFACT_ID, LOW_RISK_SOURCE_TEXT);
}

export interface SeedApprovingDecisionOptions {
  /** Arbiter identity recorded on the row. Default: "arbiter-agent". */
  arbiter?: string;
  reason?: string;
  /** Defaults to every evidence row evidence_id currently stored for the artifact. */
  evidenceIds?: string[];
}

/**
 * Record an approving arbitration_decisions row for a seeded artifact — the
 * "passed automated review" state the approval gate diverts on. The `arbiter`
 * identity matters: per research.md §1 that same identity must NOT be allowed
 * to record the subsequent human decision.
 */
export function seedApprovingArbitrationDecision(
  db: Database.Database,
  artifactId: string,
  opts: SeedApprovingDecisionOptions = {},
): void {
  const evidenceIds =
    opts.evidenceIds ??
    (db
      .prepare("SELECT evidence_id FROM acceptance_evidence WHERE artifact_id = ? ORDER BY created_at, evidence_id")
      .all(artifactId) as Array<{ evidence_id: string }>).map((row) => row.evidence_id);
  recordArbitrationDecision(db, {
    artifactId,
    arbiter: opts.arbiter ?? "arbiter-agent",
    decision: "approved",
    reason: opts.reason ?? "Automated review passed on signed runtime evidence.",
    evidenceIds,
  });
}

/** Read back the seeded risk row — handy for asserting the fixture itself. */
export function getRiskRow(
  db: Database.Database,
  artifactId: string,
): { artifact_id: string; risk_score: number; high_risk: number; reason_codes_json: string } | undefined {
  return db
    .prepare(
      "SELECT artifact_id, risk_score, high_risk, reason_codes_json FROM artifact_risk_assessments WHERE artifact_id = ?",
    )
    .get(artifactId) as
    | { artifact_id: string; risk_score: number; high_risk: number; reason_codes_json: string }
    | undefined;
}
