import type Database from "better-sqlite3";
import type { FailureKind } from "../../guildctl/supervisor/failures";
import { RegistryError } from "../types";

/**
 * Attempt-scoped retry history (spec 013, US3): durable commands over the
 * `attempt_records` table per contracts/registry-commands.md and
 * data-model.md §3.
 *
 * - `recordAttemptOutcome`  — the only writer: one INSERT per concluded
 *   attempt, never an upsert; (artifactId, attemptNo) collisions throw.
 * - `getAttemptHistory`     — the FR-010 read: per-artifact rows ordered by
 *   attempt_no, queryable after the fact without process logs.
 * - `getPersistedBudgetState` — the FR-009 read: what `FailureBudget` seeds
 *   from on construction so a restart resumes consumed attempts/playbooks
 *   with accounting identical to a no-restart run (research.md §5).
 */

/** attempt_records.outcome values per data-model.md §3. */
export type AttemptOutcome = "succeeded" | "failed" | "budget-exhausted";

export interface RecordAttemptOutcomeOptions {
  artifactId: string;
  attemptNo: number;
  /** Default: "migrate" per the contract. */
  phase?: string;
  outcome: AttemptOutcome;
  /** Required when outcome !== "succeeded"; must be absent when it is. */
  failureKind?: FailureKind;
  failureSignature?: string;
  startedAt: string;
  runId?: string;
}

/** One `attempt_records` row as read back (snake_case column names). */
export interface AttemptRecord {
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
 * Durable failure-budget state for one artifact: how many attempts have been
 * recorded, and how many times each failure signature has occurred (only
 * non-null signatures). This is exactly what `FailureBudget` needs to
 * reconstruct `attemptsUsed` and its per-signature playbook counts.
 */
export interface PersistedBudgetState {
  attemptsUsed: number;
  playbookSignatureCounts: Record<string, number>;
}

/**
 * Record one concluded attempt. Single INSERT — the table is append-only, so
 * a pre-existing (artifactId, attemptNo) row throws RegistryError instead of
 * being overwritten (data-model.md §3 invariant).
 */
export function recordAttemptOutcome(db: Database.Database, opts: RecordAttemptOutcomeOptions): void {
  // data-model.md §3: failure_kind is NULL iff outcome is 'succeeded'.
  if (opts.outcome === "succeeded") {
    if (opts.failureKind != null) {
      throw new RegistryError(1, "failureKind must be null when outcome is 'succeeded'");
    }
  } else if (opts.failureKind == null) {
    throw new RegistryError(1, `failureKind is required when outcome is '${opts.outcome}'`);
  }

  const existing = db
    .prepare("SELECT 1 AS x FROM attempt_records WHERE artifact_id = ? AND attempt_no = ?")
    .get(opts.artifactId, opts.attemptNo) as { x: number } | undefined;
  if (existing) {
    throw new RegistryError(1, `Attempt ${opts.attemptNo} already recorded for artifact ${opts.artifactId}`);
  }

  db.prepare(
    `INSERT INTO attempt_records (
       artifact_id, attempt_no, phase, outcome, failure_kind, failure_signature,
       started_at
     ) VALUES (
       @artifact_id, @attempt_no, @phase, @outcome, @failure_kind, @failure_signature,
       @started_at
     )`,
  ).run({
    artifact_id: opts.artifactId,
    attempt_no: opts.attemptNo,
    phase: opts.phase ?? "migrate",
    outcome: opts.outcome,
    failure_kind: opts.failureKind ?? null,
    failure_signature: opts.failureSignature ?? null,
    started_at: opts.startedAt,
  });
}

/** Pure read: the artifact's attempt rows ordered by attempt_no (FR-010). */
export function getAttemptHistory(db: Database.Database, artifactId: string): AttemptRecord[] {
  return db
    .prepare("SELECT * FROM attempt_records WHERE artifact_id = ? ORDER BY attempt_no ASC")
    .all(artifactId) as AttemptRecord[];
}

/**
 * Pure read (FR-009, research.md §5): durable state a fresh `FailureBudget`
 * seeds from so restart-resumption neither resets nor double-counts budget.
 * `attemptsUsed` is the COUNT of attempt_records rows for the artifact;
 * `playbookSignatureCounts` maps each non-null failure_signature to its count.
 */
export function getPersistedBudgetState(db: Database.Database, artifactId: string): PersistedBudgetState {
  const attemptsRow = db
    .prepare("SELECT COUNT(*) AS n FROM attempt_records WHERE artifact_id = ?")
    .get(artifactId) as { n: number };
  const signatureRows = db
    .prepare(
      `SELECT failure_signature, COUNT(*) AS n
       FROM attempt_records
       WHERE artifact_id = ? AND failure_signature IS NOT NULL
       GROUP BY failure_signature`,
    )
    .all(artifactId) as Array<{ failure_signature: string; n: number }>;
  const playbookSignatureCounts: Record<string, number> = {};
  for (const row of signatureRows) {
    playbookSignatureCounts[row.failure_signature] = row.n;
  }
  return { attemptsUsed: attemptsRow.n, playbookSignatureCounts };
}
