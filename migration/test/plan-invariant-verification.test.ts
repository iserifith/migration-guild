import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "path";
import test from "node:test";
import Database from "better-sqlite3";
import type { AgentRunResult } from "../guildctl/runner";
import { runPlan, PlanInvariantError } from "../guildctl/commands/plan";
import { registerArtifact, setArtifactWave } from "../registry/commands/artifacts";
import { createMapping } from "../registry/commands/mappings";
import { applySchema } from "../registry/db/schema";

const repoRoot = path.resolve(__dirname, "..", "..");

// TASK-01 tests inject a fake stack-advisor that writes mappings; the real
// confirmMappings() prompt reads from stdin, which would hang the runner.
// Auto-confirm (no stdin) so the phase proceeds to the planner.
process.env["GUILDCTL_AUTO_CONFIRM_MAPPINGS"] = "1";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function fixtureRoot(stack = "java-spring"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guild-plan-inv-"));
  fs.cpSync(path.join(repoRoot, "stacks"), path.join(root, "stacks"), { recursive: true });
  fs.mkdirSync(path.join(root, ".guild"), { recursive: true });
  fs.writeFileSync(path.join(root, ".guild", "config.yaml"), `version: 1\nstack: ${stack}\n`);
  return root;
}

function registerArtifacts(db: Database.Database, n: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `legacy-source:com.acme:Artifact${i}`;
    registerArtifact(db, {
      id,
      kind: "legacy-source",
      path: `legacy/src/main/java/com/acme/Artifact${i}.java`,
      tier: "first-class",
      module: "com.acme",
      role: "service",
      framework: "plain-java",
    });
    db.prepare(`
      INSERT INTO artifact_classifications (artifact_id, framework, role, confidence, ambiguous, evidence_json, signals_json)
      VALUES (?, 'plain-java', 'service', 0.85, 0, ?, '[]')
      ON CONFLICT(artifact_id) DO NOTHING
    `).run(id, JSON.stringify(["negative-evidence: no configured framework signal matched"]));
    ids.push(id);
  }
  return ids;
}

function success(agent: string): AgentRunResult {
  return { runId: `${agent}-run`, agent, model: "test-model", prompt: "p", logFile: "/tmp/x.log", exitCode: 0 };
}

async function expectInvariantFailure(fn: () => Promise<void>): Promise<PlanInvariantError> {
  try {
    await fn();
    throw new Error("expected a PlanInvariantError to be thrown");
  } catch (error) {
    assert.ok(error instanceof PlanInvariantError, `expected PlanInvariantError, got ${error}`);
    return error;
  }
}

const auditSummary = {
  artifact_count: 1,
  jvm: { critical: 0, warnings: 0 },
  dependencies: { total: 0, unresolved: 0 },
  tools: [],
};

