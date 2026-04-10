import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../foundry/config";

test("loadConfig rejects unsupported foundry phase override keys", () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "legmod-foundry-config-"));

  try {
    writeFileSync(
      path.join(workspace, "legmod.config.json"),
      JSON.stringify({
        llmProvider: "copilot",
        foundry: {
          openaiEndpoint: "https://example.openai.azure.com/openai/v1",
          projectEndpoint: "https://example.services.ai.azure.com/api/projects/demo",
          apiKey: "test-key",
          chatModel: "gpt-5.4-mini",
          embeddingModel: "text-embedding-ada-002",
          batchEnabled: false,
          providerType: "openai",
          phaseModels: {
            migration: "gpt-oss-120b",
          },
        },
      }),
    );

    assert.throws(
      () => loadConfig(workspace),
      /foundry\.phaseModels contains unsupported phase key\(s\): "migration"/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("loadConfig keeps supported migration phase overrides", () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "legmod-foundry-config-"));

  try {
    writeFileSync(
      path.join(workspace, "legmod.config.json"),
      JSON.stringify({
        llmProvider: "copilot",
        foundry: {
          openaiEndpoint: "https://example.openai.azure.com/openai/v1",
          projectEndpoint: "https://example.services.ai.azure.com/api/projects/demo",
          apiKey: "test-key",
          chatModel: "gpt-5.4-mini",
          embeddingModel: "text-embedding-ada-002",
          batchEnabled: false,
          providerType: "openai",
          phaseModels: {
            analysis: "gpt-5.4-mini",
            "test-writing": "gpt-5.4-mini",
            "code-writing": "gpt-oss-120b",
          },
          phaseProviders: {
            analysis: "foundry",
            "test-writing": "foundry",
            "code-writing": "foundry",
          },
        },
      }),
    );

    const config = loadConfig(workspace);
    assert.equal(config.foundry?.phaseModels?.analysis, "gpt-5.4-mini");
    assert.equal(config.foundry?.phaseModels?.["test-writing"], "gpt-5.4-mini");
    assert.equal(config.foundry?.phaseModels?.["code-writing"], "gpt-oss-120b");
    assert.equal(config.foundry?.phaseProviders?.analysis, "foundry");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
