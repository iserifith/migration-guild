import { createHash, randomUUID, timingSafeEqual } from "crypto";
import type Database from "better-sqlite3";
import { RegistryError } from "../types";
import type { Artifact, ArtifactClaim, ClaimedArtifact, Status } from "../types";

const DEFAULT_LEASE_MINUTES = Math.max(
  5,
  parseInt(process.env["GUILDCTL_CLAIM_LEASE_MINS"] ?? "30", 10),
);

function makeOpaqueId(): string {
  return randomUUID().replace(/-/g, "");
}

function hashOperatorToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function createRunOperatorCredential(
  db: Database.Database,
  runId: string,
): { runId: string; token: string } {
  const run = db.prepare("SELECT run_id FROM runs WHERE run_id = ?").get(runId);
  if (!run) {
    throw new RegistryError(2, `Run not found: "${runId}"`);
  }
  const token = makeOpaqueId() + makeOpaqueId();
  db.prepare(`
    INSERT INTO run_operator_credentials (run_id, token_hash)
    VALUES (@run_id, @token_hash)
    ON CONFLICT(run_id) DO UPDATE SET
      token_hash = excluded.token_hash,
      created_at = datetime('now')
  `).run({ run_id: runId, token_hash: hashOperatorToken(token) });
  return { runId, token };
}

