import * as fs from "fs";
import Database from "better-sqlite3";

import { FoundryClient } from "../foundry-client";
import type { FoundryConfig } from "../config";
import { resolveTokenLimit } from "../config";
import type { Artifact, BatchJob, BatchJobType } from "../../registry/types";
import { resolveTargetPath } from "./target-path";

function readArtifactFile(artifactPath: string): string | null {
  try {
    return fs.readFileSync(artifactPath, "utf-8");
  } catch {
    process.stderr.write(`[batch] Warning: could not read artifact file: ${artifactPath}\n`);
    return null;
  }
}

export function buildInventoryBatchInput(
  db: Database.Database,
  cfg: FoundryConfig,
  wave?: number,
): string {
  const artifacts =
    wave !== undefined
      ? (db
          .prepare(
            `SELECT * FROM artifacts WHERE status IN ('pending','analyzed') AND wave = ?`,
          )
          .all(wave) as Artifact[])
      : (db
          .prepare(`SELECT * FROM artifacts WHERE status IN ('pending','analyzed')`)
          .all() as Artifact[]);

  const lines: string[] = [];
  for (const artifact of artifacts) {
    const content = readArtifactFile(artifact.path);
    if (content === null) continue;

    lines.push(
      JSON.stringify({
        custom_id: artifact.id,
        method: "POST",
        url: "/chat/completions",
        body: {
          model: cfg.chatModel,
          messages: [
            { role: "system", content: "You are a Java code analyzer." },
            {
              role: "user",
              content: `Analyze this Java file. Return JSON: {framework, role, dependencies: string[]}.\n\n${content}`,
            },
          ],
          max_completion_tokens: resolveTokenLimit(cfg.chatModel, cfg),
        },
      }),
    );
  }

  return lines.join("\n");
}

/**
 * Selects artifacts that are ready to serve as reference corpus entries and
 * embeds their **target-side** content (files under `modern/`), not the
 * legacy source.
 *
 * Corpus eligibility:
 *   - `legacy-source` with status in ('migrated', 'reviewed', 'completed')
 *   - `target-source` / `test` with any non-terminal-negative status
 *
 * The target path for each artifact is resolved via {@link resolveTargetPath}.
 * Artifacts whose target file does not exist on disk are silently skipped.
 */
export function buildEmbedBatchInput(
  db: Database.Database,
  cfg: FoundryConfig,
): string {
  const artifacts = db
    .prepare(
      `SELECT * FROM artifacts
       WHERE (kind = 'legacy-source'  AND status IN ('migrated', 'reviewed', 'completed'))
          OR (kind IN ('target-source', 'test') AND status NOT IN ('pending', 'blocked', 'skipped'))`,
    )
    .all() as Artifact[];

  const lines: string[] = [];
  for (const artifact of artifacts) {
    const targetPath = resolveTargetPath(db, artifact);
    if (targetPath === null) continue;

    const content = readArtifactFile(targetPath);
    if (content === null) continue;

    lines.push(
      JSON.stringify({
        custom_id: artifact.id,
        method: "POST",
        url: "/embeddings",
        body: {
          model: cfg.embeddingModel,
          input: content.slice(0, 8000),
        },
      }),
    );
  }

  return lines.join("\n");
}

export async function submitBatch(
  db: Database.Database,
  client: FoundryClient,
  cfg: FoundryConfig,
  type: BatchJobType,
  wave?: number,
  artifactIds?: string[],
): Promise<BatchJob> {
  if (type === "evaluate") {
    throw new Error("[batch] 'evaluate' batch type must be handled separately");
  }

  const timestamp = Date.now();
  const endpoint: "/chat/completions" | "/embeddings" =
    type === "embed" ? "/embeddings" : "/chat/completions";

  let jsonl =
    type === "embed"
      ? buildEmbedBatchInput(db, cfg)
      : buildInventoryBatchInput(db, cfg, wave);

  // Filter to requested artifact IDs if specified
  if (artifactIds && artifactIds.length > 0) {
    const idSet = new Set(artifactIds);
    jsonl = jsonl
      .split("\n")
      .filter((line) => {
        if (!line.trim()) return false;
        try {
          return idSet.has((JSON.parse(line) as { custom_id: string }).custom_id);
        } catch {
          return false;
        }
      })
      .join("\n");
  }

  const usedArtifactIds = jsonl
    .split("\n")
    .filter((l) => l.trim())
    .map((line) => {
      try {
        return (JSON.parse(line) as { custom_id: string }).custom_id;
      } catch {
        return "";
      }
    })
    .filter(Boolean);

  const { id: inputFileId } = await client.uploadFile(
    jsonl,
    `batch-${type}-${timestamp}.jsonl`,
  );

  const batchResponse = await client.submitBatchJob({
    input_file_id: inputFileId,
    endpoint,
    completion_window: "24h",
  });

  db.prepare(
    `INSERT INTO batch_jobs (foundry_job_id, type, wave, artifact_ids)
     VALUES (?, ?, ?, ?)`,
  ).run(batchResponse.id, type, wave ?? null, JSON.stringify(usedArtifactIds));

  return db
    .prepare(`SELECT * FROM batch_jobs WHERE foundry_job_id = ?`)
    .get(batchResponse.id) as BatchJob;
}
