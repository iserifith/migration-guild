import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "path";
import test from "node:test";
import Database from "better-sqlite3";
import type { AgentRunResult } from "../guildctl/runner";
import { runInventory } from "../guildctl/commands/inventory";
import { loadClassificationSpec, applyBatchClassification } from "../guildctl/classification";
import { loadStackPack } from "../guildctl/stack";
import { registerArtifact } from "../registry/commands/artifacts";
import { applySchema } from "../registry/db/schema";

const repoRoot = path.resolve(__dirname, "..", "..");

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function fixtureRoot(stack = "java-spring"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guild-batch-"));
  fs.cpSync(path.join(repoRoot, "stacks"), path.join(root, "stacks"), { recursive: true });
  fs.mkdirSync(path.join(root, ".guild"), { recursive: true });
  fs.writeFileSync(path.join(root, ".guild", "config.yaml"), `version: 1
stack: ${stack}
inventory:
  classificationBatchSize: 100
  maxBatchRetries: 2
`);
  return root;
}

function registerN(db: Database.Database, n: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `legacy-source:com.acme:Artifact${i}`;
    registerArtifact(db, { id, kind: "legacy-source", tier: "first-class", path: `legacy/src/main/java/com/acme/Artifact${i}.java` });
    ids.push(id);
  }
  return ids;
}

function parseBatchIds(prompt: string): string[] {
  const m = prompt.match(/Batch artifact IDs \((\d+)\):\n([\s\S]*?)\n\nClassification contract/);
  if (!m) return [];
  return m[2].split("\n").filter(Boolean);
}

function markComplete(db: Database.Database): void {
  db.prepare("INSERT OR REPLACE INTO operator_state (key, value) VALUES ('inventory_completion', ?)").run(
    JSON.stringify({ status: "completed" }),
  );
}

const auditSummary = { artifact_count: 1, jvm: { critical: 0, warnings: 0 }, dependencies: { total: 0, unresolved: 0 }, tools: [] };

// A fake agent that classifies exactly the IDs in the batch it was given.
function makeClassifyingAgent(db: Database.Database, spec: ReturnType<typeof loadClassificationSpec>) {
  return async ({ agent, prompt }: { agent: string; prompt: string }): Promise<AgentRunResult> => {
    const ids = parseBatchIds(prompt);
    const records = ids.map((id) => ({
      id,
      module: "com.acme",
      role: "service" as const,
      framework: "plain-java",
      confidence: 0.85,
      evidence: ["negative-evidence: no configured framework signal matched"],
    }));
    applyBatchClassification(db, spec, records);
    markComplete(db);
    return { runId: `${agent}-run`, agent, model: "m", prompt, logFile: "/tmp/x", exitCode: 0 };
  };
}

