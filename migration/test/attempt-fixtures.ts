/**
 * Reusable fixture helpers for the attempt-scoped retry-history suites
 * (spec 013, US3 — downstream test file T017 imports this).
 *
 * Deliberately NOT named `*.test.ts`: the runtime suite glob is
 * `test/*.test.ts` (see migration/package.json), and this file exports helpers
 * rather than tests.
 *
 * The factory builds an in-memory registry with one artifact at `migrated`
 * status plus a `runs` row and a released `artifact_claims` row (so the
 * "attempt that produced the failure" is attributable, per
 * data-model.md §3's invariant). On top of that it provides:
 *  - `seedAttemptRecord(db, opts)`   — write one attempt_records row directly,
 *    since recordAttemptOutcome() only lands with T019;
 *  - `getAttemptHistory(db, id)`     — read attempt_records ordered by
 *    attempt_no, the shape FR-010's history view is backed by;
 *  - `resumedBudgetFor(db, id)`      — simulate process restart: a FRESH
 *    FailureBudget instance against the same DB (per data-model.md §3, budget
 *    state must be re-seedable from durable attempt_records + events state,
 *    never held only in process memory).
 */
import Database from "better-sqlite3";
import { applySchema } from "../registry/db/schema";
import { registerArtifact } from "../registry/commands/artifacts";
import { FailureBudget, type FailureKind } from "../guildctl/supervisor/failures";

export const ATTEMPT_ARTIFACT_ID = "legacy-source:com.acme.attempt:AttemptThing";

/** FailureKind values valid in attempt_records.failure_kind per data-model.md §3. */
export const ATTEMPT_FAILURE_KINDS: FailureKind[] = [
  "build-failure",
  "test-failure",
  "agent-timeout",
  "review-rejection",
  "filesystem-violation",
  "claim-violation",
  "stack-mismatch",
  "pack-defect",
  "provider-error",
  "unknown",
];

/** attempt_records.outcome values per data-model.md §3. */
export type AttemptOutcome = "succeeded" | "failed" | "budget-exhausted";

export interface AttemptFixtureDb {
  db: Database.Database;
  runId: string;
  artifactId: string;
  /** The released claim id seeded alongside the artifact (attempt attribution). */
  claimId: string;
}

export interface CreateAttemptFixtureOptions {
  artifactId?: string;
  runId?: string;
  /** Lifecycle status to seed at. Default: "migrated". */
  status?: string;
  /** attempt_no recorded on the seeded claim row. Default: 1. */
  claimAttemptNo?: number;
  /** When false, skip the released artifact_claims row. Default: true. */
  withClaim?: boolean;
}

/**
 * Fresh in-memory registry with the schema applied, one migrated artifact, a
 * `runs` row, and (by default) a released `artifact_claims` row so seeded
 * attempt records can reference the claim that produced them.
 */
export function createAttemptFixtureDb(opts: CreateAttemptFixtureOptions = {}): AttemptFixtureDb {
  const db = new Database(":memory:");
  applySchema(db);
  const artifactId = opts.artifactId ?? ATTEMPT_ARTIFACT_ID;
  const runId = opts.runId ?? "run-attempt-fixture";
  // Matches the column set every other test seeds runs with (drift-gate,
  // arbiter-gate, ...): agent/owner_id/status are NOT NULL in the runs schema.
  db.prepare("INSERT INTO runs (run_id, agent, owner_id, status) VALUES (?, 'code-writer-agent', 'guildctl', 'running')").run(runId);
  registerArtifact(db, {
    id: artifactId,
    kind: "legacy-source",
    path: `legacy/src/main/java/${artifactId.split(":").pop()}.java`,
  });
  const status = opts.status ?? "migrated";
  if (status !== "pending") {
    db.prepare("UPDATE artifacts SET status = ? WHERE id = ?").run(status, artifactId);
  }
  let claimId = "";
  if (opts.withClaim !== false) {
    claimId = `claim-attempt-${artifactId.split(":").pop()}`;
    // A released claim at from_status 'migrated': the migrate attempt this
    // fixture's attempt records describe has finished (released), so nothing
    // about it is still held in process memory.
    db.prepare(
      `INSERT INTO artifact_claims (claim_id, artifact_id, run_id, owner_id, agent, from_status, claim_token, state, attempt_no, lease_expires_at)
       VALUES (@claim_id, @artifact_id, @run_id, 'guildctl', 'code-writer-agent', 'migrated', @claim_token, 'released', @attempt_no, datetime('now', '+1 hour'))`,
    ).run({
      claim_id: claimId,
      artifact_id: artifactId,
      run_id: runId,
      claim_token: `tok-${claimId}`,
      attempt_no: opts.claimAttemptNo ?? 1,
    });
  }
  return { db, runId, artifactId, claimId };
}