export function validateRunOperatorCredential(
  db: Database.Database,
  runId: string | undefined | null,
  token: string | undefined | null,
): boolean {
  if (!runId || !token) return false;
  const row = db.prepare(`
    SELECT token_hash
    FROM run_operator_credentials
    WHERE run_id = ?
  `).get(runId) as { token_hash: string } | undefined;
  if (!row) return false;
  const expected = Buffer.from(row.token_hash, "hex");
  const actual = Buffer.from(hashOperatorToken(token), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function loadClaimedArtifact(
  db: Database.Database,
  artifactId: string,
): ClaimedArtifact {
  return db.prepare(`
    SELECT
      a.*,
      c.claim_id,
      c.claim_token,
      c.run_id AS claim_run_id,
      c.owner_id AS claim_owner_id,
      c.lease_expires_at,
      c.heartbeat_at,
      c.attempt_no,
      c.expected_output_paths
    FROM artifacts a
    JOIN artifact_claims c
      ON c.artifact_id = a.id
     AND c.state = 'active'
    WHERE a.id = ?
  `).get(artifactId) as ClaimedArtifact;
}

function loadActiveClaimById(
  db: Database.Database,
  claimId: string,
): ArtifactClaim | undefined {
  return db.prepare(`
    SELECT *
    FROM artifact_claims
    WHERE claim_id = ?
      AND state = 'active'
  `).get(claimId) as ArtifactClaim | undefined;
}

function requireActiveClaimById(
  db: Database.Database,
  claimId: string,
): ArtifactClaim {
  const claim = loadActiveClaimById(db, claimId);
  if (!claim) {
    throw new RegistryError(3, `Active claim "${claimId}" not found.`);
  }
  return claim;
}

export function getActiveClaimByArtifactId(
  db: Database.Database,
  artifactId: string,
): ArtifactClaim | undefined {
  return db.prepare(`
    SELECT *
    FROM artifact_claims
    WHERE artifact_id = ?
      AND state = 'active'
  `).get(artifactId) as ArtifactClaim | undefined;
}

function validateClaimOwnership(
  db: Database.Database,
  artifactId: string,
  claimId: string,
  claimToken: string,
): ArtifactClaim {
  const claim = loadActiveClaimById(db, claimId);
  if (!claim || claim.artifact_id !== artifactId) {
    throw new RegistryError(3, `Active claim not found for artifact "${artifactId}".`);
  }
  if (claim.claim_token !== claimToken) {
    throw new RegistryError(3, `Claim token mismatch for artifact "${artifactId}".`);
  }
  const stillValid = db.prepare(`
    SELECT 1
    FROM artifact_claims
    WHERE claim_id = ?
      AND state = 'active'
      AND claim_token = ?
      AND lease_expires_at > datetime('now')
  `).get(claimId, claimToken);
  if (!stillValid) {
    throw new RegistryError(
      3,
      `Claim "${claimId}" for artifact "${artifactId}" is no longer active or its lease expired.`,
    );
  }
  return claim;
}

function assertRunHasNoActiveClaim(
  db: Database.Database,
  runId: string | undefined,
): void {
  if (!runId) return;
  const existing = db.prepare(`
    SELECT claim_id, artifact_id
    FROM artifact_claims
    WHERE run_id = ?
      AND state = 'active'
    LIMIT 1
  `).get(runId) as { claim_id: string; artifact_id: string } | undefined;
  if (existing) {
    throw new RegistryError(
      3,
      `Run "${runId}" already has an active claim "${existing.claim_id}" for artifact "${existing.artifact_id}".`,
    );
  }
}

function finishClaimRecord(
  db: Database.Database,
  claim: ArtifactClaim,
  state: "completed" | "released" | "expired" | "failed",
  reason: string,
  eventType: "claim-completed" | "claim-released" | "claim-expired",
  eventAgent: string,
): void {
  db.prepare(`
    UPDATE artifact_claims
    SET state = @state,
        finished_at = datetime('now'),
        finish_reason = @reason
    WHERE claim_id = @claim_id
      AND state = 'active'
  `).run({
    claim_id: claim.claim_id,
    state,
    reason,
  });

  db.prepare(`
    INSERT INTO events (event_id, artifact_id, type, agent, summary, event_data)
    VALUES (
      lower(hex(randomblob(8))),
      @artifact_id,
      @type,
      @agent,
      @summary,
      @event_data
    )
  `).run({
    artifact_id: claim.artifact_id,
    type: eventType,
    agent: eventAgent,
    summary: reason,
    event_data: JSON.stringify({
      claim_id: claim.claim_id,
      run_id: claim.run_id,
      owner_id: claim.owner_id,
      attempt_no: claim.attempt_no,
      from_status: claim.from_status,
      state,
    }),
  });
}

function releaseClaimRecord(
  db: Database.Database,
  claim: ArtifactClaim,
  eventAgent: string,
  reason?: string,
  expired = false,
): Artifact {
  const returnTo = claim.from_status ?? "planned";
  const summary = reason
    ? reason
    : expired
      ? `Lease expired for ${claim.owner_id}; returned to ${returnTo}`
      : `Released by ${eventAgent}, returned to ${returnTo}`;

  db.prepare(`
    UPDATE artifacts
    SET status = @status,
        claimed_by = NULL,
        claimed_at = NULL,
        claimed_from = NULL,
        updated_at = datetime('now')
    WHERE id = @id
      AND status = 'in-progress'
  `).run({
    id: claim.artifact_id,
    status: returnTo,
  });

  finishClaimRecord(
    db,
    claim,
    expired ? "expired" : "released",
    summary,
    expired ? "claim-expired" : "claim-released",
    eventAgent,
  );

  return db.prepare("SELECT * FROM artifacts WHERE id = ?").get(claim.artifact_id) as Artifact;
}

export function completeClaimForArtifact(
  db: Database.Database,
  artifactId: string,
  claimId: string,
  claimToken: string,
  agent: string,
  finalStatus: Status,
): ArtifactClaim {
  const claim = validateClaimOwnership(db, artifactId, claimId, claimToken);
  finishClaimRecord(
    db,
    claim,
    "completed",
    `Completed by ${agent}: ${claim.from_status} -> ${finalStatus}`,
    "claim-completed",
    agent,
  );
  return db.prepare("SELECT * FROM artifact_claims WHERE claim_id = ?").get(claimId) as ArtifactClaim;
}

export function heartbeatClaim(
  db: Database.Database,
  claimId: string,
  claimToken: string,
  agent: string,
  leaseMinutes = DEFAULT_LEASE_MINUTES,
): ArtifactClaim {
  const activeClaim = requireActiveClaimById(db, claimId);
  const claim = validateClaimOwnership(db, activeClaim.artifact_id, claimId, claimToken);

  db.prepare(`
    UPDATE artifact_claims
    SET heartbeat_at = datetime('now'),
        lease_expires_at = datetime('now', '+' || @lease_minutes || ' minutes')
    WHERE claim_id = @claim_id
      AND state = 'active'
      AND claim_token = @claim_token
  `).run({
    claim_id: claimId,
    claim_token: claimToken,
    lease_minutes: leaseMinutes,
  });

  db.prepare(`
    INSERT INTO events (event_id, artifact_id, type, agent, summary, event_data)
    VALUES (
      lower(hex(randomblob(8))),
      @artifact_id,
      'claim-heartbeat',
      @agent,
      @summary,
      @event_data
    )
  `).run({
    artifact_id: claim.artifact_id,
    agent,
    summary: `Heartbeat renewed lease for claim ${claimId}`,
    event_data: JSON.stringify({
      claim_id: claimId,
      run_id: claim.run_id,
      owner_id: claim.owner_id,
      lease_minutes: leaseMinutes,
    }),
  });

  return db.prepare("SELECT * FROM artifact_claims WHERE claim_id = ?").get(claimId) as ArtifactClaim;
}

export function releaseClaimByArtifactId(
  db: Database.Database,
  artifactId: string,
  agent: string,
  reason?: string,
): Artifact {
  const claim = getActiveClaimByArtifactId(db, artifactId);
  if (!claim) {
    throw new RegistryError(1, `Artifact "${artifactId}" does not have an active claim.`);
  }
  return releaseClaimRecord(db, claim, agent, reason);
}

export function releaseClaimsForRun(
  db: Database.Database,
  runId: string,
  agent: string,
  reason?: string,
): Artifact[] {
  const rows = db.prepare(`
    SELECT *
    FROM artifact_claims
    WHERE run_id = ?
      AND state = 'active'
    ORDER BY claimed_at ASC
  `).all(runId) as ArtifactClaim[];
  return rows.map((claim) => releaseClaimRecord(db, claim, agent, reason));
}

export function releaseClaimedArtifactsForOwner(
  db: Database.Database,
  ownerId: string,
  agent: string,
  reason?: string,
): Artifact[] {
  const rows = db.prepare(`
    SELECT *
    FROM artifact_claims
    WHERE owner_id = ?
      AND state = 'active'
    ORDER BY claimed_at ASC
  `).all(ownerId) as ArtifactClaim[];
  return rows.map((claim) => releaseClaimRecord(db, claim, agent, reason));
}

// ─── TASK-05: single-owner claim protocol ────────────────────────────────────
//
// The migrate runner pre-claims an artifact on behalf of an agent and hands it
// off via GUILDCTL_ARTIFACT_ID (plus GUILDCTL_CLAIM_ID / GUILDCTL_CLAIM_TOKEN).
// An agent that instead calls `claim` (claimNextTask) grabs a DIFFERENT artifact,
// leaving the pre-claimed one dangling — the B5 double-claim bug. These helpers
// make the handoff mechanically binding: an agent-side claim resolves the env
// var and refuses to grab any other artifact.

/**
 * Validate a companion output path: must be a normalized relative path, must
 * not escape the working tree (no leading `/`, no `..` segments), and must
 * live under `modern/`.  Fail-closed on any violation.
 */
function validateCompanionPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    throw new RegistryError(1, "Companion output path is required");
  }
  if (/^\//.test(trimmed)) {
    throw new RegistryError(
      3,
      `Companion output path must be relative (got absolute): "${trimmed}"`,
    );
  }
  const normalized = trimmed.split("/").filter(Boolean).join("/");
  if (normalized !== trimmed) {
    throw new RegistryError(
      3,
      `Companion output path is not normalized: "${trimmed}" (expected "${normalized}")`,
    );
  }
  if (normalized.includes("..")) {
    throw new RegistryError(
      3,
      `Companion output path must not contain ".." segments: "${trimmed}"`,
    );
  }
  if (!normalized.startsWith("modern/")) {
    throw new RegistryError(
      3,
      `Companion output path must be under modern/ (got "${trimmed}")`,
    );
  }
  return normalized;
}

