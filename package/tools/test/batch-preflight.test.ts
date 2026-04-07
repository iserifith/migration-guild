import assert from "node:assert/strict";
import test from "node:test";
import { validateBatchSupport } from "../foundry/batch/submit";
import type { FoundryConfig } from "../foundry/config";

const cfg: FoundryConfig = {
  openaiEndpoint: "https://example.openai.azure.com/openai/v1",
  projectEndpoint: "https://example.services.ai.azure.com/api/projects/demo",
  apiKey: "test-key",
  chatModel: "gpt-5.4-mini",
  embeddingModel: "text-embedding-ada-002",
  batchEnabled: true,
  providerType: "openai",
};

test("validateBatchSupport surfaces an actionable error for non-batch deployments", async () => {
  await assert.rejects(
    () =>
      validateBatchSupport(
        {
          uploadFile: async () => ({ id: "file-1" }),
          submitBatchJob: async () => {
            throw new Error(
              '[FoundryClient] HTTP 400 Bad Request: {"errors":{"data":[{"code":"invalid_deployment_type","message":"unsupported"}]}}',
            );
          },
          cancelBatchJob: async () => ({ id: "job-1", status: "cancelled", created_at: Date.now() }),
        },
        cfg,
        "inventory",
      ),
    /Foundry batch preflight failed for model "gpt-5.4-mini".*not batch-capable/,
  );
});

test("validateBatchSupport submits and cancels a tiny validation batch", async () => {
  const calls: string[] = [];

  await validateBatchSupport(
    {
      uploadFile: async (_content, filename) => {
        calls.push(`upload:${filename}`);
        return { id: "file-1" };
      },
      submitBatchJob: async (req) => {
        calls.push(`submit:${req.endpoint}`);
        return { id: "job-1", status: "validating", created_at: Date.now() };
      },
      cancelBatchJob: async (jobId) => {
        calls.push(`cancel:${jobId}`);
        return { id: jobId, status: "cancelled", created_at: Date.now() };
      },
    },
    cfg,
    "inventory",
  );

  assert.deepEqual(calls, [
    "upload:batch-preflight-inventory.jsonl",
    "submit:/chat/completions",
    "cancel:job-1",
  ]);
});
