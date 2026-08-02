import type Database from "better-sqlite3";
import { redactSecrets } from "../../guildctl/verify";
import { RegistryError, VERIFICATION_REASONS, validateId } from "../types";
import type { VerificationReason, VerificationRecord, VerificationState } from "../types";
import { getActiveClaimByArtifactId, validateRunOperatorCredential } from "./claim";

/**
 * Artifact verification: whether an artifact's own output was checked, by what
 * method, and why.
 *
 * This module is deliberately powerless. It never writes `artifacts.status`,
 * never writes `acceptance_evidence`, and never unlocks a gate. Verification is
 * triage input; the arbitration gate continues to require independent
 * verifier-produced runtime evidence (Constitution IV, research R11).
 */

const VERIFICATION_STATES: readonly VerificationState[] = ["verified", "unverified", "verification-failed"];

/**
 * The canonical read: a missing row coalesces to unverified/not-attempted/none
 * rather than blank, without touching a single historical row (FR-002).
 */
const READ_MODEL_SQL = `
  SELECT a.id                                AS artifact_id,
         COALESCE(v.state,  'unverified')    AS state,
         COALESCE(v.reason, 'not-attempted') AS reason,
         COALESCE(v.method, 'none')          AS method,
         v.detail        AS detail,
         v.scope_json    AS scope_json,
         v.budget_ms     AS budget_ms,
         v.duration_ms   AS duration_ms,
         v.run_id        AS run_id,
         v.determined_at AS determined_at
  FROM artifacts a
  LEFT JOIN artifact_verifications v ON v.artifact_id = a.id
`;

export interface SetVerificationInput {
  artifactId: string;
  state: VerificationState;
  method: string;
  reason?: VerificationReason | null;
  detail?: string | null;
  scope?: string[] | null;
  budgetMs?: number | null;
  durationMs?: number | null;
  /** Authorization: an active claim on this artifact … */
  claimId?: string | null;
  claimToken?: string | null;
  /** … or a valid run operator credential. */
  runId?: string | null;
  operatorToken?: string | null;
  /** Recorded on the audit event; never a substitute for authorization. */
  agent?: string;
}

export interface ListVerificationOptions {
  state?: VerificationState;
  reason?: VerificationReason;
  limit?: number;
}

export interface VerificationListEntry {
  id: string;
  path: string;
  state: VerificationState;
  reason: string;
  method: string;
  determined_at: string | null;
}

export interface VerificationListing {
  counts: Record<"verified" | "unverified" | "verification-failed" | "total", number>;
  artifacts: VerificationListEntry[];
}

function requireArtifact(db: Database.Database, artifactId: string): void {
  validateId(artifactId);
  if (!db.prepare("SELECT id FROM artifacts WHERE id = ?").get(artifactId)) {
    throw new RegistryError(2, `Artifact not found: "${artifactId}"`);
  }
}

/**
 * Recording a verification is a registry write on a claimed artifact, so it is
 * authorized exactly as a status transition is (Constitution III). A
 * privileged-looking actor name does not bypass it.
 */
function requireAuthorization(db: Database.Database, input: SetVerificationInput): void {
  if (validateRunOperatorCredential(db, input.runId, input.operatorToken)) return;

  if (input.claimId && input.claimToken) {
    const claim = getActiveClaimByArtifactId(db, input.artifactId);
    if (claim && claim.claim_id === input.claimId && claim.claim_token === input.claimToken) return;
  }

  throw new RegistryError(
    3,
    `Recording verification for "${input.artifactId}" requires an active claim token or a valid run operator credential.`,
  );
}

function validateInput(input: SetVerificationInput): void {
  if (!VERIFICATION_STATES.includes(input.state)) {
    throw new RegistryError(1, `Unknown verification state: "${input.state}". Valid states: ${VERIFICATION_STATES.join(", ")}`);
  }
  if (!input.method || !input.method.trim()) {
    throw new RegistryError(1, "Verification requires a method");
  }

  if (input.state === "verified") {
    if (input.durationMs == null) {
      throw new RegistryError(1, "A verified record requires duration_ms");
    }
    if (!input.scope || input.scope.length === 0) {
      throw new RegistryError(1, "A verified record requires a non-empty scope — it must be able to say what it covered");
    }
    return;
  }

  const reason = input.reason?.trim();
  if (!reason) {
    throw new RegistryError(1, `A ${input.state} record requires a reason`);
  }
  if (!(VERIFICATION_REASONS as readonly string[]).includes(reason)) {
    throw new RegistryError(
      1,
      `Unknown verification reason: "${reason}". Valid reasons (closed vocabulary): ${VERIFICATION_REASONS.join(", ")}`,
    );
  }
}

