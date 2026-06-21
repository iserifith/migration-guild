import Database from "better-sqlite3";

import { ProviderClient } from "../provider-client";
import type { BatchJob, BatchJobStatus } from "../../registry/types";

function mapProviderStatus(
  providerStatus: string,
): BatchJobStatus {
  switch (providerStatus) {
    case "completed":
      return "completed";
    case "failed":
    case "cancelled":
      return "failed";
    case "in_progress":
    case "finalizing":
      return "running";
    default:
      return "submitted";
  }
}

export async function pollBatch(
  db: Database.Database,
  client: ProviderClient,
  jobId: string,
): Promise<BatchJob> {
  const job = db
    .prepare(`SELECT * FROM batch_jobs WHERE job_id = ?`)
    .get(jobId) as BatchJob | undefined;
  if (!job) throw new Error(`[batch] Job not found: ${jobId}`);
  if (!job.provider_job_id)
    throw new Error(`[batch] Job has no provider_job_id: ${jobId}`);

  const response = await client.pollBatchJob(job.provider_job_id);
  const status = mapProviderStatus(response.status);
  const isDone = status === "completed" || status === "failed";

  if (isDone) {
    db.prepare(
      `UPDATE batch_jobs SET status = ?, completed_at = datetime('now') WHERE job_id = ?`,
    ).run(status, jobId);
  } else {
    db.prepare(`UPDATE batch_jobs SET status = ? WHERE job_id = ?`).run(
      status,
      jobId,
    );
  }

  return db
    .prepare(`SELECT * FROM batch_jobs WHERE job_id = ?`)
    .get(jobId) as BatchJob;
}

export async function waitForBatch(
  db: Database.Database,
  client: ProviderClient,
  jobId: string,
  opts: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<BatchJob> {
  const intervalMs = opts.intervalMs ?? 10_000;
  const timeoutMs = opts.timeoutMs ?? 3_600_000;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const job = await pollBatch(db, client, jobId);
    if (job.status === "completed" || job.status === "failed") {
      return job;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `[batch] Timeout waiting for job ${jobId} after ${timeoutMs}ms`,
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
}
