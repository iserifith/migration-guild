import * as fs from "fs";
import * as path from "path";
import Database from "better-sqlite3";

import { FoundryClient } from "../foundry-client";
import type { BatchJob, Artifact } from "../../registry/types";
import { resolveTargetPath } from "./target-path";

interface InventoryResult {
  framework: string | null;
  role: string | null;
  dependencies: string[];
}

async function downloadOutputFile(
  client: FoundryClient,
  job: BatchJob,
): Promise<string> {
  if (!job.foundry_job_id)
    throw new Error(`[batch] Job has no foundry_job_id: ${job.job_id}`);

  // Poll to get the output_file_id from the completed batch
  const batchStatus = await client.pollBatchJob(job.foundry_job_id);
  if (!batchStatus.output_file_id) {
    throw new Error(
      `[batch] No output_file_id for job ${job.job_id} (status: ${batchStatus.status})`,
    );
  }
  return client.downloadFile(batchStatus.output_file_id);
}

function writeResultFile(jobId: string, jsonl: string): string {
  const resultDir = path.resolve(process.cwd(), "migration", "batch-results");
  fs.mkdirSync(resultDir, { recursive: true });
  const resultPath = path.join(resultDir, `${jobId}.jsonl`);
  fs.writeFileSync(resultPath, jsonl, "utf-8");
  return resultPath;
}

export async function applyInventoryResults(
  db: Database.Database,
  client: FoundryClient,
  job: BatchJob,
): Promise<void> {
  const jsonl = await downloadOutputFile(client, job);
  const lines = jsonl.split("\n").filter((l) => l.trim());

  let processed = 0;
  let failed = 0;

  const updateArtifact = db.prepare(
    `UPDATE artifacts SET framework = ?, role = ?, status = 'analyzed' WHERE id = ?`,
  );
  const findArtifact = db.prepare(
    `SELECT id FROM artifacts WHERE id = ?`,
  );
  const insertDep = db.prepare(
    `INSERT OR IGNORE INTO artifacts (id, slug, kind, tier, path, status)
     VALUES (?, ?, ?, 'second-class', '', 'pending')`,
  );

  for (const line of lines) {
    let parsed: {
      custom_id: string;
      response: { body: { choices: Array<{ message: { content: string } }> } };
    };
    try {
      parsed = JSON.parse(line);
    } catch {
      process.stderr.write(`[batch] Warning: could not parse result line\n`);
      failed++;
      continue;
    }

    const artifactId = parsed.custom_id;
    const content = parsed.response?.body?.choices?.[0]?.message?.content;
    if (!content) {
      process.stderr.write(
        `[batch] Warning: no content for artifact ${artifactId}\n`,
      );
      failed++;
      continue;
    }

    let result: InventoryResult;
    try {
      result = JSON.parse(content) as InventoryResult;
    } catch {
      process.stderr.write(
        `[batch] Warning: could not parse JSON content for artifact ${artifactId}\n`,
      );
      failed++;
      continue;
    }

    updateArtifact.run(result.framework ?? null, result.role ?? null, artifactId);

    for (const dep of result.dependencies ?? []) {
      if (findArtifact.get(dep)) continue;
      const kind =
        /\.(xml|yaml|yml)$/i.test(dep) ? "descriptor" : "config";
      const slug = dep.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase();
      insertDep.run(dep, slug, kind);
    }

    processed++;
  }

  const resultPath = writeResultFile(job.job_id, jsonl);
  db.prepare(
    `UPDATE batch_jobs SET result_path = ? WHERE job_id = ?`,
  ).run(resultPath, job.job_id);

  process.stdout.write(
    `[batch] applyInventoryResults: ${processed} processed, ${failed} failed\n`,
  );
}

export async function applyEmbedResults(
  db: Database.Database,
  client: FoundryClient,
  job: BatchJob,
): Promise<void> {
  db.exec(`
    CREATE TABLE IF NOT EXISTS artifact_embeddings (
      artifact_id TEXT PRIMARY KEY,
      model       TEXT,
      embedding   TEXT NOT NULL,
      target_path TEXT,
      embedded_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  // Migration for existing tables created without target_path.
  try {
    db.exec(`ALTER TABLE artifact_embeddings ADD COLUMN target_path TEXT`);
  } catch {
    // Column already exists — safe to ignore.
  }

  const jsonl = await downloadOutputFile(client, job);
  const lines = jsonl.split("\n").filter((l) => l.trim());

  let processed = 0;
  let failed = 0;

  const upsert = db.prepare(
    `INSERT OR REPLACE INTO artifact_embeddings (artifact_id, model, embedding, target_path)
     VALUES (?, ?, ?, ?)`,
  );

  for (const line of lines) {
    let parsed: {
      custom_id: string;
      response: { body: { data: Array<{ embedding: number[] }>; model: string } };
    };
    try {
      parsed = JSON.parse(line);
    } catch {
      process.stderr.write(`[batch] Warning: could not parse result line\n`);
      failed++;
      continue;
    }

    const artifactId = parsed.custom_id;
    const embeddingData = parsed.response?.body?.data?.[0]?.embedding;
    const model = parsed.response?.body?.model ?? "unknown";

    if (!embeddingData) {
      process.stderr.write(
        `[batch] Warning: no embedding data for artifact ${artifactId}\n`,
      );
      failed++;
      continue;
    }

    const artifact = db.prepare("SELECT * FROM artifacts WHERE id = ?").get(artifactId) as Artifact | undefined;
    const targetPath = artifact ? resolveTargetPath(db, artifact) : null;

    upsert.run(artifactId, model, JSON.stringify(embeddingData), targetPath);
    processed++;
  }

  const resultPath = writeResultFile(job.job_id, jsonl);
  db.prepare(
    `UPDATE batch_jobs SET result_path = ? WHERE job_id = ?`,
  ).run(resultPath, job.job_id);

  process.stdout.write(
    `[batch] applyEmbedResults: ${processed} processed, ${failed} failed\n`,
  );
}
