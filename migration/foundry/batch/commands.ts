import Database from "better-sqlite3";
import { Command } from "commander";

import { FoundryClient } from "../foundry-client";
import type { FoundryConfig } from "../config";
import type { BatchJob, BatchJobType } from "../../registry/types";
import { submitBatch } from "./submit";
import { pollBatch, waitForBatch } from "./poll";
import { applyInventoryResults, applyEmbedResults } from "./apply";

async function applyJob(
  db: Database.Database,
  client: FoundryClient,
  job: BatchJob,
): Promise<void> {
  if (job.type === "embed") {
    await applyEmbedResults(db, client, job);
  } else {
    await applyInventoryResults(db, client, job);
  }
}

function loadJob(db: Database.Database, jobId: string): BatchJob {
  const job = db
    .prepare(`SELECT * FROM batch_jobs WHERE job_id = ?`)
    .get(jobId) as BatchJob | undefined;
  if (!job) {
    process.stderr.write(`[batch] Job not found: ${jobId}\n`);
    process.exit(2);
  }
  return job;
}

export function registerBatchCommands(
  program: Command,
  getDb: () => Database.Database,
  getClient: () => FoundryClient,
  getCfg: () => FoundryConfig,
): void {
  program
    .command("batch-submit")
    .description("Submit a batch inference job to Azure AI Foundry")
    .requiredOption(
      "--type <inventory|embed|evaluate>",
      "Batch job type (inventory, embed, or evaluate)",
    )
    .option("--wave <n>", "Filter artifacts by wave number", (v) =>
      parseInt(v, 10),
    )
    .action(async (opts: { type: string; wave?: number }) => {
      const db = getDb(); const client = getClient(); const cfg = getCfg();
      const type = opts.type as BatchJobType;
      const job = await submitBatch(db, client, cfg, type, opts.wave);
      process.stdout.write(
        `Submitted batch job: ${job.job_id} (foundry_job_id: ${job.foundry_job_id})\n`,
      );
    });

  program
    .command("batch-poll")
    .description("Poll the current status of a batch job")
    .requiredOption("--job-id <id>", "Local batch job ID")
    .action(async (opts: { jobId: string }) => {
      const db = getDb(); const client = getClient();
      const job = await pollBatch(db, client, opts.jobId);
      process.stdout.write(`Job ${job.job_id} status: ${job.status}\n`);
    });

  program
    .command("batch-apply")
    .description("Apply completed batch job results to the registry")
    .requiredOption("--job-id <id>", "Local batch job ID")
    .action(async (opts: { jobId: string }) => {
      const db = getDb(); const client = getClient();
      const job = loadJob(db, opts.jobId);
      await applyJob(db, client, job);
      process.stdout.write(`Applied results for job ${job.job_id} (type: ${job.type})\n`);
    });

  program
    .command("batch-wait")
    .description(
      "Wait for a batch job to complete, then automatically apply results",
    )
    .requiredOption("--job-id <id>", "Local batch job ID")
    .option(
      "--interval <ms>",
      "Poll interval in milliseconds (default: 10000)",
      (v) => parseInt(v, 10),
    )
    .option(
      "--timeout <ms>",
      "Maximum wait time in milliseconds (default: 3600000)",
      (v) => parseInt(v, 10),
    )
    .action(
      async (opts: { jobId: string; interval?: number; timeout?: number }) => {
        const db = getDb(); const client = getClient();
        process.stdout.write(`Waiting for job ${opts.jobId}...\n`);
        const job = await waitForBatch(db, client, opts.jobId, {
          intervalMs: opts.interval,
          timeoutMs: opts.timeout,
        });
        process.stdout.write(
          `Job ${job.job_id} completed with status: ${job.status}\n`,
        );
        if (job.status === "completed") {
          await applyJob(db, client, job);
          process.stdout.write(`Results applied for job ${job.job_id}\n`);
        } else {
          process.stderr.write(
            `[batch] Job ${job.job_id} ended with status '${job.status}', skipping apply\n`,
          );
        }
      },
    );
}
