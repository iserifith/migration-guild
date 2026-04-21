import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import type { AgentRunResult } from "../legmod/runner";
import { runRemediate } from "../legmod/commands/remediate";
import { applySchema } from "../registry/db/schema";
import { registerArtifact } from "../registry/commands/artifacts";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function registerFirstClassArtifact(db: Database.Database, id: string): void {
  registerArtifact(db, {
    id,
    kind: "legacy-source",
    path: `legacy/src/main/java/${id.replaceAll(":", "/")}.java`,
    tier: "first-class",
  });
}

function runResult(exitCode: number): AgentRunResult {
  return {
    runId: "remediate-run",
    agent: "remediation-agent",
    model: "test-model",
    prompt: "test prompt",
    logFile: "/tmp/legmod-remediate.log",
    exitCode,
  };
}

test("runRemediate spawns remediation-agent with targeted artifact prompt", async () => {
  const db = createDb();
  const seen: Array<{ agent: string; prompt: string }> = [];

  try {
    registerFirstClassArtifact(db, "legacy-source:com.acme.customer:CustomerKeyService");

    await runRemediate(
      db,
      { id: "legacy-source:com.acme.customer:CustomerKeyService" },
      {
        startPolling: () => () => undefined,
        getLogDir: () => "/tmp",
        spawnAgent: async ({ agent, prompt }) => {
          seen.push({ agent, prompt });
          return runResult(0);
        },
      },
    );

    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.agent, "remediation-agent");
    assert.match(seen[0]?.prompt ?? "", /Remediate artifact legacy-source:com\.acme\.customer:CustomerKeyService\./);
  } finally {
    db.close();
  }
});

test("runRemediate throws when remediation-agent exits non-zero", async () => {
  const db = createDb();

  try {
    registerFirstClassArtifact(db, "legacy-source:com.acme.customer:CustomerKeyService");

    await assert.rejects(
      () =>
        runRemediate(
          db,
          {},
          {
            startPolling: () => () => undefined,
            getLogDir: () => "/tmp",
            spawnAgent: async () => runResult(1),
          },
        ),
      /Remediation failed: 1 agent run\(s\) failed: remediation-agent exit=1/,
    );
  } finally {
    db.close();
  }
});
