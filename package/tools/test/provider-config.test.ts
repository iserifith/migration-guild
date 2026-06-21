import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../provider/config";

test("loadConfig rejects unsupported provider phase override keys", () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "guildctl-provider-config-"));

  try {
    writeFileSync(
      path.join(workspace, "guildctl.config.json"),
      JSON.stringify({
        llmProvider: "agent",
        provider: {
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
      /provider\.phaseModels contains unsupported phase key\(s\): "migration"/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("loadConfig keeps supported migration phase overrides", () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "guildctl-provider-config-"));

  try {
    writeFileSync(
      path.join(workspace, "guildctl.config.json"),
      JSON.stringify({
        llmProvider: "agent",
        provider: {
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
            analysis: "provider",
            "test-writing": "provider",
            "code-writing": "provider",
          },
        },
      }),
    );

    const config = loadConfig(workspace);
    assert.equal(config.provider?.phaseModels?.analysis, "gpt-5.4-mini");
    assert.equal(config.provider?.phaseModels?.["test-writing"], "gpt-5.4-mini");
    assert.equal(config.provider?.phaseModels?.["code-writing"], "gpt-oss-120b");
    assert.equal(config.provider?.phaseProviders?.analysis, "provider");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
