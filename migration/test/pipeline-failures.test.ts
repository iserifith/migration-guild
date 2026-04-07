import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import type { AgentRunResult } from "../legmod/runner";
import { runMigrate } from "../legmod/commands/migrate";
import { runReview } from "../legmod/commands/review";
import { registerArtifact, setArtifactStatus } from "../registry/commands/artifacts";
import { applySchema } from "../registry/db/schema";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function registerFirstClassArtifact(
  db: Database.Database,
  id: string,
  status: "planned" | "migrated",
): void {
  registerArtifact(db, {
    id,
    kind: "legacy-source",
    path: `legacy/src/main/java/${id.replaceAll(":", "/")}.java`,
    tier: "first-class",
  });
  setArtifactStatus(db, id, status);
}

function failedRun(agent: string): AgentRunResult {
  return {
    runId: `${agent}-run`,
    agent,
    model: "test-model",
    prompt: "test prompt",
    logFile: "/tmp/legmod-test.log",
    exitCode: 1,
  };
}

test("runMigrate stops after analyzer failures without spawning later pools", async () => {
  const db = createDb();
  const agents: string[] = [];
  const originalCwd = process.cwd();
  const originalOpenAi = process.env["FOUNDRY_OPENAI_ENDPOINT"];
  const originalProject = process.env["FOUNDRY_PROJECT_ENDPOINT"];
  const originalApiKey = process.env["FOUNDRY_API_KEY"];

  try {
    process.chdir("/Users/seri/Workspace/legmod");
    process.env["FOUNDRY_OPENAI_ENDPOINT"] = "https://example.openai.azure.com/openai/v1";
    process.env["FOUNDRY_PROJECT_ENDPOINT"] = "https://example.services.ai.azure.com/api/projects/test";
    process.env["FOUNDRY_API_KEY"] = "test-key";

    registerFirstClassArtifact(db, "legacy-source:com.acme.customer:CustomerKeyService", "planned");

    await runMigrate(
      db,
      { testParallel: 1, codeParallel: 1 },
      {
        startPolling: () => () => undefined,
        getLogDir: () => "/tmp",
        needsBootstrap: () => false,
        spawnAgent: async ({ agent }) => {
          agents.push(agent);
          return failedRun(agent);
        },
      },
    );

    assert.deepEqual(agents, ["analyze-agent"]);
  } finally {
    process.chdir(originalCwd);
    if (originalOpenAi == null) delete process.env["FOUNDRY_OPENAI_ENDPOINT"];
    else process.env["FOUNDRY_OPENAI_ENDPOINT"] = originalOpenAi;
    if (originalProject == null) delete process.env["FOUNDRY_PROJECT_ENDPOINT"];
    else process.env["FOUNDRY_PROJECT_ENDPOINT"] = originalProject;
    if (originalApiKey == null) delete process.env["FOUNDRY_API_KEY"];
    else process.env["FOUNDRY_API_KEY"] = originalApiKey;
    db.close();
  }
});

test("runReview rejects when a review session exits non-zero", async () => {
  const db = createDb();

  try {
    registerFirstClassArtifact(db, "legacy-source:com.acme.customer:CustomerKeyService", "migrated");

    await assert.rejects(
      () =>
        runReview(
          db,
          { parallel: 1 },
          {
            startPolling: () => () => undefined,
            getLogDir: () => "/tmp",
            sleep: async () => undefined,
            spawnAgent: async () => failedRun("review-agent"),
          },
        ),
      /Review pool failed: 1 agent run\(s\) failed: review-agent exit=1/,
    );
  } finally {
    db.close();
  }
});
