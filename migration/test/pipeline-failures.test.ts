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

test("runMigrate rejects when a test-writer session exits non-zero", async () => {
  const db = createDb();
  const agents: string[] = [];

  try {
    registerFirstClassArtifact(db, "legacy-source:com.acme.customer:CustomerKeyService", "planned");

    await assert.rejects(
      () =>
        runMigrate(
          db,
          { testParallel: 1, codeParallel: 1 },
          {
            startPolling: () => () => undefined,
            getLogDir: () => "/tmp",
            spawnAgent: async ({ agent }) => {
              agents.push(agent);
              return failedRun(agent);
            },
          },
        ),
      /Test-writer pool failed: 1 agent run\(s\) failed: test-writer-agent exit=1/,
    );

    assert.deepEqual(agents, ["test-writer-agent"]);
  } finally {
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