test("happy path: multiple batches, all persisted", async () => {
  const db = createDb();
  const root = fixtureRoot();
  const spec = loadClassificationSpec(loadStackPack("java-spring", root));
  const ids = registerN(db, 250);
  const calls: string[][] = [];
  try {
    await runInventory(db, root, {
      scanAndRegister: () => 0,
      startPolling: () => () => undefined,
      refreshCompatibilityAudits: () => auditSummary,
      spawnAgent: async ({ agent, prompt }): Promise<AgentRunResult> => {
        const b = parseBatchIds(prompt);
        calls.push(b);
        const records = b.map((id) => ({ id, module: "com.acme", role: "service" as const, framework: "plain-java", confidence: 0.85, evidence: ["negative-evidence: x"] }));
        applyBatchClassification(db, spec, records);
        markComplete(db);
        return { runId: `${agent}-run`, agent, model: "m", prompt, logFile: "/tmp/x", exitCode: 0 };
      },
    });
    const classified = (db.prepare("SELECT COUNT(*) c FROM artifact_classifications").get() as { c: number }).c;
    assert.equal(classified, 250, "all 250 classified");
    assert.equal(calls.length, 3, "250 in batches of 100 -> 3 agent calls");
    assert.equal(calls[0].length, 100);
    assert.equal(calls[2].length, 50);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("3000 artifacts: no single agent call covers all (batched)", async () => {
  const db = createDb();
  const root = fixtureRoot();
  const spec = loadClassificationSpec(loadStackPack("java-spring", root));
  registerN(db, 3000);
  const maxPerCall = { n: 0 };
  try {
    await runInventory(db, root, {
      scanAndRegister: () => 0,
      startPolling: () => () => undefined,
      refreshCompatibilityAudits: () => auditSummary,
      spawnAgent: async ({ agent, prompt }): Promise<AgentRunResult> => {
        const b = parseBatchIds(prompt);
        maxPerCall.n = Math.max(maxPerCall.n, b.length);
        const records = b.map((id) => ({ id, module: "com.acme", role: "service" as const, framework: "plain-java", confidence: 0.85, evidence: ["negative-evidence: x"] }));
        applyBatchClassification(db, spec, records);
        markComplete(db);
        return { runId: `${agent}-run`, agent, model: "m", prompt, logFile: "/tmp/x", exitCode: 0 };
      },
    });
    assert.equal(maxPerCall.n, 100, "no call exceeds batch size 100");
    const classified = (db.prepare("SELECT COUNT(*) c FROM artifact_classifications").get() as { c: number }).c;
    assert.equal(classified, 3000);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("mid-run timeout: partial persisted, failed batch not silently dropped, resume completes", async () => {
  const db = createDb();
  const root = fixtureRoot();
  const spec = loadClassificationSpec(loadStackPack("java-spring", root));
  registerN(db, 400);
  const failBatchIndex = 2; // 0-based: batch 3 of 4
  try {
    // First run: batches 1,2,4 succeed; batch 3 (index 2) times out every attempt.
    await assert.rejects(() =>
      runInventory(db, root, {
        scanAndRegister: () => 0,
        startPolling: () => () => undefined,
        refreshCompatibilityAudits: () => auditSummary,
        spawnAgent: async ({ agent, prompt }): Promise<AgentRunResult> => {
          const b = parseBatchIds(prompt);
          const idx = Math.floor(Number(b[0].split("Artifact")[1]) / 100);
          if (idx === failBatchIndex) {
            return { runId: `${agent}-run`, agent, model: "m", prompt, logFile: "/tmp/x", exitCode: 124 };
          }
          const records = b.map((id) => ({ id, module: "com.acme", role: "service" as const, framework: "plain-java", confidence: 0.85, evidence: ["negative-evidence: x"] }));
          applyBatchClassification(db, spec, records);
          markComplete(db);
          return { runId: `${agent}-run`, agent, model: "m", prompt, logFile: "/tmp/x", exitCode: 0 };
        },
      }),
    );
    const afterFirst = (db.prepare("SELECT COUNT(*) c FROM artifact_classifications").get() as { c: number }).c;
    assert.equal(afterFirst, 300, "batches 1,2,4 persisted (300); batch 3 lost only for itself");

    // Resume: only the 100 unclassified artifacts are re-sent.
    let resumedCallCount = 0;
    await runInventory(db, root, {
      scanAndRegister: () => 0,
      startPolling: () => () => undefined,
      refreshCompatibilityAudits: () => auditSummary,
      spawnAgent: async ({ agent, prompt }): Promise<AgentRunResult> => {
        const b = parseBatchIds(prompt);
        resumedCallCount += 1;
        const records = b.map((id) => ({ id, module: "com.acme", role: "service" as const, framework: "plain-java", confidence: 0.85, evidence: ["negative-evidence: x"] }));
        applyBatchClassification(db, spec, records);
        markComplete(db);
        return { runId: `${agent}-run`, agent, model: "m", prompt, logFile: "/tmp/x", exitCode: 0 };
      },
    });
    assert.equal(resumedCallCount, 1, "resume sends only the 1 remaining batch");
    const final = (db.prepare("SELECT COUNT(*) c FROM artifact_classifications").get() as { c: number }).c;
    assert.equal(final, 400, "all 400 classified after resume");
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("batch retry exhaustion: phase continues, correct counts, non-zero exit", async () => {
  const db = createDb();
  const root = fixtureRoot();
  const spec = loadClassificationSpec(loadStackPack("java-spring", root));
  registerN(db, 400);
  const failBatchIndex = 0;
  const callLog: number[] = []; // batch index per agent call
  try {
    await assert.rejects(() =>
      runInventory(db, root, {
        scanAndRegister: () => 0,
        startPolling: () => () => undefined,
        refreshCompatibilityAudits: () => auditSummary,
        spawnAgent: async ({ agent, prompt }): Promise<AgentRunResult> => {
          const b = parseBatchIds(prompt);
          const idx = Math.floor(Number(b[0].split("Artifact")[1]) / 100);
          callLog.push(idx);
          if (idx === failBatchIndex) {
            return { runId: `${agent}-run`, agent, model: "m", prompt, logFile: "/tmp/x", exitCode: 124 };
          }
          const records = b.map((id) => ({ id, module: "com.acme", role: "service" as const, framework: "plain-java", confidence: 0.85, evidence: ["negative-evidence: x"] }));
          applyBatchClassification(db, spec, records);
          markComplete(db);
          return { runId: `${agent}-run`, agent, model: "m", prompt, logFile: "/tmp/x", exitCode: 0 };
        },
      }),
    );
    // batch 0: 1 initial + 2 retries = 3 calls; batches 1,2,3: 1 each => 6 total
    assert.equal(callLog.length, 6, `expected 3 retries for batch0 + 1 each for 1,2,3 = 6, got ${callLog.length}`);
    const failedCount = callLog.filter((i) => i === failBatchIndex).length;
    assert.equal(failedCount, 3, "batch 0 retried to exhaustion (3 calls)");
    const classified = (db.prepare("SELECT COUNT(*) c FROM artifact_classifications").get() as { c: number }).c;
    assert.equal(classified, 300, "other 3 batches still persisted");
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("idempotent re-run on fully classified repo is a no-op", async () => {
  const db = createDb();
  const root = fixtureRoot();
  const spec = loadClassificationSpec(loadStackPack("java-spring", root));
  const ids = registerN(db, 50);
  try {
    // initial full classification
    await runInventory(db, root, {
      scanAndRegister: () => 0,
      startPolling: () => () => undefined,
      refreshCompatibilityAudits: () => auditSummary,
      spawnAgent: makeClassifyingAgent(db, spec),
    });
    let calls = 0;
    await runInventory(db, root, {
      scanAndRegister: () => 0,
      startPolling: () => () => undefined,
      refreshCompatibilityAudits: () => auditSummary,
      spawnAgent: async (): Promise<AgentRunResult> => {
        calls += 1;
        return { runId: "r", agent: "context-agent", model: "m", prompt: "p", logFile: "/tmp/x", exitCode: 0 };
      },
    });
    assert.equal(calls, 0, "no agent calls when everything is already classified");
    const classified = (db.prepare("SELECT COUNT(*) c FROM artifact_classifications").get() as { c: number }).c;
    assert.equal(classified, 50);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("batch size 1 edge case: each artifact is its own agent call", async () => {
  const db = createDb();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guild-bs1-"));
  fs.cpSync(path.join(repoRoot, "stacks"), path.join(root, "stacks"), { recursive: true });
  fs.mkdirSync(path.join(root, ".guild"), { recursive: true });
  fs.writeFileSync(path.join(root, ".guild", "config.yaml"), `version: 1
stack: java-spring
inventory:
  classificationBatchSize: 1
  maxBatchRetries: 2
`);
  const spec = loadClassificationSpec(loadStackPack("java-spring", root));
  registerN(db, 3);
  let calls = 0;
  try {
    await runInventory(db, root, {
      scanAndRegister: () => 0,
      startPolling: () => () => undefined,
      refreshCompatibilityAudits: () => auditSummary,
      spawnAgent: async ({ agent, prompt }): Promise<AgentRunResult> => {
        calls += 1;
        const b = parseBatchIds(prompt);
        assert.equal(b.length, 1, "batch size 1 -> exactly 1 artifact per call");
        const records = b.map((id) => ({ id, module: "com.acme", role: "service" as const, framework: "plain-java", confidence: 0.85, evidence: ["negative-evidence: x"] }));
        applyBatchClassification(db, spec, records);
        markComplete(db);
        return { runId: `${agent}-run`, agent, model: "m", prompt, logFile: "/tmp/x", exitCode: 0 };
      },
    });
    assert.equal(calls, 3, "3 artifacts -> 3 single-artifact calls");
    const classified = (db.prepare("SELECT COUNT(*) c FROM artifact_classifications").get() as { c: number }).c;
    assert.equal(classified, 3);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