/**
 * Derive the allowed output path(s) for a claimed artifact. The legacy file
 * lives under `legacy/`; its migrated twin is expected under the `modern/`
 * mirror at the same relative position.  When `db` is supplied, operator-
 * approved companion outputs are fetched from the registry and unioned in
 * (each validated fail-closed).  Returned as a JSON array of strings
 * (TASK-04 consumes this to compute the per-pool allowed-path union).
 */
export function deriveExpectedOutputPaths(artifact: Artifact, db?: Database.Database): string[] {
  const p = artifact.path ?? "";
  const modernPath = p.replace(/(^|\/)legacy\//, "$1modern/");
  const paths: string[] = modernPath !== p ? [modernPath] : [];

  if (db) {
    const rows = db.prepare(
      "SELECT output_path FROM approved_companion_outputs WHERE artifact_id = ?",
    ).all(artifact.id) as Array<{ output_path: string }>;
    for (const row of rows) {
      const validated = validateCompanionPath(row.output_path);
      if (!paths.includes(validated)) {
        paths.push(validated);
      }
    }
  }

  return paths;
}

/**
 * Claim a specific artifact by id (or resolve from GUILDCTL_ARTIFACT_ID when
 * `artifactId` is omitted). Enforces single-owner semantics:
 *  - a different owner already holds an active claim → reject (name the owner)
 *  - same owner already holds it → idempotent success (no duplicate row)
 *  - GUILDCTL_ARTIFACT_ID is set to a different id → reject (work your assigned artifact)
 */
export function claimArtifactById(
  db: Database.Database,
  opts: {
    artifactId?: string;
    agent: string;
    ownerId?: string;
    runId?: string;
    model?: string;
    fromStatus?: Status;
    leaseMinutes?: number;
    /** read from process.env by the caller when binding to a pre-claim */
    envArtifactId?: string;
  },
): ClaimedArtifact {
  const envAssigned = opts.envArtifactId?.trim() || undefined;
  const requestedId = opts.artifactId?.trim() || envAssigned;

  if (!requestedId) {
    throw new RegistryError(
      1,
      "No artifact specified and GUILDCTL_ARTIFACT_ID is not set. " +
        "Provide --id <artifactId> or run under a pre-claimed handoff.",
    );
  }

  // Handoff binding: the runner told this agent to work a specific artifact.
  if (envAssigned && envAssigned !== requestedId) {
    throw new RegistryError(
      3,
      `This agent is assigned artifact "${envAssigned}" (GUILDCTL_ARTIFACT_ID). ` +
        `Refusing to claim "${requestedId}". Work your assigned artifact.`,
    );
  }

  const owner = opts.ownerId ?? opts.agent;
  const fromStatus = opts.fromStatus ?? "planned";

  return db.transaction((): ClaimedArtifact => {
    const artifact = db
      .prepare("SELECT * FROM artifacts WHERE id = ?")
      .get(requestedId) as Artifact | undefined;
    if (!artifact) {
      throw new RegistryError(2, `Artifact not found: "${requestedId}"`);
    }

    const existing = getActiveClaimByArtifactId(db, requestedId);
    if (existing) {
      if (existing.owner_id !== owner) {
        const ageMin = db
          .prepare(
            `SELECT CAST((julianday('now') - julianday(claimed_at)) * 1440 AS INTEGER) AS m
             FROM artifact_claims WHERE claim_id = ?`,
          )
          .get(existing.claim_id) as { m: number };
        throw new RegistryError(
          3,
          `Artifact "${requestedId}" is claimed by a different owner "${existing.owner_id}" ` +
            `(claim ${existing.claim_id.slice(0, 8)}, ${ageMin.m}m old). ` +
            `Refusing conflicting claim.`,
        );
      }
      // Same owner re-claiming: idempotent — return the existing claim handle.
      return loadClaimedArtifact(db, requestedId);
    }

    assertRunHasNoActiveClaim(db, opts.runId);

    if (artifact.status !== fromStatus) {
      throw new RegistryError(
        3,
        `Artifact "${requestedId}" has status "${artifact.status}", expected "${fromStatus}". ` +
          `Refusing claim.`,
      );
    }

    const claimId = makeOpaqueId();
    const claimToken = makeOpaqueId();
    const leaseMinutes = opts.leaseMinutes ?? DEFAULT_LEASE_MINUTES;
    const attemptRow = db
      .prepare(
        `SELECT COALESCE(MAX(attempt_no), 0) AS attempt_no
         FROM artifact_claims WHERE artifact_id = ?`,
      )
      .get(requestedId) as { attempt_no: number };

    const update = db.prepare(`
      UPDATE artifacts
      SET status = 'in-progress',
          claimed_by = @claimed_by,
          claimed_at = datetime('now'),
          claimed_from = @claimed_from,
          updated_at = datetime('now')
      WHERE id = @id AND status = @from_status
    `).run({
      id: requestedId,
      claimed_by: owner,
      claimed_from: fromStatus,
      from_status: fromStatus,
    });
    if (update.changes !== 1) {
      throw new RegistryError(3, `Failed to claim "${requestedId}": status changed concurrently.`);
    }

    db.prepare(`
      INSERT INTO artifact_claims (
        claim_id, artifact_id, run_id, owner_id, agent, from_status,
        claim_token, state, attempt_no, expected_output_paths,
        claimed_at, heartbeat_at, lease_expires_at
      ) VALUES (
        @claim_id, @artifact_id, @run_id, @owner_id, @agent, @from_status,
        @claim_token, 'active', @attempt_no, @expected_output_paths,
        datetime('now'), datetime('now'),
        datetime('now', '+' || @lease_minutes || ' minutes')
      )
    `).run({
      claim_id: claimId,
      artifact_id: requestedId,
      run_id: opts.runId ?? null,
      owner_id: owner,
      agent: opts.agent,
      from_status: fromStatus,
      claim_token: claimToken,
      attempt_no: attemptRow.attempt_no + 1,
      expected_output_paths: JSON.stringify(deriveExpectedOutputPaths(artifact, db)),
      lease_minutes: leaseMinutes,
    });

    db.prepare(`
      INSERT INTO events (event_id, artifact_id, type, agent, model, summary, event_data)
      VALUES (lower(hex(randomblob(8))), @artifact_id, 'claimed', @agent, @model,
        @summary, @event_data)
    `).run({
      artifact_id: requestedId,
      agent: opts.agent,
      model: opts.model ?? null,
      summary: `Claimed by ${owner} (from ${fromStatus}) [explicit id]`,
      event_data: JSON.stringify({
        claim_id: claimId,
        run_id: opts.runId ?? null,
        owner_id: owner,
        attempt_no: attemptRow.attempt_no + 1,
        lease_minutes: leaseMinutes,
      }),
    });

    return loadClaimedArtifact(db, requestedId);
  })();
}

/**
 * Release a single claim by its id+token. Only the owning claim (matching
 * claim_token) may release it; `--force` allows an operator/runner to release
 * a claim whose token it does not hold (e.g. crashed-runner cleanup).
 */
export function releaseClaim(
  db: Database.Database,
  claimId: string,
  claimToken: string,
  agent: string,
  force = false,
  reason?: string,
): Artifact {
  const claim = loadActiveClaimById(db, claimId);
  if (!claim) {
    throw new RegistryError(3, `Active claim "${claimId}" not found.`);
  }
  if (!force && claim.claim_token !== claimToken) {
    throw new RegistryError(
      3,
      `Claim token mismatch for "${claimId}". Only the owning agent may release ` +
        `(use --force to override as an operator).`,
    );
  }
  return releaseClaimRecord(db, claim, agent, reason);
}

export function reconcileStaleClaims(
  db: Database.Database,
  agent = "system",
): Artifact[] {
  const { now } = db.prepare("SELECT datetime('now') AS now").get() as { now: string };
  const rows = db.prepare(`
    SELECT
      c.*,
      CASE WHEN c.lease_expires_at <= @now THEN 1 ELSE 0 END AS lease_expired
    FROM artifact_claims c
    LEFT JOIN runs r ON r.run_id = c.run_id
    WHERE c.state = 'active'
      AND (
        c.lease_expires_at <= @now
        OR (c.run_id IS NOT NULL AND (r.run_id IS NULL OR r.status != 'running'))
      )
    ORDER BY c.claimed_at ASC
  `).all({ now }) as Array<ArtifactClaim & { lease_expired: number }>;

  return rows.map((claim) => {
    const expired = claim.lease_expired === 1;
    const reason = expired
      ? `Lease expired for ${claim.owner_id}; returned to ${claim.from_status}`
      : `Recovered stale claim for ${claim.owner_id} after run ${claim.run_id ?? "unknown"} stopped`;
    return releaseClaimRecord(
      db,
      claim,
      agent,
      reason,
      expired,
    );
  });
}

export function claimNextTask(
  db: Database.Database,
  agent: string,
  wave?: number,
  fromStatus: Status = "planned",
  model?: string,
  tier?: string,
  runId?: string,
  ownerId?: string,
  leaseMinutes = DEFAULT_LEASE_MINUTES,
): ClaimedArtifact {
  const owner = ownerId ?? agent;

  const claim = db.transaction((): ClaimedArtifact => {
    assertRunHasNoActiveClaim(db, runId);
    const params: Record<string, string | number> = { fromStatus };
    let waveClause = "";
    let tierClause = "";
    let dependencyTierClause = "";
    if (wave !== undefined) {
      waveClause = "AND a.wave = @wave";
      params["wave"] = wave;
    }
    if (tier) {
      tierClause = "AND a.tier = @tier";
      params["tier"] = tier;
      if (tier === "first-class") {
        dependencyTierClause = "AND dep.tier = 'first-class'";
      }
    } else {
      dependencyTierClause = "AND dep.tier = 'first-class'";
    }

    const candidate = db.prepare(`
      SELECT a.*
      FROM artifacts a
      WHERE a.status = @fromStatus
        ${waveClause}
        ${tierClause}
        AND NOT EXISTS (
          SELECT 1
          FROM dependencies d
          JOIN artifacts dep ON dep.id = d.depends_on_id
          WHERE d.artifact_id = a.id
            ${dependencyTierClause}
            AND dep.status NOT IN ('migrated', 'reviewed', 'completed', 'skipped')
        )
      ORDER BY a.wave ASC, a.created_at ASC
      LIMIT 1
    `).get(params) as Artifact | undefined;

    if (!candidate) {
      const activeParams: Record<string, string | number> = {};
      const waveFilter = wave !== undefined ? "AND wave = @wave" : "";
      const tierFilter = tier ? "AND tier = @tier" : "";
      if (wave !== undefined) activeParams["wave"] = wave;
      if (tier) activeParams["tier"] = tier;

      const activeCount = db.prepare(`
        SELECT COUNT(*) AS count FROM artifacts
        WHERE status IN ('planned', 'analyzed', 'in-progress', 'tests-written')
          ${tierFilter}
          ${waveFilter}
      `).get(activeParams) as { count: number };

      if (activeCount.count === 0) {
        const scope = wave !== undefined ? ` in wave ${wave}` : "";
        const tierScope = tier ? ` for tier '${tier}'` : "";
        throw new RegistryError(4, `All tasks complete${scope}${tierScope}. Nothing planned or in-progress remains.`);
      }

      const scopeParts = [
        wave !== undefined ? `in wave ${wave}` : null,
        tier ? `for tier '${tier}'` : null,
      ].filter(Boolean);
      const scopedSuffix = scopeParts.length > 0 ? ` ${scopeParts.join(" ")}` : "";
      const msg = wave !== undefined
        ? `No claimable tasks${scopedSuffix} with status '${fromStatus}'. ${activeCount.count} artifact(s) are in-progress or waiting on dependencies.`
        : `No claimable tasks${scopedSuffix}. ${activeCount.count} artifact(s) are in-progress or waiting on dependencies.`;
      throw new RegistryError(2, msg);
    }

    const claimId = makeOpaqueId();
    const claimToken = makeOpaqueId();
    const attemptRow = db.prepare(`
      SELECT COALESCE(MAX(attempt_no), 0) AS attempt_no
      FROM artifact_claims
      WHERE artifact_id = ?
    `).get(candidate.id) as { attempt_no: number };

    const update = db.prepare(`
      UPDATE artifacts
      SET status = 'in-progress',
          claimed_by = @claimed_by,
          claimed_at = datetime('now'),
          claimed_from = @claimed_from,
          updated_at = datetime('now')
      WHERE id = @id
        AND status = @from_status
    `).run({
      id: candidate.id,
      claimed_by: owner,
      claimed_from: fromStatus,
      from_status: fromStatus,
    });
    if (update.changes !== 1) {
      throw new RegistryError(3, `Failed to claim "${candidate.id}" because its status changed concurrently.`);
    }

    db.prepare(`
      INSERT INTO artifact_claims (
        claim_id,
        artifact_id,
        run_id,
        owner_id,
        agent,
        from_status,
        claim_token,
        state,
        attempt_no,
        expected_output_paths,
        claimed_at,
        heartbeat_at,
        lease_expires_at
      ) VALUES (
        @claim_id,
        @artifact_id,
        @run_id,
        @owner_id,
        @agent,
        @from_status,
        @claim_token,
        'active',
        @attempt_no,
        @expected_output_paths,
        datetime('now'),
        datetime('now'),
        datetime('now', '+' || @lease_minutes || ' minutes')
      )
    `).run({
      claim_id: claimId,
      artifact_id: candidate.id,
      run_id: runId ?? null,
      owner_id: owner,
      agent,
      from_status: fromStatus,
      claim_token: claimToken,
      attempt_no: attemptRow.attempt_no + 1,
      expected_output_paths: JSON.stringify(deriveExpectedOutputPaths(candidate, db)),
      lease_minutes: leaseMinutes,
    });

    db.prepare(`
      INSERT INTO events (event_id, artifact_id, type, agent, model, summary, event_data)
      VALUES (
        lower(hex(randomblob(8))),
        @artifact_id,
        'claimed',
        @agent,
        @model,
        @summary,
        @event_data
      )
    `).run({
      artifact_id: candidate.id,
      agent,
      model: model ?? null,
      summary: `Claimed by ${owner} (from ${fromStatus})`,
      event_data: JSON.stringify({
        claim_id: claimId,
        run_id: runId ?? null,
        owner_id: owner,
        attempt_no: attemptRow.attempt_no + 1,
        lease_minutes: leaseMinutes,
      }),
    });

    return loadClaimedArtifact(db, candidate.id);
  });

  return claim();
}