export interface SeedAttemptRecordOptions {
  artifactId: string;
  attemptNo: number;
  /** Default: "migrate" per the contract's RecordAttemptOutcomeOptions. */
  phase?: string;
  outcome: AttemptOutcome;
  /** Required by data-model.md §3 whenever outcome !== 'succeeded'. */
  failureKind?: FailureKind;
  failureSignature?: string;
  startedAt?: string;
  finishedAt?: string;
  claimId?: string;
}

/**
 * Direct INSERT of one attempt_records row — the test-side stand-in for
 * recordAttemptOutcome() until that lands with T019. Defaults `started_at` /
 * `finished_at` to distinct, attempt-derived timestamps so history ordering
 * assertions have something stable to read.
 */
export function seedAttemptRecord(db: Database.Database, opts: SeedAttemptRecordOptions): void {
  if (opts.outcome !== "succeeded" && !opts.failureKind) {
    throw new Error(
      `seedAttemptRecord: failureKind is required when outcome is "${opts.outcome}" (data-model.md §3)`,
    );
  }
  const startedAt = opts.startedAt ?? `2026-01-01 00:00:${String(opts.attemptNo).padStart(2, "0")}`;
  const finishedAt = opts.finishedAt ?? `2026-01-01 00:01:${String(opts.attemptNo).padStart(2, "0")}`;
  db.prepare(
    `INSERT INTO attempt_records (
       artifact_id, attempt_no, phase, outcome, failure_kind, failure_signature,
       started_at, finished_at, claim_id
     ) VALUES (
       @artifact_id, @attempt_no, @phase, @outcome, @failure_kind, @failure_signature,
       @started_at, @finished_at, @claim_id
     )`,
  ).run({
    artifact_id: opts.artifactId,
    attempt_no: opts.attemptNo,
    phase: opts.phase ?? "migrate",
    outcome: opts.outcome,
    failure_kind: opts.failureKind ?? null,
    failure_signature: opts.failureSignature ?? null,
    started_at: startedAt,
    finished_at: finishedAt,
    claim_id: opts.claimId ?? null,
  });
}

export interface AttemptRecordRow {
  attempt_id: string;
  artifact_id: string;
  attempt_no: number;
  phase: string;
  outcome: string;
  failure_kind: string | null;
  failure_signature: string | null;
  started_at: string;
  finished_at: string;
  claim_id: string | null;
  recorded_at: string;
}

/**
 * attempt history for one artifact ordered by attempt_no — the same read
 * shape FR-010 requires (queryable after the fact, no process logs needed)
 * and the same ordering getAttemptHistory() will use when T019 lands.
 */
export function getAttemptHistory(db: Database.Database, artifactId: string): AttemptRecordRow[] {
  return db
    .prepare(
      `SELECT * FROM attempt_records WHERE artifact_id = ? ORDER BY attempt_no ASC`,
    )
    .all(artifactId) as AttemptRecordRow[];
}

/**
 * Simulate process restart: build a FRESH FailureBudget (empty in-memory
 * maps) that must re-seed from durable state for the same artifact — per
 * data-model.md §3, attempt and budget state MUST be re-seedable from
 * attempt_records + events after a restart, so a restarted supervisor neither
 * resets nor double-counts budget. The returned object carries the fresh
 * budget plus the durable inputs a restart-resumption test needs:
 * `attemptsUsed` (failed/budget-exhausted rows — what canAttemptArtifact
 * should account for) and `history` (the full ordered attempt_records rows).
 */
export function resumedBudgetFor(
  db: Database.Database,
  artifactId: string,
  budgetOpts: { maxAttemptsPerArtifact?: number; maxPlaybookPerSignature?: number } = {},
): {
  budget: FailureBudget;
  attemptsUsed: number;
  history: AttemptRecordRow[];
} {
  const budget = new FailureBudget(
    budgetOpts.maxAttemptsPerArtifact ?? 3,
    budgetOpts.maxPlaybookPerSignature ?? 2,
  );
  const history = getAttemptHistory(db, artifactId);
  const attemptsUsed = history.filter((row) => row.outcome !== "succeeded").length;
  return { budget, attemptsUsed, history };
}
