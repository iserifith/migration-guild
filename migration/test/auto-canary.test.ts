import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { DEFAULT_GUILD_CONFIG, stringifySimpleYaml, type GuildConfig } from "../guildctl/config";
import { harnessReviewer, parseReviewMarker, runAutoCommand, REVIEW_MARKER } from "../guildctl/commands/auto";
import { runAuto } from "../guildctl/supervisor/loop";
import { runVerify } from "../guildctl/verify";
import { createRunOperatorCredential } from "../registry/commands/claim";
import { registerArtifact, setArtifactStatus, setArtifactWave } from "../registry/commands/artifacts";
import { startRun } from "../registry/commands/runs";
import { applySchema } from "../registry/db/schema";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function seed(db: Database.Database, artifactPath = "legacy/AutoCanary.js"): string {
  const id = "legacy-source:com.acme:AutoCanary";
  registerArtifact(db, {
    id,
    kind: "legacy-source",
    tier: "first-class",
    path: artifactPath,
  });
  setArtifactWave(db, id, 1);
  setArtifactStatus(db, id, "planned");
  return id;
}

function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void> | void): Promise<void> | void {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    previous[key] = process.env[key];
    if (env[key] == null) delete process.env[key];
    else process.env[key] = env[key];
  }
  const restore = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  };
  try {
    const result = fn();
    if (result && typeof (result as Promise<void>).then === "function") {
      return (result as Promise<void>).finally(restore);
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

test("runAuto drives real stop repair reverify review arbitration for one explicit artifact", async () => {
  const db = createDb();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "guild-auto-canary-"));
  try {
    fs.mkdirSync(path.join(workspace, "legacy"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "legacy", "AutoCanary.js"), "module.exports = 0;\n");
    const id = seed(db);
    const phases: string[] = [];
    let reviewCalls = 0;

    const result = await runAuto(db, {
      artifactId: id,
      workspaceRoot: workspace,
      commands: ["node --check modern/AutoCanary.js"],
      worker: async ({ phase, claim }) => {
        phases.push(phase);
        fs.mkdirSync(path.join(workspace, "modern"), { recursive: true });
        fs.writeFileSync(
          path.join(workspace, "modern", "AutoCanary.js"),
          phase === "migrate" ? "function broken(\n" : "function ok() { return 1; }\n",
        );
        setArtifactStatus(db, claim.id, "migrated", {
          agent: phase === "repair" ? "remediation-agent" : "code-writer-agent",
          claimId: claim.claim_id,
          claimToken: claim.claim_token,
        });
      },
      review: async ({ evidence }) => {
        reviewCalls += 1;
        assert.equal(evidence.at(-1)?.pass, 1);
        return {
          approved: true,
          reason: "independent review accepted repaired runtime proof",
          reviewerAgent: "review-agent",
          reviewerModel: "review-model",
        };
      },
    });

    assert.equal(result.status, "complete");
    assert.deepEqual(phases, ["migrate", "repair"]);
    assert.equal(reviewCalls, 1);
    assert.equal(fs.readFileSync(path.join(workspace, "modern", "AutoCanary.js"), "utf8"), "function ok() { return 1; }\n");
    const artifact = db.prepare("SELECT status FROM artifacts WHERE id = ?").get(id) as { status: string };
    assert.equal(artifact.status, "reviewed");
    const activeClaims = db.prepare("SELECT COUNT(*) AS n FROM artifact_claims WHERE state = 'active'").get() as { n: number };
    assert.equal(activeClaims.n, 0);
    const events = db.prepare("SELECT type, summary FROM events WHERE artifact_id = ? ORDER BY rowid").all(id) as Array<{ type: string; summary: string }>;
    assert.ok(events.some((event) => event.type === "auto-rework"));
    assert.ok(events.some((event) => event.type === "auto-completed"));
    assert.ok(events.some((event) => event.type === "arbitration-approved"));
    assert.ok(events.findIndex((event) => event.type === "auto-rework") < events.findIndex((event) => event.type === "auto-completed"));
  } finally {
    db.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("runAuto rejects workspace-local file registry before claims or worker mutation", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "guild-auto-local-db-"));
  const dbPath = path.join(workspace, ".guild", "registry.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    applySchema(db);
    fs.mkdirSync(path.join(workspace, "legacy"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "legacy", "AutoCanary.js"), "module.exports = 0;\n");
    const id = seed(db);
    let workerCalled = false;

    await assert.rejects(
      () => runAuto(db, {
        artifactId: id,
        workspaceRoot: workspace,
        commands: ["node --check modern/AutoCanary.js"],
        worker: async () => {
          workerCalled = true;
          fs.mkdirSync(path.join(workspace, "modern"), { recursive: true });
          fs.writeFileSync(path.join(workspace, "modern", "AutoCanary.js"), "function shouldNotRun() {}\n");
        },
        review: async () => ({
          approved: true,
          reason: "unreachable review",
          reviewerAgent: "review-agent",
          reviewerModel: "review-model",
        }),
      }),
      /Autonomous runs require REGISTRY_DB outside the target workspace/,
    );

    assert.equal(workerCalled, false);
    assert.equal(fs.existsSync(path.join(workspace, "modern", "AutoCanary.js")), false);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM artifact_claims WHERE state = 'active'").get() as { n: number }).n, 0);
    assert.equal((db.prepare("SELECT status FROM artifacts WHERE id = ?").get(id) as { status: string }).status, "planned");
    assert.equal((db.pragma("integrity_check", { simple: true }) as string), "ok");
  } finally {
    db.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("runAuto restores malicious out-of-scope writes even when worker exits nonzero", async () => {
  const db = createDb();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "guild-auto-malicious-"));
  try {
    fs.mkdirSync(path.join(workspace, "legacy"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "legacy", "AutoCanary.js"), "module.exports = 0;\n");
    fs.writeFileSync(path.join(workspace, "legacy", "DoNotTouch.js"), "original forbidden\n");
    const id = seed(db);

    const result = await runAuto(db, {
      artifactId: id,
      workspaceRoot: workspace,
      commands: ["node --check modern/AutoCanary.js"],
      maxAttempts: 1,
      worker: async () => {
        fs.mkdirSync(path.join(workspace, "modern"), { recursive: true });
        fs.writeFileSync(path.join(workspace, "modern", "AutoCanary.js"), "function ok() { return 1; }\n");
        fs.writeFileSync(path.join(workspace, "legacy", "DoNotTouch.js"), "tampered\n");
        fs.writeFileSync(path.join(workspace, "legacy", "Created.js"), "created forbidden\n");
        throw new Error("malicious worker exited nonzero");
      },
      review: async () => ({
        approved: false,
        reason: "unreachable review",
        reviewerAgent: "review-agent",
        reviewerModel: "review-model",
      }),
    });

    assert.equal(result.status, "blocked");
    assert.equal(fs.readFileSync(path.join(workspace, "legacy", "DoNotTouch.js"), "utf8"), "original forbidden\n");
    assert.equal(fs.existsSync(path.join(workspace, "legacy", "Created.js")), false);
    assert.equal(fs.readFileSync(path.join(workspace, "modern", "AutoCanary.js"), "utf8"), "function ok() { return 1; }\n");
    const artifact = db.prepare("SELECT status FROM artifacts WHERE id = ?").get(id) as { status: string };
    assert.equal(artifact.status, "blocked");
    const activeClaims = db.prepare("SELECT COUNT(*) AS n FROM artifact_claims WHERE state = 'active'").get() as { n: number };
    assert.equal(activeClaims.n, 0);
    const violation = db.prepare("SELECT event_data FROM events WHERE artifact_id = ? AND type = 'filesystem-violation'").get(id) as { event_data: string };
    assert.match(violation.event_data, /DoNotTouch\.js/);
    assert.match(violation.event_data, /Created\.js/);
  } finally {
    db.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("runAuto restores reviewer mutation after verification and fails closed", async () => {
  const db = createDb();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "guild-auto-review-mutate-"));
  try {
    fs.mkdirSync(path.join(workspace, "legacy"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "legacy", "AutoCanary.js"), "module.exports = 0;\n");
    const id = seed(db);

    const result = await runAuto(db, {
      artifactId: id,
      workspaceRoot: workspace,
      commands: ["node --check modern/AutoCanary.js"],
      maxAttempts: 1,
      worker: async ({ claim }) => {
        fs.mkdirSync(path.join(workspace, "modern"), { recursive: true });
        fs.writeFileSync(path.join(workspace, "modern", "AutoCanary.js"), "function verified() { return 1; }\n");
        setArtifactStatus(db, claim.id, "migrated", {
          agent: "code-writer-agent",
          claimId: claim.claim_id,
          claimToken: claim.claim_token,
        });
      },
      review: async () => {
        fs.writeFileSync(path.join(workspace, "modern", "AutoCanary.js"), "function tampered(\n");
        return {
          approved: true,
          reason: "malicious approval after tampering",
          reviewerAgent: "review-agent",
          reviewerModel: "review-model",
        };
      },
    });

    assert.equal(result.status, "blocked");
    assert.equal(fs.readFileSync(path.join(workspace, "modern", "AutoCanary.js"), "utf8"), "function verified() { return 1; }\n");
    assert.notEqual((db.prepare("SELECT status FROM artifacts WHERE id = ?").get(id) as { status: string }).status, "reviewed");
    const decisions = db.prepare("SELECT COUNT(*) AS n FROM arbitration_decisions WHERE artifact_id = ? AND decision = 'approved'").get(id) as { n: number };
    assert.equal(decisions.n, 0);
    const violation = db.prepare("SELECT event_data FROM events WHERE artifact_id = ? AND type = 'filesystem-violation'").get(id) as { event_data: string };
    assert.match(violation.event_data, /modern\/AutoCanary\.js/);
  } finally {
    db.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("runAuto repairs a structured reviewer rejection with bounded same-owner rework", async () => {
  const db = createDb();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "guild-auto-review-reject-repair-"));
  const reviewReason = "missing Python type annotations on public function";
  try {
    fs.mkdirSync(path.join(workspace, "legacy"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "legacy", "AutoCanary.py"), "def add(a, b):\n    return a + b\n");
    const id = seed(db, "legacy/AutoCanary.py");
    const phases: string[] = [];
    const workerReviewReasons: Array<string | undefined> = [];
    let reviewCalls = 0;

    const result = await runAuto(db, {
      artifactId: id,
      workspaceRoot: workspace,
      commands: ["python -m py_compile modern/AutoCanary.py"],
      maxAttempts: 2,
      worker: async ({ phase, claim, reviewReason: receivedReviewReason }) => {
        phases.push(phase);
        workerReviewReasons.push(receivedReviewReason);
        fs.mkdirSync(path.join(workspace, "modern"), { recursive: true });
        if (phase === "repair") {
          assert.equal(receivedReviewReason, reviewReason);
          fs.writeFileSync(path.join(workspace, "modern", "AutoCanary.py"), "def add(a: int, b: int) -> int:\n    return a + b\n");
        } else {
          assert.equal(receivedReviewReason, undefined);
          fs.writeFileSync(path.join(workspace, "modern", "AutoCanary.py"), "def add(a, b):\n    return a + b\n");
        }
        setArtifactStatus(db, claim.id, "migrated", {
          agent: phase === "repair" ? "remediation-agent" : "code-writer-agent",
          claimId: claim.claim_id,
          claimToken: claim.claim_token,
        });
      },
      review: async ({ evidence }) => {
        reviewCalls += 1;
        assert.equal(evidence.at(-1)?.pass, 1);
        return reviewCalls === 1
          ? {
            approved: false,
            reason: reviewReason,
            reviewerAgent: "review-agent",
            reviewerModel: "review-model",
          }
          : {
            approved: true,
            reason: "type annotations present after reviewer-guided repair",
            reviewerAgent: "review-agent",
            reviewerModel: "review-model",
          };
      },
    });

    assert.equal(result.status, "complete");
    assert.equal(result.attempts, 2);
    assert.deepEqual(phases, ["migrate", "repair"]);
    assert.deepEqual(workerReviewReasons, [undefined, reviewReason]);
    assert.equal(reviewCalls, 2);
    assert.equal(fs.readFileSync(path.join(workspace, "modern", "AutoCanary.py"), "utf8"), "def add(a: int, b: int) -> int:\n    return a + b\n");
    assert.equal((db.prepare("SELECT status FROM artifacts WHERE id = ?").get(id) as { status: string }).status, "reviewed");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM artifact_claims WHERE state = 'active'").get() as { n: number }).n, 0);
    const claimOwners = db.prepare("SELECT DISTINCT owner_id FROM artifact_claims WHERE artifact_id = ? ORDER BY owner_id").all(id) as Array<{ owner_id: string }>;
    assert.deepEqual(claimOwners.map((row) => row.owner_id), [`guildctl-auto:${id}`]);
    const events = db.prepare("SELECT type, summary, event_data FROM events WHERE artifact_id = ? ORDER BY rowid").all(id) as Array<{ type: string; summary: string; event_data: string | null }>;
    const eventTypes = events.map((event) => event.type);
    assert.ok(eventTypes.includes("auto-completed"));
    assert.ok(eventTypes.includes("auto-rework"));
    assert.ok(eventTypes.includes("arbitration-approved"));
    assert.equal(eventTypes.includes("arbitration-rejected"), false);
    const reworkIndex = events.findIndex((event) => event.type === "auto-rework" && event.summary.includes("review rejected"));
    const claimedIndexes = eventTypes.flatMap((type, index) => type === "claimed" ? [index] : []);
    assert.equal(claimedIndexes.length, 2);
    assert.ok(reworkIndex >= 0);
    assert.ok(claimedIndexes[1] > reworkIndex);
    assert.ok(eventTypes.indexOf("auto-completed") < reworkIndex);
    assert.ok(eventTypes.lastIndexOf("auto-completed") > claimedIndexes[1]);
    assert.ok(eventTypes.indexOf("arbitration-approved") > eventTypes.lastIndexOf("auto-completed"));
    const reworkData = JSON.parse(events[reworkIndex].event_data ?? "{}") as { failure?: { kind?: string }; reason?: string };
    assert.equal(reworkData.failure?.kind, "review-rejection");
    assert.equal(reworkData.reason, reviewReason);
  } finally {
    db.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("runAuto --resume repairs from SQLite after an interrupted failed verify", async () => {
  const db = createDb();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "guild-auto-resume-fail-"));
  try {
    fs.mkdirSync(path.join(workspace, "legacy"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "modern"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "legacy", "AutoCanary.js"), "module.exports = 0;\n");
    fs.writeFileSync(path.join(workspace, "modern", "AutoCanary.js"), "function broken(\n");
    const id = seed(db);
    setArtifactStatus(db, id, "migrated", { agent: "test", reason: "interrupted after migrate" });
    startRun(db, { runId: "old-failed-verify", agent: "guildctl-verify", ownerId: "guildctl", phase: "verify" });
    const oldToken = createRunOperatorCredential(db, "old-failed-verify").token;
    const failed = await runVerify(db, {
      artifactId: id,
      workspaceRoot: workspace,
      commands: ["node --check modern/AutoCanary.js"],
      outputDir: path.join(workspace, ".guild", "old-evidence"),
      runId: "old-failed-verify",
      operatorToken: oldToken,
    });
    assert.equal(failed.pass, false);

    const phases: string[] = [];
    const result = await runAuto(db, {
      artifactId: id,
      workspaceRoot: workspace,
      commands: ["node --check modern/AutoCanary.js"],
      resume: true,
      worker: async ({ phase, claim }) => {
        phases.push(phase);
        fs.writeFileSync(path.join(workspace, "modern", "AutoCanary.js"), "function ok() { return 1; }\n");
        setArtifactStatus(db, claim.id, "migrated", {
          agent: "remediation-agent",
          claimId: claim.claim_id,
          claimToken: claim.claim_token,
        });
      },
      review: async ({ evidence }) => {
        assert.equal(evidence.at(-1)?.pass, 1);
        return {
          approved: true,
          reason: "independent review accepted repaired runtime proof",
          reviewerAgent: "review-agent",
          reviewerModel: "review-model",
        };
      },
    });

    assert.equal(result.status, "complete");
    assert.deepEqual(phases, ["repair"]);
    assert.equal((db.prepare("SELECT status FROM artifacts WHERE id = ?").get(id) as { status: string }).status, "reviewed");
  } finally {
    db.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("runAuto --resume re-verifies a persisted passing verify before review", async () => {
  const db = createDb();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "guild-auto-resume-pass-"));
  try {
    fs.mkdirSync(path.join(workspace, "legacy"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "modern"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "legacy", "AutoCanary.js"), "module.exports = 0;\n");
    fs.writeFileSync(path.join(workspace, "modern", "AutoCanary.js"), "function ok() { return 1; }\n");
    const id = seed(db);
    setArtifactStatus(db, id, "migrated", { agent: "test", reason: "interrupted before review" });
    startRun(db, { runId: "old-passed-verify", agent: "guildctl-verify", ownerId: "guildctl", phase: "verify" });
    const oldToken = createRunOperatorCredential(db, "old-passed-verify").token;
    const passed = await runVerify(db, {
      artifactId: id,
      workspaceRoot: workspace,
      commands: ["node --check modern/AutoCanary.js"],
      outputDir: path.join(workspace, ".guild", "old-evidence"),
      runId: "old-passed-verify",
      operatorToken: oldToken,
    });
    assert.equal(passed.pass, true);

    let workerCalls = 0;
    let reviewCalls = 0;
    const result = await runAuto(db, {
      artifactId: id,
      workspaceRoot: workspace,
      commands: ["node --check modern/AutoCanary.js"],
      resume: true,
      worker: async () => {
        workerCalls += 1;
      },
      review: async ({ evidence }) => {
        reviewCalls += 1;
        assert.equal(evidence.length, 1);
        assert.equal(evidence[0].pass, 1);
        assert.notEqual(evidence[0].run_id, "old-passed-verify");
        return {
          approved: true,
          reason: "resume review accepted fresh verifier proof",
          reviewerAgent: "review-agent",
          reviewerModel: "review-model",
        };
      },
    });

    assert.equal(result.status, "complete");
    assert.equal(workerCalls, 0);
    assert.equal(reviewCalls, 1);
    assert.equal((db.prepare("SELECT status FROM artifacts WHERE id = ?").get(id) as { status: string }).status, "reviewed");
  } finally {
    db.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("runAuto cannot approve without an explicit independent review callback", async () => {
  const db = createDb();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "guild-auto-no-review-"));
  try {
    fs.mkdirSync(path.join(workspace, "legacy"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "legacy", "AutoCanary.js"), "module.exports = 0;\n");
    const id = seed(db);

    await assert.rejects(
      () => runAuto(db, {
        artifactId: id,
        workspaceRoot: workspace,
        commands: ["node --check modern/AutoCanary.js"],
        worker: async () => {},
      }),
      /requires an explicit independent review callback/,
    );
    assert.equal((db.prepare("SELECT status FROM artifacts WHERE id = ?").get(id) as { status: string }).status, "planned");
  } finally {
    db.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("runAuto rejects reviewer identity matching the producing agent or model", async () => {
  const db = createDb();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "guild-auto-review-identity-"));
  try {
    fs.mkdirSync(path.join(workspace, "legacy"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "legacy", "AutoCanary.js"), "module.exports = 0;\n");
    const id = seed(db);

    await assert.rejects(
      () => runAuto(db, {
        artifactId: id,
        workspaceRoot: workspace,
        commands: ["node --check modern/AutoCanary.js"],
        maxAttempts: 1,
        producerModel: "producer-model",
        worker: async ({ claim }) => {
          fs.mkdirSync(path.join(workspace, "modern"), { recursive: true });
          fs.writeFileSync(path.join(workspace, "modern", "AutoCanary.js"), "function ok() { return 1; }\n");
          setArtifactStatus(db, claim.id, "migrated", {
            agent: "code-writer-agent",
            claimId: claim.claim_id,
            claimToken: claim.claim_token,
          });
        },
        review: async () => ({
          approved: true,
          reason: "same producer is not independent",
          reviewerAgent: "code-writer-agent",
          reviewerModel: "review-model",
        }),
      }),
      /review agent must differ from producer agent/,
    );

    await assert.rejects(
      () => runAuto(db, {
        artifactId: id,
        workspaceRoot: workspace,
        commands: ["node --check modern/AutoCanary.js"],
        resume: true,
        producerModel: "producer-model",
        worker: async () => {},
        review: async () => ({
          approved: true,
          reason: "same model is not independent",
          reviewerAgent: "review-agent",
          reviewerModel: "producer-model",
        }),
      }),
      /review model must differ from producer model/,
    );
  } finally {
    db.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("review marker parser fails closed on malformed reviewer output", () => {
  assert.throws(() => parseReviewMarker("looks good\n"), /exactly one MIGRATION_GUILD_REVIEW/);
  assert.throws(() => parseReviewMarker(`${REVIEW_MARKER}{nope}\n`), /malformed/);
  assert.throws(() => parseReviewMarker(`${REVIEW_MARKER}{"approved":true}\n`), /approved boolean and non-empty reason/);
});

test("harness-backed independent reviewer approves from structured marker", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "guild-auto-reviewer-"));
  const script = path.join(workspace, "reviewer.cjs");
  try {
    fs.writeFileSync(script, `
if (process.env.GUILDCTL_CLAIM_TOKEN || process.env.GUILDCTL_OPERATOR_TOKEN || process.env.GUILDCTL_VERIFIER_TOKEN) process.exit(9);
if (process.env.AGENT_PROVIDER_BASE_URL !== "https://rootsys.example/v1") process.exit(10);
if (process.env.AGENT_PROVIDER_API_KEY_ENV !== "ROOTSYS_API_KEY") process.exit(11);
if (process.env.GUILDCTL_AGENT_MODEL !== "review-model") process.exit(12);
if (process.argv.join(" ").includes("secret-value-never-print")) process.exit(13);
console.log('${REVIEW_MARKER}' + JSON.stringify({ approved: true, reason: "independent review passed" }));
`, "utf8");
    const cfg: GuildConfig & { guildRoot: string; configPath: string; selectedProfile: string } = {
      ...DEFAULT_GUILD_CONFIG,
      guildRoot: workspace,
      configPath: path.join(workspace, ".guild", "config.yaml"),
      selectedProfile: "default",
      model: { ...DEFAULT_GUILD_CONFIG.model, base_url: "https://rootsys.example/v1", api_key_env: "ROOTSYS_API_KEY" },
      provider: { routes: { default: ["producer-model"], review: ["producer-model", "review-model"] } },
    };
    let decision;
    await withEnv({ ROOTSYS_API_KEY: "secret-value-never-print" }, async () => {
      const review = harnessReviewer(
        workspace,
        { name: "custom", command: script, targetCommand: script, source: "environment" },
        cfg,
        () => "producer-model",
      );
      decision = await review({
        artifactId: "legacy-source:com.acme:AutoCanary",
        runId: "run-review",
        producerAgent: "code-writer-agent",
        producerModel: "producer-model",
        evidence: [],
      });
    });
    assert.equal(decision?.approved, true);
    assert.equal(decision?.reviewerAgent, "review-agent");
    assert.equal(decision?.reviewerModel, "review-model");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("harness-backed reviewer does not try backups after a valid rejection", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "guild-auto-reviewer-reject-"));
  const script = path.join(workspace, "reviewer.cjs");
  try {
    fs.writeFileSync(script, `
if (process.env.GUILDCTL_AGENT_MODEL === "reject-model") {
  console.log('${REVIEW_MARKER}' + JSON.stringify({ approved: false, reason: "review found drift" }));
  process.exit(0);
}
console.log('${REVIEW_MARKER}' + JSON.stringify({ approved: true, reason: "backup should not run" }));
`, "utf8");
    const cfg: GuildConfig & { guildRoot: string; configPath: string; selectedProfile: string } = {
      ...DEFAULT_GUILD_CONFIG,
      guildRoot: workspace,
      configPath: path.join(workspace, ".guild", "config.yaml"),
      selectedProfile: "default",
      provider: { routes: { review: ["reject-model", "approve-model"] } },
    };
    const review = harnessReviewer(
      workspace,
      { name: "custom", command: script, targetCommand: script, source: "environment" },
      cfg,
      () => "producer-model",
    );
    const decision = await review({
      artifactId: "legacy-source:com.acme:AutoCanary",
      runId: "run-review",
      producerAgent: "code-writer-agent",
      producerModel: "producer-model",
      evidence: [],
    });
    assert.equal(decision.approved, false);
    assert.equal(decision.reviewerModel, "reject-model");
    assert.equal(decision.reason, "review found drift");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("harness-backed reviewer blocks when all reviewer outputs are malformed", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "guild-auto-reviewer-bad-"));
  const script = path.join(workspace, "reviewer.cjs");
  try {
    fs.writeFileSync(script, "console.log('not a marker');\n", "utf8");
    const cfg: GuildConfig & { guildRoot: string; configPath: string; selectedProfile: string } = {
      ...DEFAULT_GUILD_CONFIG,
      guildRoot: workspace,
      configPath: path.join(workspace, ".guild", "config.yaml"),
      selectedProfile: "default",
      provider: { routes: { review: ["review-model"] } },
    };
    const review = harnessReviewer(
      workspace,
      { name: "custom", command: script, targetCommand: script, source: "environment" },
      cfg,
      () => "producer-model",
    );
    await assert.rejects(
      () => review({
        artifactId: "legacy-source:com.acme:AutoCanary",
        runId: "run-review",
        producerAgent: "code-writer-agent",
        producerModel: "producer-model",
        evidence: [],
      }),
      /independent review failed closed/,
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("runAutoCommand custom fake canary executes review marker without credential preflight", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "guild-auto-cli-canary-"));
  const dbPath = path.join(os.tmpdir(), `guild-auto-cli-canary-${path.basename(workspace)}.db`);
  const script = path.join(workspace, "fake-agent.cjs");
  fs.mkdirSync(path.join(workspace, ".guild"), { recursive: true });
  const db = new Database(dbPath);
  try {
    fs.mkdirSync(path.join(workspace, "legacy"), { recursive: true });
    fs.writeFileSync(path.join(workspace, ".guild", "config.yaml"), stringifySimpleYaml({
      ...DEFAULT_GUILD_CONFIG,
      provider: { routes: { default: ["producer-model"], review: ["review-model"] } },
    } as unknown as Record<string, unknown>));
    fs.writeFileSync(path.join(workspace, "legacy", "AutoCanary.js"), "module.exports = 0;\n");
    fs.writeFileSync(script, `
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
if (process.env.GUILDCTL_AUTO_PHASE === "review") {
  if (process.env.GUILDCTL_CLAIM_TOKEN || process.env.GUILDCTL_OPERATOR_TOKEN || process.env.GUILDCTL_VERIFIER_TOKEN) process.exit(21);
  if (process.env.GUILDCTL_AGENT_MODEL !== "review-model") process.exit(22);
  if (!process.argv.join(" ").includes("Evidence:")) process.exit(23);
  if (!process.argv.join(" ").includes("Producer agent: remediation-agent")) process.exit(24);
  console.log('${REVIEW_MARKER}' + JSON.stringify({ approved: true, reason: "structured fake review accepted repaired runtime proof" }));
  process.exit(0);
}
if (process.env.AGENT_PROVIDER_BASE_URL !== "https://rootsys.cloud/v1") process.exit(25);
if (process.env.AGENT_PROVIDER_API_KEY_ENV !== "ROOTSYS_API_KEY") process.exit(26);
if (process.env.GUILDCTL_AGENT_MODEL !== "producer-model") process.exit(27);
if (!process.env.GUILDCTL_REGISTRY_CLI) process.exit(28);
if (!process.env.GUILDCTL_REGISTRY_CLI.includes("--import")) process.exit(30);
if (!process.env.GUILDCTL_REGISTRY_CLI.includes("--db")) process.exit(33);
if (!JSON.parse(process.env.GUILDCTL_REGISTRY_CLI_ARGV).includes(process.env.EXPECTED_REGISTRY_DB)) process.exit(34);
if (process.env.GUILDCTL_REGISTRY_DB !== process.env.EXPECTED_REGISTRY_DB) process.exit(31);
if (process.env.REGISTRY_DB !== process.env.EXPECTED_REGISTRY_DB) process.exit(32);
if (process.env.GUILDCTL_AGENT_KIND !== (process.env.GUILDCTL_AUTO_PHASE === "repair" ? "remediation-agent" : "code-writer-agent")) process.exit(29);
fs.mkdirSync(path.join(process.cwd(), "modern"), { recursive: true });
fs.writeFileSync(
  path.join(process.cwd(), "modern", "AutoCanary.js"),
  process.env.GUILDCTL_AUTO_PHASE === "migrate" ? "function broken(\\n" : "function ok() { return 1; }\\n"
);
const command = [
  process.env.GUILDCTL_REGISTRY_CLI,
  "set-artifact-status",
  "--id", process.env.GUILDCTL_ARTIFACT_ID,
  "--status", "migrated",
  "--agent", process.env.GUILDCTL_AUTO_PHASE === "repair" ? "remediation-agent" : "code-writer-agent",
  "--claim-id", process.env.GUILDCTL_CLAIM_ID,
  "--claim-token", process.env.GUILDCTL_CLAIM_TOKEN
].join(" ");
execSync(command, { cwd: process.cwd(), stdio: "inherit", env: process.env });
`, "utf8");
    applySchema(db);
    const id = seed(db);

    await withEnv({
      AGENT_CMD: script,
      GUILD_WORKSPACE: workspace,
      REGISTRY_DB: path.join(workspace, ".guild", "wrong-registry.db"),
      EXPECTED_REGISTRY_DB: dbPath,
      ROOTSYS_API_KEY: undefined,
    }, async () => {
      await runAutoCommand(db, {
        artifact: id,
        command: ["node --check modern/AutoCanary.js"],
        maxAttempts: 2,
        registryDbPath: dbPath,
      });
    });

    assert.equal((db.prepare("SELECT status FROM artifacts WHERE id = ?").get(id) as { status: string }).status, "reviewed");
    assert.equal(fs.readFileSync(path.join(workspace, "modern", "AutoCanary.js"), "utf8"), "function ok() { return 1; }\n");
    const activeClaims = db.prepare("SELECT COUNT(*) AS n FROM artifact_claims WHERE state = 'active'").get() as { n: number };
    assert.equal(activeClaims.n, 0);
    const decision = db.prepare("SELECT arbiter, decision, reason FROM arbitration_decisions WHERE artifact_id = ?").get(id) as { arbiter: string; decision: string; reason: string };
    assert.equal(decision.arbiter, "review-agent");
    assert.equal(decision.decision, "approved");
    assert.equal(decision.reason, "structured fake review accepted repaired runtime proof");
    const events = db.prepare("SELECT type FROM events WHERE artifact_id = ? ORDER BY rowid").all(id) as Array<{ type: string }>;
    const eventTypes = events.map((event) => event.type);
    assert.ok(eventTypes.includes("auto-rework"));
    assert.ok(eventTypes.includes("auto-completed"));
    assert.ok(eventTypes.includes("arbitration-approved"));
    assert.ok(eventTypes.indexOf("auto-rework") < eventTypes.indexOf("auto-completed"));
  } finally {
    db.close();
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(dbPath, { force: true });
  }
});

test("runAutoCommand bundled harness requires provider credential preflight", async () => {
  const db = createDb();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "guild-auto-preflight-"));
  try {
    fs.mkdirSync(path.join(workspace, ".guild"), { recursive: true });
    fs.writeFileSync(path.join(workspace, ".guild", "config.yaml"), stringifySimpleYaml(DEFAULT_GUILD_CONFIG as unknown as Record<string, unknown>));
    const id = seed(db);
    await assert.rejects(
      () => withEnv({
        AGENT_CMD: undefined,
        GUILD_WORKSPACE: workspace,
        ROOTSYS_API_KEY: undefined,
      }, async () => {
        await runAutoCommand(db, { artifact: id, command: ["true"], maxAttempts: 1 });
      }),
      /ROOTSYS_API_KEY is missing/,
    );
  } finally {
    db.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
