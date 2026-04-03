import type Database from "better-sqlite3";
import { cosineSimilarity } from "./foundry-client";
import type { FoundryClient } from "./foundry-client";

export interface SimilarArtifact {
  artifact_id: string;
  score: number;
  path: string | null;
  module: string | null;
  role: string | null;
  framework: string | null;
  status: string | null;
  kind: string | null;
}

export interface SearchSimilarOptions {
  /** Max results to return (default: 5). */
  topK?: number;
  /** Minimum cosine similarity to include in results (default: 0). */
  minScore?: number;
}

/**
 * Embed `query` with the Foundry embedding model and return the top-K most
 * similar artifacts from `artifact_embeddings`, joined with artifact metadata.
 *
 * Requires that `legmod batch --type embed` has been run at least once so that
 * the `artifact_embeddings` table is populated.
 */
export async function searchSimilar(
  db: Database.Database,
  client: FoundryClient,
  query: string,
  opts: SearchSimilarOptions = {},
): Promise<SimilarArtifact[]> {
  const topK = opts.topK ?? 5;
  const minScore = opts.minScore ?? 0;

  const queryVec = await client.embedOne(query);

  const rows = db
    .prepare(
      `SELECT ae.artifact_id, ae.embedding,
              a.path, a.module, a.role, a.framework, a.status, a.kind
       FROM artifact_embeddings ae
       LEFT JOIN artifacts a ON a.id = ae.artifact_id`,
    )
    .all() as Array<{
      artifact_id: string;
      embedding: string;
      path: string | null;
      module: string | null;
      role: string | null;
      framework: string | null;
      status: string | null;
      kind: string | null;
    }>;

  if (rows.length === 0) return [];

  const scored: SimilarArtifact[] = [];
  for (const row of rows) {
    let vec: number[];
    try {
      vec = JSON.parse(row.embedding) as number[];
    } catch {
      continue;
    }
    const score = cosineSimilarity(queryVec, vec);
    if (score >= minScore) {
      scored.push({
        artifact_id: row.artifact_id,
        score,
        path: row.path,
        module: row.module,
        role: row.role,
        framework: row.framework,
        status: row.status,
        kind: row.kind,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}
