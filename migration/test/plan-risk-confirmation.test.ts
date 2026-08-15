import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import type { AgentRunResult } from "../guildctl/runner";
import { runPlan } from "../guildctl/commands/plan";
import { registerArtifact, setArtifactStatus, setArtifactWave } from "../registry/commands/artifacts";
import { startRun } from "../registry/commands/runs";
import { claimArtifactById, claimNextTask, releaseClaimByArtifactId } from "../registry/commands/claim";
import { applySchema } from "../registry/db/schema";

const repoRoot = path.resolve(__dirname, "..", "..");

// TASK-01 precedent: auto-confirm mappings and auto-keep scope so the phase
// reaches the risk gate without hanging on unrelated prompts.
process.env["GUILDCTL_AUTO_CONFIRM_MAPPINGS"] = "1";
process.env["GUILDCTL_AUTO_KEEP_SCOPE"] = "1";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function fixtureRoot(stack = "java-spring"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guild-plan-risk-"));
  fs.cpSync(path.join(repoRoot, "stacks"), path.join(root, "stacks"), { recursive: true });
  fs.mkdirSync(path.join(root, ".guild"), { recursive: true });
  fs.writeFileSync(path.join(root, ".guild", "config.yaml"), `version: 1\nstack: ${stack}\n`);
  return root;
}

function registerClassified(db: Database.Database, id: string): void {
  registerArtifact(db, {
    id,
    kind: "legacy-source",
    path: `legacy/src/main/java/${id.replaceAll(":", "/")}.java`,
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
}

function seedPending(db: Database.Database, id: string, riskScore = 90): void {
  db.prepare(
    "INSERT INTO artifact_risk_assessments (artifact_id, risk_score, high_risk, reason_codes_json, signals_json) VALUES (?, ?, 1, ?, '{}') ON CONFLICT(artifact_id) DO UPDATE SET risk_score = excluded.risk_score, high_risk = 1",
  ).run(id, riskScore, JSON.stringify(["reflection-usage:java-class-forName"]));
  db.prepare("INSERT INTO risk_confirmations (artifact_id, decision) VALUES (?, 'pending') ON CONFLICT(artifact_id) DO NOTHING").run(id);
}

function decision(db: Database.Database, id: string): { decision: string; decided_by: string | null; decided_at: string | null } {
  return db.prepare("SELECT decision, decided_by, decided_at FROM risk_confirmations WHERE artifact_id = ?").get(id) as never;
}

const auditSummary = {
  artifact_count: 1,
  jvm: { critical: 0, warnings: 0 },
  dependencies: { total: 0, unresolved: 0 },
  tools: [],
};

function success(agent: string): AgentRunResult {
  return { runId: `${agent}-run`, agent, model: "test-model", prompt: "p", logFile: "/tmp/x.log", exitCode: 0 };
}

const planDeps = (db: Database.Database, root: string) => ({
  workspaceRoot: root,
  refreshCompatibilityAudits: () => auditSummary,
  startPolling: () => () => undefined,
  getLogDir: () => "/tmp",
  spawnAgent: async ({ agent }: { agent: string }) => success(agent),
});

test("GUILDCTL_AUTO_CONFIRM_RISK=1 bulk-confirms every pending row as benchmark-runner, no prompt (FR-012)", async () => {
  process.env["GUILDCTL_AUTO_CONFIRM_RISK"] = "1";
  const db = createDb();
  const root = fixtureRoot();
  try {
    registerClassified(db, "legacy-source:com.acme:RiskyA");
    registerClassified(db, "legacy-source:com.acme:RiskyB");
    seedPending(db, "legacy-source:com.acme:RiskyA");
    seedPending(db, "legacy-source:com.acme:RiskyB");

    await runPlan(db, planDeps(db, root));

    for (const id of ["legacy-source:com.acme:RiskyA", "legacy-source:com.acme:RiskyB"]) {
      const row = decision(db, id);
      assert.equal(row.decision, "confirmed");
      assert.equal(row.decided_by, "benchmark-runner");
      assert.ok(row.decided_at, "decided_at recorded");
    }
  } finally {
    delete process.env["GUILDCTL_AUTO_CONFIRM_RISK"];
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("env unset and non-interactive stdin: pending rows remain pending — no hang, no silent bypass (FR-012)", async () => {
  delete process.env["GUILDCTL_AUTO_CONFIRM_RISK"];
  const db = createDb();
  const root = fixtureRoot();
  try {
    registerClassified(db, "legacy-source:com.acme:Risky");
    seedPending(db, "legacy-source:com.acme:Risky");

    await runPlan(db, planDeps(db, root));

    const row = decision(db, "legacy-source:com.acme:Risky");
    assert.equal(row.decision, "pending", "still pending — never silently migrated");
    assert.equal(row.decided_by, null);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("US3 end-to-end: below-threshold claimable, above-threshold held until confirmed (AC 3.1-3.5)", async () => {
  process.env["GUILDCTL_AUTO_CONFIRM_RISK"] = "1";
  const db = createDb();
  const root = fixtureRoot();
  try {
    registerClassified(db, "legacy-source:com.acme:Safe");
    registerClassified(db, "legacy-source:com.acme:Risky");
    for (const id of ["legacy-source:com.acme:Safe", "legacy-source:com.acme:Risky"]) {
      setArtifactWave(db, id, 1);
      setArtifactStatus(db, id, "planned");
    }
    seedPending(db, "legacy-source:com.acme:Risky");
    startRun(db, { runId: "run-1", agent: "code-writer-agent", ownerId: "owner-A" });

    // Before plan/confirmation: safe is claimable, risky is not.
    assert.equal(
      claimNextTask(db, "code-writer-agent", undefined, "planned", undefined, "first-class", "run-1", "owner-A").id,
      "legacy-source:com.acme:Safe",
    );
    // Release the safe claim so the next claim can proceed.
    releaseClaimByArtifactId(db, "legacy-source:com.acme:Safe", "code-writer-agent", "test cleanup");
    db.prepare("UPDATE artifacts SET status = 'planned' WHERE id = 'legacy-source:com.acme:Safe'").run();

    // Run plan with auto-confirm — the risky artifact becomes confirmed.
    await runPlan(db, planDeps(db, root));
    assert.equal(decision(db, "legacy-source:com.acme:Risky").decision, "confirmed");

    startRun(db, { runId: "run-2", agent: "code-writer-agent", ownerId: "owner-B" });
    const claimedRisky = claimArtifactById(db, { artifactId: "legacy-source:com.acme:Risky", agent: "code-writer-agent", ownerId: "owner-B", runId: "run-2" });
    assert.equal(claimedRisky.id, "legacy-source:com.acme:Risky",
      "confirmed artifact is claimable through the normal machinery");
  } finally {
    delete process.env["GUILDCTL_AUTO_CONFIRM_RISK"];
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
