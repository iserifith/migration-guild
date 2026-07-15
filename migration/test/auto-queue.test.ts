import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { runAutoQueue, type QueueArtifactExecutor } from "../guildctl/supervisor/queue";
import { runAutoRunCommand } from "../guildctl/commands/auto-run";
import { claimArtifactById } from "../registry/commands/claim";
import { registerArtifact, setArtifactStatus, setArtifactWave } from "../registry/commands/artifacts";
import { finishRun, startRun } from "../registry/commands/runs";
import { applySchema } from "../registry/db/schema";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function seed(db: Database.Database, name: string, wave = 1, status = "planned"): string {
  const id = `legacy-source:com.acme:${name}`;
  registerArtifact(db, {
    id,
    kind: "legacy-source",
    tier: "first-class",
    path: `legacy/${name}.java`,
  });
  setArtifactWave(db, id, wave);
  setArtifactStatus(db, id, status as Parameters<typeof setArtifactStatus>[2]);
  return id;
}

function depend(db: Database.Database, artifactId: string, dependsOnId: string): void {
  db.prepare(`
    INSERT INTO dependencies (artifact_id, depends_on_id, relation)
    VALUES (?, ?, 'part-of')
  `).run(artifactId, dependsOnId);
}

function completingExecutor(db: Database.Database, calls: Array<{ id: string; resume: boolean }>): QueueArtifactExecutor {
  return async ({ artifactId, resume }) => {
    calls.push({ id: artifactId, resume });
    setArtifactStatus(db, artifactId, "reviewed");
    return { status: "complete", runId: `run-${calls.length}`, attempts: 1 };
  };
}

test("auto queue processes dependency-ready artifacts sequentially in deterministic order", async () => {
  const db = createDb();
  try {
    const root = seed(db, "Root");
    const leaf = seed(db, "Leaf");
    depend(db, leaf, root);
    const calls: Array<{ id: string; resume: boolean }> = [];

    const result = await runAutoQueue(db, { executeArtifact: completingExecutor(db, calls) });

    assert.equal(result.status, "complete");
    assert.deepEqual(calls, [
      { id: root, resume: false },
      { id: leaf, resume: false },
    ]);
    assert.equal(result.completed, 2);
    assert.equal(result.blocked, 0);
    assert.equal(result.remaining.planned, 0);
  } finally {
    db.close();
  }
});

test("auto queue continues independent work after an artifact blocks and reports dependency wall", async () => {
  const db = createDb();
  try {
    const blockedRoot = seed(db, "BlockedRoot");
    const dependent = seed(db, "Dependent");
    const independent = seed(db, "Independent");
    depend(db, dependent, blockedRoot);
    const calls: string[] = [];

    const result = await runAutoQueue(db, {
      executeArtifact: async ({ artifactId }) => {
        calls.push(artifactId);
        if (artifactId === blockedRoot) {
          setArtifactStatus(db, artifactId, "blocked");
          return { status: "blocked", runId: "run-blocked", attempts: 3 };
        }
        setArtifactStatus(db, artifactId, "reviewed");
        return { status: "complete", runId: "run-independent", attempts: 1 };
      },
    });

    assert.deepEqual(calls, [blockedRoot, independent]);
    assert.equal(result.status, "partial");
    assert.equal(result.completed, 1);
    assert.equal(result.blocked, 1);
    assert.deepEqual(result.dependencyBlocked, [dependent]);
  } finally {
    db.close();
  }
});

test("migrated is not dependency-terminal; default queue resumes it before dependent dispatch", async () => {
  const db = createDb();
  try {
    const migrated = seed(db, "Migrated", 1, "migrated");
    const dependent = seed(db, "Dependent");
    depend(db, dependent, migrated);
    const calls: Array<{ id: string; resume: boolean }> = [];

    const explicitlyDisabled = await runAutoQueue(db, {
      resume: false,
      executeArtifact: completingExecutor(db, calls),
    });
    assert.equal(explicitlyDisabled.status, "stalled");
    assert.deepEqual(calls, []);
    assert.deepEqual(explicitlyDisabled.dependencyBlocked, [dependent]);

    const resumedByDefault = await runAutoQueue(db, {
      executeArtifact: completingExecutor(db, calls),
    });
    assert.equal(resumedByDefault.status, "complete");
    assert.deepEqual(calls, [
      { id: migrated, resume: true },
      { id: dependent, resume: false },
    ]);
  } finally {
    db.close();
  }
});