test("plan invariant OFF (default): exit-0 agent that writes nothing still passes (back-compat)", async () => {
  const db = createDb();
  const root = fixtureRoot();
  registerArtifacts(db, 10);
  try {
    await runPlan(db, {
      workspaceRoot: root,
      refreshCompatibilityAudits: () => auditSummary,
      startPolling: () => () => undefined,
      getLogDir: () => "/tmp",
      spawnAgent: async ({ agent }) => success(agent),
    });
    const nullWave = (db.prepare("SELECT COUNT(*) c FROM artifacts WHERE wave IS NULL").get() as { c: number }).c;
    assert.equal(nullWave, 10, "without enforcement, no waves are required");
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("planner exit-0 with no waves -> phase fails with NULL-wave count, no success checkmark", async () => {
  const db = createDb();
  const root = fixtureRoot();
  registerArtifacts(db, 10);
  const agents: string[] = [];
  try {
    const err = await expectInvariantFailure(() =>
      runPlan(db, {
        workspaceRoot: root,
        enforceInvariants: true,
        retries: 0,
        refreshCompatibilityAudits: () => auditSummary,
        startPolling: () => () => undefined,
        getLogDir: () => "/tmp",
        spawnAgent: async ({ agent }) => {
          agents.push(agent);
          if (agent === "stack-advisor") {
            createMapping(db, { legacy_framework: "javax.servlet", target_framework: "jakarta.servlet", strategy: "rewrite", notes: "auto-detected" });
          }
          return success(agent);
        },
      }),
    );
    assert.match(err.message, /10\/10 artifacts still have wave = NULL/);
    const nullWave = (db.prepare("SELECT COUNT(*) c FROM artifacts WHERE wave IS NULL").get() as { c: number }).c;
    assert.equal(nullWave, 10, "still 10 NULL-wave artifacts");
    assert.ok(agents.includes("planner-agent"));
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("planner assigns all waves -> phase succeeds", async () => {
  const db = createDb();
  const root = fixtureRoot();
  const ids = registerArtifacts(db, 10);
  const agents: string[] = [];
  try {
    await runPlan(db, {
      workspaceRoot: root,
      enforceInvariants: true,
      retries: 0,
      refreshCompatibilityAudits: () => auditSummary,
      startPolling: () => () => undefined,
      getLogDir: () => "/tmp",
      spawnAgent: async ({ agent }) => {
        agents.push(agent);
        if (agent === "stack-advisor") {
          createMapping(db, { legacy_framework: "javax.servlet", target_framework: "jakarta.servlet", strategy: "rewrite", notes: "auto-detected" });
        } else if (agent === "planner-agent") {
          ids.forEach((id, i) => setArtifactWave(db, id, (i % 3) + 1));
        }
        return success(agent);
      },
    });
    const nullWave = (db.prepare("SELECT COUNT(*) c FROM artifacts WHERE wave IS NULL").get() as { c: number }).c;
    assert.equal(nullWave, 0, "all artifacts assigned a wave");
    assert.deepEqual(agents, ["stack-advisor", "planner-agent"]);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("planner assigns half -> partial reported, exits non-zero with exact counts", async () => {
  const db = createDb();
  const root = fixtureRoot();
  const ids = registerArtifacts(db, 10);
  try {
    const err = await expectInvariantFailure(() =>
      runPlan(db, {
        workspaceRoot: root,
        enforceInvariants: true,
        retries: 0,
        refreshCompatibilityAudits: () => auditSummary,
        startPolling: () => () => undefined,
        getLogDir: () => "/tmp",
        spawnAgent: async ({ agent }) => {
          if (agent === "stack-advisor") {
            createMapping(db, { legacy_framework: "javax.servlet", target_framework: "jakarta.servlet", strategy: "rewrite", notes: "auto-detected" });
          } else if (agent === "planner-agent") {
            ids.slice(0, 5).forEach((id, i) => setArtifactWave(db, id, (i % 3) + 1));
          }
          return success(agent);
        },
      }),
    );
    assert.match(err.message, /5\/10 artifacts still have wave = NULL/);
    const nullWave = (db.prepare("SELECT COUNT(*) c FROM artifacts WHERE wave IS NULL").get() as { c: number }).c;
    assert.equal(nullWave, 5, "exactly 5 remain unassigned");
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("stack-advisor writes 0 mappings on non-empty inventory -> phase fails", async () => {
  const db = createDb();
  const root = fixtureRoot();
  registerArtifacts(db, 10);
  const agents: string[] = [];
  try {
    await expectInvariantFailure(() =>
      runPlan(db, {
        workspaceRoot: root,
        enforceInvariants: true,
        retries: 0,
        refreshCompatibilityAudits: () => auditSummary,
        startPolling: () => () => undefined,
        getLogDir: () => "/tmp",
        spawnAgent: async ({ agent }) => {
          agents.push(agent);
          return success(agent);
        },
      }),
    );
    // stack-advisor failed before the planner even ran
    assert.deepEqual(agents, ["stack-advisor"]);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("stack-advisor writes a mapping -> passes; planner then verified", async () => {
  const db = createDb();
  const root = fixtureRoot();
  const ids = registerArtifacts(db, 10);
  const agents: string[] = [];
  try {
    await runPlan(db, {
      workspaceRoot: root,
      enforceInvariants: true,
      retries: 0,
      refreshCompatibilityAudits: () => auditSummary,
      startPolling: () => () => undefined,
      getLogDir: () => "/tmp",
      spawnAgent: async ({ agent }) => {
        agents.push(agent);
        if (agent === "stack-advisor") {
          createMapping(db, { legacy_framework: "javax.servlet", target_framework: "jakarta.servlet", strategy: "rewrite", notes: "auto-detected" });
        } else if (agent === "planner-agent") {
          ids.forEach((id, i) => setArtifactWave(db, id, (i % 3) + 1));
        }
        return success(agent);
      },
    });
    assert.deepEqual(agents, ["stack-advisor", "planner-agent"]);
    const maps = (db.prepare("SELECT COUNT(*) c FROM stack_mappings").get() as { c: number }).c;
    assert.equal(maps, 1);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("existing stack mappings are reused without rerunning stack-advisor", async () => {
  const db = createDb();
  const root = fixtureRoot();
  const ids = registerArtifacts(db, 10);
  createMapping(db, {
    legacy_framework: "javax.servlet",
    target_framework: "jakarta.servlet",
    strategy: "rewrite",
    notes: "already reviewed",
  });
  const agents: string[] = [];
  try {
    await runPlan(db, {
      workspaceRoot: root,
      enforceInvariants: true,
      retries: 1,
      refreshCompatibilityAudits: () => auditSummary,
      startPolling: () => () => undefined,
      getLogDir: () => "/tmp",
      spawnAgent: async ({ agent }) => {
        agents.push(agent);
        if (agent === "planner-agent") {
          ids.forEach((id, i) => setArtifactWave(db, id, (i % 3) + 1));
        }
        return success(agent);
      },
    });
    assert.deepEqual(agents, ["planner-agent"]);
    const verification = JSON.parse(
      (db.prepare("SELECT value FROM operator_state WHERE key = 'plan_verification_stack-advisor'").get() as { value: string }).value,
    ) as { invariantPassed: boolean; message: string };
    assert.equal(verification.invariantPassed, true);
    assert.match(verification.message, /reused 1 existing stack_mapping/);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("with --retries 1, the second planner attempt receives the invariant-failure context", async () => {
  const db = createDb();
  const root = fixtureRoot();
  const ids = registerArtifacts(db, 10);
  let plannerCall = 0;
  let secondPromptHadContext = false;
  try {
    await runPlan(db, {
      workspaceRoot: root,
      enforceInvariants: true,
      retries: 1,
      refreshCompatibilityAudits: () => auditSummary,
      startPolling: () => () => undefined,
      getLogDir: () => "/tmp",
      spawnAgent: async ({ agent, prompt }) => {
        if (agent === "planner-agent") {
          plannerCall += 1;
          if (plannerCall === 2 && /PREVIOUS ATTEMPT FAILED/.test(prompt)) {
            secondPromptHadContext = true;
            ids.forEach((id, i) => setArtifactWave(db, id, (i % 3) + 1));
          }
        } else if (agent === "stack-advisor") {
          createMapping(db, { legacy_framework: "javax.servlet", target_framework: "jakarta.servlet", strategy: "rewrite", notes: "auto-detected" });
        }
        return success(agent);
      },
    });
    assert.equal(plannerCall, 2, "planner should have been retried once");
    assert.equal(secondPromptHadContext, true, "retry prompt must include invariant-failure context");
    const nullWave = (db.prepare("SELECT COUNT(*) c FROM artifacts WHERE wave IS NULL").get() as { c: number }).c;
    assert.equal(nullWave, 0);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("verification result is recorded in operator_state for doctor (TASK-08)", async () => {
  const db = createDb();
  const root = fixtureRoot();
  registerArtifacts(db, 10);
  try {
    await expectInvariantFailure(() =>
      runPlan(db, {
        workspaceRoot: root,
        enforceInvariants: true,
        retries: 0,
        refreshCompatibilityAudits: () => auditSummary,
        startPolling: () => () => undefined,
        getLogDir: () => "/tmp",
        spawnAgent: async ({ agent }) => {
          if (agent === "stack-advisor") {
            createMapping(db, { legacy_framework: "javax.servlet", target_framework: "jakarta.servlet", strategy: "rewrite", notes: "auto-detected" });
          }
          return success(agent);
        },
      }),
    );
    const rec = db
      .prepare("SELECT value FROM operator_state WHERE key = 'plan_verification_planner'")
      .get() as { value: string } | undefined;
    assert.ok(rec, "verification record written");
    const parsed = JSON.parse(rec!.value) as { invariantPassed: boolean; agentExited: number };
    assert.equal(parsed.invariantPassed, false, "recorded as failed");
    assert.equal(parsed.agentExited, 0, "agent exited 0 (hallucination)");
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
