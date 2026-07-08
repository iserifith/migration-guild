import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { runPipelineStateChecks } from "../guildctl/doctor";
import { registerArtifact, setArtifactStatus, setArtifactWave } from "../registry/commands/artifacts";
import { createMapping } from "../registry/commands/mappings";
import { setOperatorState } from "../registry/commands/operator";
import { applySchema } from "../registry/db/schema";

const repoRoot = path.resolve(__dirname, "..", "..");
const migrationRoot = path.resolve(__dirname, "..");

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function fixtureRoot(prefix = "guild-doctor-"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, ".guild", "prompts", "default"), { recursive: true });
  fs.mkdirSync(path.join(root, "legacy"), { recursive: true });
  fs.cpSync(path.join(repoRoot, "stacks"), path.join(root, "stacks"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".guild", "config.yaml"),
    "version: 1\nstack: java-spring\nevidence:\n  include_git_diff: false\n",
  );
  return root;
}

function addArtifact(db: Database.Database, i = 0): string {
  const id = `legacy-source:com.acme:Artifact${i}`;
  registerArtifact(db, {
    id,
    kind: "legacy-source",
    path: `legacy/src/main/java/com/acme/Artifact${i}.java`,
    tier: "first-class",
    module: "com.acme",
  });
  return id;
}

function classify(db: Database.Database, id: string, framework = "spring-mvc"): void {
  db.prepare(`
    INSERT INTO artifact_classifications (artifact_id, framework, role, confidence, ambiguous, evidence_json, signals_json)
    VALUES (?, ?, 'service', 0.9, 0, ?, '[]')
    ON CONFLICT(artifact_id) DO UPDATE SET framework = excluded.framework, evidence_json = excluded.evidence_json
  `).run(id, framework, JSON.stringify(["spring: @Controller"]));
}

function check(db: Database.Database, root: string, thresholdMs?: number) {
  return runPipelineStateChecks({ db, workspaceRoot: root, danglingClaimThresholdMs: thresholdMs });
}

function messages(results: ReturnType<typeof check>): string {
  return results.map((r) => `${r.status}: ${r.message}`).join("\n");
}