export function setVerification(db: Database.Database, input: SetVerificationInput): VerificationRecord {
  requireArtifact(db, input.artifactId);
  requireAuthorization(db, input);
  validateInput(input);

  const reason = input.state === "verified" ? null : (input.reason as VerificationReason);
  const detail = input.detail == null ? null : redactSecrets(input.detail);
  const scopeJson = input.scope == null ? null : JSON.stringify(input.scope);

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO artifact_verifications
        (artifact_id, state, method, reason, detail, scope_json, budget_ms, duration_ms, run_id, determined_at)
      VALUES
        (@artifact_id, @state, @method, @reason, @detail, @scope_json, @budget_ms, @duration_ms, @run_id, datetime('now'))
      ON CONFLICT (artifact_id) DO UPDATE SET
        state = excluded.state, method = excluded.method, reason = excluded.reason,
        detail = excluded.detail, scope_json = excluded.scope_json,
        budget_ms = excluded.budget_ms, duration_ms = excluded.duration_ms,
        run_id = excluded.run_id, determined_at = excluded.determined_at
    `).run({
      artifact_id: input.artifactId,
      state: input.state,
      method: input.method,
      reason,
      detail,
      scope_json: scopeJson,
      budget_ms: input.budgetMs ?? null,
      duration_ms: input.durationMs ?? null,
      run_id: input.runId ?? null,
    });

    // History is not kept in the table (last-write-wins); the audit trail is the
    // events row written alongside. The events type CHECK list is deliberately
    // not extended for this feature.
    db.prepare(`
      INSERT INTO events (event_id, artifact_id, type, agent, summary, event_data)
      VALUES (lower(hex(randomblob(8))), @artifact_id, 'evaluated', @agent, @summary, @event_data)
    `).run({
      artifact_id: input.artifactId,
      agent: input.agent ?? "guildctl-verification",
      summary: `Verification recorded: ${input.state}${reason ? ` (${reason})` : ""} via ${input.method}`,
      event_data: JSON.stringify({
        state: input.state,
        reason,
        method: input.method,
        detail,
        scope: input.scope ?? null,
        budget_ms: input.budgetMs ?? null,
        duration_ms: input.durationMs ?? null,
        run_id: input.runId ?? null,
      }),
    });
  });
  tx();

  return getVerification(db, input.artifactId);
}

export function getVerification(db: Database.Database, artifactId: string): VerificationRecord {
  requireArtifact(db, artifactId);
  return db.prepare(`${READ_MODEL_SQL} WHERE a.id = ?`).get(artifactId) as VerificationRecord;
}

export function listVerification(
  db: Database.Database,
  opts: ListVerificationOptions = {},
): VerificationListing {
  const countRows = db.prepare(`
    SELECT COALESCE(v.state, 'unverified') AS state, COUNT(*) AS n
    FROM artifacts a
    LEFT JOIN artifact_verifications v ON v.artifact_id = a.id
    GROUP BY COALESCE(v.state, 'unverified')
  `).all() as Array<{ state: VerificationState; n: number }>;

  const counts = { verified: 0, unverified: 0, "verification-failed": 0, total: 0 };
  for (const row of countRows) {
    counts[row.state] = row.n;
    counts.total += row.n;
  }

  const conditions: string[] = [];
  const params: Record<string, string | number> = {};
  if (opts.state) {
    conditions.push("COALESCE(v.state, 'unverified') = @state");
    params["state"] = opts.state;
  }
  if (opts.reason) {
    conditions.push("COALESCE(v.reason, 'not-attempted') = @reason");
    params["reason"] = opts.reason;
  }

  let sql = `
    SELECT a.id                                AS id,
           a.path                              AS path,
           COALESCE(v.state,  'unverified')    AS state,
           COALESCE(v.reason, 'not-attempted') AS reason,
           COALESCE(v.method, 'none')          AS method,
           v.determined_at                     AS determined_at
    FROM artifacts a
    LEFT JOIN artifact_verifications v ON v.artifact_id = a.id
  `;
  if (conditions.length) sql += ` WHERE ${conditions.join(" AND ")}`;
  sql += " ORDER BY a.id";
  if (opts.limit != null) {
    sql += " LIMIT @limit";
    params["limit"] = opts.limit;
  }

  const artifacts = db.prepare(sql).all(params) as VerificationListEntry[];
  return { counts, artifacts };
}

/**
 * Invalidation (Constitution I, content-bound evidence): a verification of
 * superseded output must not survive the change. Called when an artifact
 * re-enters `in-progress` or `needs-rework`.
 */
export function resetVerification(db: Database.Database, artifactId: string): void {
  db.prepare(`
    UPDATE artifact_verifications
    SET state = 'unverified',
        reason = 'not-attempted',
        detail = NULL,
        scope_json = NULL,
        duration_ms = NULL,
        determined_at = datetime('now')
    WHERE artifact_id = ?
  `).run(artifactId);
}
