import type Database from "better-sqlite3";
import { RegistryError } from "../types";
import type { Artifact } from "../types";

/**
 * Atomically claims the next available artifact for a specific phase.
 *
 * An artifact is claimable when:
 *   1. Its status matches `fromStatus`
 *   2. All artifacts it depends on have status "migrated", "reviewed", "completed", or "skipped"
 *
 * The read-check-write is wrapped in a SQLite transaction, so concurrent sessions
 * cannot claim the same artifact.
 *
 * Returns the claimed artifact, or throws:
 *   - RegistryError(2) — nothing claimable right now, but work remains (blocked by deps or in-progress)
 *   - RegistryError(4) — all tasks are in terminal states; agent should stop
 */
export function claimNextTask(
  db: Database.Database,
  agent: string,
  wave?: number,
  fromStatus: string = "planned",
  model?: string,
  tier?: string,
): Artifact {
  const toStatus = "in-progress";

  const claim = db.transaction((): Artifact => {
    const params: Record<string, string | number> = { fromStatus };
    let waveClause = "";
    let tierClause = "";
    if (wave !== undefined) {
      waveClause = "AND a.wave = @wave";
      params["wave"] = wave;
    }
    if (tier) {
      tierClause = "AND a.tier = @tier";
      params["tier"] = tier;
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
            AND dep.status NOT IN ('migrated', 'reviewed', 'completed', 'skipped')
        )
      ORDER BY a.wave ASC, a.created_at ASC
      LIMIT 1
    `).get(params) as Artifact | undefined;

    if (!candidate) {
      // Distinguish: is there any work still in flight, or is everything done?
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

    db.prepare(`
      UPDATE artifacts
      SET status = ?,
          claimed_by = ?,
          claimed_at = datetime('now'),
          claimed_from = ?,
          updated_at = datetime('now')
      WHERE id = ? AND status = @fromStatus
    `).run(toStatus, agent, fromStatus, candidate.id, { fromStatus });

    db.prepare(`
      INSERT INTO events (event_id, artifact_id, type, agent, model, summary)
      VALUES (lower(hex(randomblob(8))), ?, 'claimed', ?, ?, ?)
    `).run(candidate.id, agent, model ?? null, `Claimed by ${agent} (from ${fromStatus})`);

    return db.prepare(`SELECT * FROM artifacts WHERE id = ?`).get(candidate.id) as Artifact;
  });

  return claim();
}
