import * as fs from "fs";
import type Database from "better-sqlite3";
import type { Artifact } from "../../registry/types";

/**
 * Resolves the target-side file path for an artifact that should serve as a
 * reference in the embedding corpus.
 *
 * - For `target-source` / `test` artifacts: the artifact's own `path` is
 *   already the target-side file.
 * - For `legacy-source` artifacts: first checks for a linked `target-source`
 *   or `test` artifact via a `produced-by` relation; falls back to the
 *   conventional path derived by replacing the `legacy/` path prefix with
 *   `modern/`.
 *
 * Returns `null` when no target file can be found on disk.
 */
export function resolveTargetPath(
  db: Database.Database,
  artifact: Artifact,
): string | null {
  let candidate: string;

  if (artifact.kind === "target-source" || artifact.kind === "test") {
    candidate = artifact.path;
  } else {
    // legacy-source: prefer an explicitly registered produced-by link.
    const linked = db
      .prepare(
        `SELECT a.path FROM dependencies d
         JOIN artifacts a ON a.id = d.artifact_id
         WHERE d.depends_on_id = ?
           AND d.relation = 'produced-by'
           AND a.kind IN ('target-source', 'test')
         LIMIT 1`,
      )
      .get(artifact.id) as { path: string } | undefined;

    candidate = linked?.path ?? artifact.path.replace(/(^|[/\\])legacy([/\\])/, "$1modern$2");
  }

  return fs.existsSync(candidate) ? candidate : null;
}
