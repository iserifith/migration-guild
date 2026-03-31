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
 * Returns the claimed artifact, or throws NOT_FOUND if nothing is available.
 */
export function claimNextTask(
  db: Database.Database,
  agent: string,
  wave?: number,
  fromStatus: string = "planned",
  model?: string,
): Artifact {
  const toStatus = fromStatus === "planned" ? "in-progress"
    : fromStatus === "analyzed" ? "in-progress"
    : "in-progress";

  const claim = db.transaction((): Artifact => {
    const params: Record<string, string | number> = { fromStatus };
    let waveClause = "";
    if (wave !== undefined) {
      waveClause = "AND a.wave = @wave";
      params["wave"] = wave;
    }

    const candidate = db.prepare(`
      SELECT a.*
      FROM artifacts a
      WHERE a.status = @fromStatus
        ${waveClause}
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
      const msg = wave !== undefined
        ? `No claimable tasks in wave ${wave} with status '${fromStatus}'.`
        : `No claimable tasks. All '${fromStatus}' artifacts are either in-progress or waiting on dependencies.`;
      throw new RegistryError(2, msg);
    }

    db.prepare(`
      UPDATE artifacts
      SET status = '${toStatus}', updated_at = datetime('now')
      WHERE id = ? AND status = @fromStatus
    `).run(candidate.id, { fromStatus });

    db.prepare(`
      INSERT INTO events (event_id, artifact_id, type, agent, model, summary)
      VALUES (lower(hex(randomblob(8))), ?, 'claimed', ?, ?, ?)
    `).run(candidate.id, agent, model ?? null, `Claimed by ${agent} (from ${fromStatus})`);

    return db.prepare(`SELECT * FROM artifacts WHERE id = ?`).get(candidate.id) as Artifact;
  });

  return claim();
}