test("auto queue recovers a claim from a stopped run before selecting work", async () => {
  const db = createDb();
  try {
    const artifact = seed(db, "Recovered");
    const run = startRun(db, { runId: "dead-run", agent: "guildctl-auto", pid: null });
    claimArtifactById(db, {
      artifactId: artifact,
      agent: "code-writer-agent",
      ownerId: "guildctl-auto:Recovered",
      runId: run.run_id,
    });
    finishRun(db, { runId: run.run_id, exitCode: 1, reason: "simulated crash" });
    const calls: Array<{ id: string; resume: boolean }> = [];

    const result = await runAutoQueue(db, { executeArtifact: completingExecutor(db, calls) });

    assert.equal(result.status, "complete");
    assert.deepEqual(calls, [{ id: artifact, resume: false }]);
    assert.deepEqual(result.recoveredArtifacts, [artifact]);
    const active = db.prepare("SELECT COUNT(*) AS n FROM artifact_claims WHERE state = 'active'").get() as { n: number };
    assert.equal(active.n, 0);
  } finally {
    db.close();
  }
});

test("auto queue fails closed on an executor exception without burning the next artifact", async () => {
  const db = createDb();
  try {
    const first = seed(db, "First");
    seed(db, "Second");
    const calls: string[] = [];

    const result = await runAutoQueue(db, {
      executeArtifact: async ({ artifactId }) => {
        calls.push(artifactId);
        throw new Error("provider authentication unavailable");
      },
    });

    assert.equal(result.status, "failed");
    assert.deepEqual(calls, [first]);
    assert.match(result.error ?? "", /provider authentication unavailable/);
    assert.equal(result.remaining.planned, 2);
  } finally {
    db.close();
  }
});

test("auto queue stops immediately when the inner supervisor is cancelled", async () => {
  const db = createDb();
  try {
    const first = seed(db, "First");
    seed(db, "Second");
    const calls: string[] = [];

    const result = await runAutoQueue(db, {
      executeArtifact: async ({ artifactId }) => {
        calls.push(artifactId);
        return { status: "cancelled", runId: "run-cancelled", attempts: 0 };
      },
    });

    assert.equal(result.status, "cancelled");
    assert.deepEqual(calls, [first]);
    assert.equal(result.remaining.planned, 2);
  } finally {
    db.close();
  }
});

test("auto queue stops cleanly at an explicit artifact limit", async () => {
  const db = createDb();
  try {
    seed(db, "First");
    seed(db, "Second");
    const calls: Array<{ id: string; resume: boolean }> = [];

    const result = await runAutoQueue(db, {
      limit: 1,
      executeArtifact: completingExecutor(db, calls),
    });

    assert.equal(result.status, "limited");
    assert.equal(calls.length, 1);
    assert.equal(result.completed, 1);
    assert.equal(result.remaining.planned, 1);
  } finally {
    db.close();
  }
});

test("auto-run command delegates queue items with bounded options and emits one summary", async () => {
  const db = createDb();
  try {
    const first = seed(db, "First", 2);
    seed(db, "OtherWave", 3);
    const calls: Array<{ artifactId: string; resume: boolean }> = [];
    let output = "";

    const result = await runAutoRunCommand(db, {
      wave: 2,
      limit: 1,
      resume: true,
      maxAttempts: 2,
      command: ["npm test", "npm run build"],
      registryDbPath: "/tmp/external-registry.db",
      json: true,
      setExitCode: false,
    }, {
      executeArtifact: async (input) => {
        calls.push(input);
        setArtifactStatus(db, input.artifactId, "reviewed");
        return { status: "complete", runId: "run-first", attempts: 1 };
      },
      write: (text) => { output += text; },
    });

    assert.equal(result.status, "complete");
    assert.deepEqual(calls, [{ artifactId: first, resume: false }]);
    assert.equal((output.match(/\"status\"/g) ?? []).length, 2); // queue + processed result
    assert.equal(output.endsWith("\n"), true);
  } finally {
    db.close();
  }
});
