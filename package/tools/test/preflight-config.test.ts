import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { runInventory } from "../legmod/commands/inventory";
import { applySchema } from "../registry/db/schema";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

test("runInventory fails preflight before scanning when Foundry batch is selected but unset", async () => {
  const db = createDb();
  const workspace = mkdtempSync(path.join(tmpdir(), "legmod-preflight-"));
  const originalCwd = process.cwd();
  const originalEnv = {
    FOUNDRY_OPENAI_ENDPOINT: process.env["FOUNDRY_OPENAI_ENDPOINT"],
    FOUNDRY_PROJECT_ENDPOINT: process.env["FOUNDRY_PROJECT_ENDPOINT"],
    FOUNDRY_API_KEY: process.env["FOUNDRY_API_KEY"],
  };

  try {
    writeFileSync(
      path.join(workspace, "legmod.config.json"),
      JSON.stringify({
        llmProvider: "copilot",
        foundry: {
          openaiEndpoint: "${FOUNDRY_OPENAI_ENDPOINT}",
          projectEndpoint: "${FOUNDRY_PROJECT_ENDPOINT}",
          apiKey: "${FOUNDRY_API_KEY}",
          chatModel: "gpt-5.4-mini",
          embeddingModel: "text-embedding-ada-002",
          batchEnabled: true,
          providerType: "openai",
          phaseProviders: {
            inventory: "foundry",
          },
        },
      }),
    );
    process.chdir(workspace);
    delete process.env["FOUNDRY_OPENAI_ENDPOINT"];
    delete process.env["FOUNDRY_PROJECT_ENDPOINT"];
    delete process.env["FOUNDRY_API_KEY"];

    await assert.rejects(
      () => runInventory(db),
      /Phase "inventory" is configured to use Foundry batch, but FOUNDRY_OPENAI_ENDPOINT, FOUNDRY_PROJECT_ENDPOINT, FOUNDRY_API_KEY are not set/,
    );

    const count = (db.prepare("SELECT COUNT(*) AS n FROM artifacts").get() as { n: number }).n;
    assert.equal(count, 0);
  } finally {
    process.chdir(originalCwd);
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(workspace, { recursive: true, force: true });
    db.close();
  }
});