test("jforum2-style broken post-plan state fails: planner claimed complete but waves and mappings are missing", () => {
  const db = createDb();
  const root = fixtureRoot();
  try {
    for (let i = 0; i < 366; i++) classify(db, addArtifact(db, i));
    setOperatorState(db, "plan_verification_planner", {
      phase: "planner",
      agentExited: 0,
      invariantPassed: true,
      message: "legacy planner falsely claimed success",
      at: new Date().toISOString(),
    });

    const result = check(db, root);
    assert.ok(result.some((r) => r.status === "fail" && /366\/366 artifacts with wave = NULL/.test(r.message)), messages(result));
    assert.ok(result.some((r) => r.status === "fail" && /stack_mappings is empty/.test(r.message)), messages(result));
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("malformed evidence_json rows fail and name offenders", () => {
  const db = createDb();
  const root = fixtureRoot();
  try {
    const id = addArtifact(db, 1);
    db.prepare(`
      INSERT INTO artifact_classifications (artifact_id, framework, role, confidence, ambiguous, evidence_json, signals_json)
      VALUES (?, 'plain-java', 'service', 0.9, 0, ?, '[]')
    `).run(id, JSON.stringify("not-an-array"));

    const result = check(db, root);
    assert.ok(result.some((r) => r.status === "fail" && r.message.includes(id)), messages(result));
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("artifact marked migrated with empty modern directory fails registry/filesystem agreement", () => {
  const db = createDb();
  const root = fixtureRoot();
  try {
    const id = addArtifact(db, 2);
    classify(db, id);
    setArtifactWave(db, id, 1);
    setArtifactStatus(db, id, "migrated", { agent: "test", reason: "fixture" });
    fs.mkdirSync(path.join(root, "modern"), { recursive: true });

    const result = check(db, root);
    assert.ok(result.some((r) => r.status === "fail" && /marked migrated/.test(r.message)), messages(result));
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fresh workspace has no spurious pipeline-state failure", () => {
  const db = createDb();
  const root = fixtureRoot();
  try {
    const result = check(db, root);
    assert.equal(result.some((r) => r.status === "fail"), false, messages(result));
    assert.ok(result.some((r) => /no artifacts registered yet/.test(r.message)), messages(result));
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("registry with zero artifacts but legacy source files fails empty-pipeline sanity", () => {
  const db = createDb();
  const root = fixtureRoot();
  try {
    fs.mkdirSync(path.join(root, "legacy", "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "legacy", "src", "Thing.java"), "class Thing {}\n");
    const result = check(db, root);
    assert.ok(result.some((r) => r.status === "fail" && /0 artifacts/.test(r.message)), messages(result));
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("stale active claims warn with owner and age", () => {
  const db = createDb();
  const root = fixtureRoot();
  try {
    const id = addArtifact(db, 3);
    const stale = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    db.prepare(`
      INSERT INTO artifact_claims (claim_id, artifact_id, owner_id, agent, from_status, claim_token, state, attempt_no, claimed_at, heartbeat_at, lease_expires_at)
      VALUES ('claim-stale', ?, 'worker-1', 'analyze-agent', 'pending', 'tok', 'active', 1, ?, ?, ?)
    `).run(id, stale, stale, new Date(Date.now() + 60_000).toISOString());

    const result = check(db, root);
    assert.ok(result.some((r) => r.status === "warn" && /worker-1/.test(r.message)), messages(result));
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("unclassified and fallback-heavy registries warn without failing", () => {
  const db = createDb();
  const root = fixtureRoot();
  try {
    for (let i = 0; i < 10; i++) addArtifact(db, i);
    for (let i = 0; i < 4; i++) classify(db, `legacy-source:com.acme:Artifact${i}`, "plain-java");

    const unclassifiedResult = check(db, root);
    assert.ok(unclassifiedResult.some((r) => r.status === "warn" && /unclassified/.test(r.message)), messages(unclassifiedResult));

    for (let i = 4; i < 10; i++) classify(db, `legacy-source:com.acme:Artifact${i}`, "plain-java");
    const fallbackResult = check(db, root);
    assert.ok(fallbackResult.some((r) => r.status === "warn" && /fallback-classified/.test(r.message)), messages(fallbackResult));
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("healthy post-plan fixture passes state checks", () => {
  const db = createDb();
  const root = fixtureRoot();
  try {
    for (let i = 0; i < 5; i++) {
      const id = addArtifact(db, i);
      classify(db, id, "spring-mvc");
      setArtifactWave(db, id, i % 2);
    }
    createMapping(db, { legacy_framework: "spring-mvc", target_framework: "spring-boot", strategy: "rewrite" });
    fs.mkdirSync(path.join(root, "modern", "src"), { recursive: true });

    const result = check(db, root);
    assert.equal(result.some((r) => r.status === "fail"), false, messages(result));
    assert.ok(result.some((r) => /all 5 artifacts assigned/.test(r.message)), messages(result));
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pipeline-state checks stay fast on a 3000-artifact synthetic registry", () => {
  const db = createDb();
  const root = fixtureRoot();
  try {
    for (let i = 0; i < 3000; i++) {
      const id = addArtifact(db, i);
      classify(db, id, "spring-mvc");
      setArtifactWave(db, id, i % 10);
    }
    createMapping(db, { legacy_framework: "spring-mvc", target_framework: "spring-boot", strategy: "rewrite" });
    const start = Date.now();
    const result = check(db, root);
    const elapsed = Date.now() - start;
    assert.equal(result.some((r) => r.status === "fail"), false, messages(result));
    assert.ok(elapsed < 2_000, `expected <2s, got ${elapsed}ms`);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("doctor command exits non-zero when pipeline-state checks fail", () => {
  const root = fixtureRoot();
  const dbPath = path.join(root, ".guild", "registry.db");
  const db = new Database(dbPath);
  try {
    applySchema(db);
    const id = addArtifact(db, 42);
    classify(db, id);
    setOperatorState(db, "plan_verification_planner", {
      phase: "planner",
      agentExited: 0,
      invariantPassed: true,
      message: "claimed complete",
      at: new Date().toISOString(),
    });
  } finally {
    db.close();
  }

  try {
    const result = spawnSync(process.execPath, [
      "--import",
      "tsx",
      path.join(migrationRoot, "guildctl", "cli.ts"),
      "--workspace",
      root,
      "--db",
      dbPath,
      "doctor",
    ], {
      cwd: migrationRoot,
      encoding: "utf8",
      env: { ...process.env, DASHSCOPE_API_KEY: "dummy" },
    });
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, output);
    assert.match(output, /Pipeline state:/);
    assert.match(output, /wave = NULL/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
