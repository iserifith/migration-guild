import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { spawnAgent } from "../guildctl/runner";
import { registerArtifact, setArtifactStatus, setArtifactWave } from "../registry/commands/artifacts";
import { applySchema } from "../registry/db/schema";

/**
 * Issue #295: the runner's pre-claim calls claimNextTask() directly on the
 * runner's SUPPLIED database connection instead of spawning the registry CLI.
 * The claim therefore binds to the exact connection the run records use — no
 * built dist path, no Node-on-PATH requirement, no second, env-resolved DB —
 * while atomic acquisition, claim-token handoff, expected output paths, and
 * artifact-specific prompts behave exactly as before.
 */

interface TrackedEnv {
  set(key: string, value: string | undefined): void;
  restore(): void;
}

function trackedEnv(): TrackedEnv {
  const previous = new Map<string, string | undefined>();
  return {
    set(key, value) {
      if (!previous.has(key)) previous.set(key, process.env[key]);
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    },
    restore() {
      for (const [key, value] of previous.entries()) {
        if (value == null) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

interface PreclaimScenario {
  db: Database.Database;
  dbPath: string;
  workspace: string;
  dbDir: string;
  close(): void;
}

/**
 * A workspace whose registry is NOT the supplied connection and NOT the env
 * default: the supplied DB lives outside the workspace entirely, and the env
 * variables point at a path that must never even be created. A pre-claim that
 * still went through the CLI subprocess would resolve its database from env or
 * defaults and could not claim against the supplied connection here.
 */
function setupScenario(prefix: string): PreclaimScenario {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix + "-db-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), prefix + "-ws-"));
  const dbPath = path.join(dbDir, "supplied-registry.db");
  const db = new Database(dbPath);
  applySchema(db);
  return {
    db,
    dbPath,
    workspace,
    dbDir,
    close: () => {
      db.close();
      fs.rmSync(dbDir, { recursive: true, force: true });
      fs.rmSync(workspace, { recursive: true, force: true });
    },
  };
}

test("runner preclaim claims through the supplied database and hands the claim token to the agent", async () => {
  const env = trackedEnv();
  const scenario = setupScenario("guild-preclaim-handoff");
  const envlog = path.join(scenario.dbDir, "envlog.txt");
  const bogusEnvDb = path.join(scenario.dbDir, "not-this.db");
  let seenArtifactId: string | undefined;
  try {
    const artifactId = "legacy-source:com.acme:PreclaimHandoff";
    registerArtifact(scenario.db, { id: artifactId, kind: "legacy-source", tier: "first-class", path: "legacy/PreclaimHandoff.java" });
    setArtifactWave(scenario.db, artifactId, 1);
    setArtifactStatus(scenario.db, artifactId, "planned");

    const harness = path.join(scenario.dbDir, "preclaim-agent.cjs");
    // The agent's environment is resolver-built (not the full parent env), so
    // the log path is baked into the harness itself.
    fs.writeFileSync(harness, [
      "const fs = require(\"node:fs\");",
      `fs.appendFileSync(${JSON.stringify(envlog)}, JSON.stringify({`,
      "  argv: process.argv.slice(2),",
      "  artifactId: process.env.GUILDCTL_ARTIFACT_ID ?? null,",
      "  claimId: process.env.GUILDCTL_CLAIM_ID ?? null,",
      "  claimToken: process.env.GUILDCTL_CLAIM_TOKEN ?? null,",
      "  runId: process.env.GUILDCTL_RUN_ID ?? null,",
      "}) + \"\\n\");",
      "process.exit(0);",
      "",
    ].join("\n"), "utf8");

    env.set("GUILD_WORKSPACE", scenario.workspace);
    env.set("REGISTRY_DB", bogusEnvDb);
    env.set("GUILDCTL_REGISTRY_DB", bogusEnvDb);
    env.set("AGENT_CMD", harness);

    const result = await spawnAgent({
      agent: "code-writer-agent",
      model: "test-model",
      prompt: "base prompt",
      db: scenario.db,
      claimOwner: "code-writer-agent:preclaim",
      preClaim: { fromStatus: "planned" },
      promptForArtifact: (id) => {
        seenArtifactId = id;
        return "artifact-specific prompt for " + id;
      },
    });

    // The claim landed in the SUPPLIED database: the atomic claim, its token,
    // and the derived expected output paths are all on this connection.
    const claimRow = scenario.db.prepare(
      "SELECT claim_id, claim_token, artifact_id, expected_output_paths, from_status FROM artifact_claims ORDER BY rowid DESC LIMIT 1",
    ).get() as { claim_id: string; claim_token: string; artifact_id: string; expected_output_paths: string | null; from_status: string };
    assert.equal(claimRow.artifact_id, artifactId);
    assert.equal(claimRow.from_status, "planned");
    assert.ok(claimRow.claim_id.length > 0, "claim token handoff requires a claim id");
    assert.ok(claimRow.claim_token.length > 0, "claim token handoff requires a claim token");
    const expectedOutputs = JSON.parse(claimRow.expected_output_paths ?? "null") as unknown;
    assert.ok(Array.isArray(expectedOutputs), "expected_output_paths must be parseable for the warden snapshot");

    assert.equal(scenario.db.prepare("SELECT COUNT(*) AS n FROM events WHERE artifact_id = ? AND type = 'claimed'").get(artifactId)?.n, 1);

    // The agent received the claim credentials and the artifact-specific prompt.
    assert.equal(seenArtifactId, artifactId, "promptForArtifact must see the preclaimed artifact id");
    const handoff = JSON.parse(fs.readFileSync(envlog, "utf8").trim().split("\n").pop()!) as {
      argv: string[];
      artifactId: string | null;
      claimId: string | null;
      claimToken: string | null;
      runId: string | null;
    };
    assert.equal(handoff.artifactId, artifactId);
    assert.equal(handoff.claimId, claimRow.claim_id);
    assert.equal(handoff.claimToken, claimRow.claim_token);
    assert.equal(handoff.runId, result.runId);
    assert.ok(
      handoff.argv.includes("artifact-specific prompt for " + artifactId),
      "the artifact-specific prompt must replace the base prompt for the spawned agent",
    );

    // Truthful close-out: the harness exited 0 without advancing the claim, so
    // the run is failed and the claim is released — never a false success.
    assert.equal(result.exitCode, 1);
    const run = scenario.db.prepare("SELECT status, exit_code FROM runs WHERE run_id = ?").get(result.runId) as { status: string; exit_code: number };
    assert.equal(run.status, "failed");
    assert.equal(run.exit_code, 1);
    const artifact = scenario.db.prepare("SELECT status, claimed_by FROM artifacts WHERE id = ?").get(artifactId) as { status: string; claimed_by: string | null };
    assert.equal(artifact.status, "planned");
    assert.equal(artifact.claimed_by, null);

    // No env-resolved database was ever opened: the claim did not go through a
    // subprocess that would have created one.
    assert.equal(fs.existsSync(bogusEnvDb), false, "the pre-claim must not open an env-resolved database");
  } finally {
    env.restore();
    scenario.close();
  }
});

test("runner preclaim with nothing to claim finishes the run cleanly and closes the log", async () => {
  const env = trackedEnv();
  const scenario = setupScenario("guild-preclaim-nowork");
  try {
    // Active-but-unclaimable work: an artifact already sitting in-progress
    // leaves no 'planned' candidate, so the claim reports "no claimable tasks"
    // (registry error code 2) — the runner's no-work outcome.
    const artifactId = "legacy-source:com.acme:PreclaimNoWork";
    registerArtifact(scenario.db, { id: artifactId, kind: "legacy-source", tier: "first-class", path: "legacy/PreclaimNoWork.java" });
    setArtifactWave(scenario.db, artifactId, 1);
    setArtifactStatus(scenario.db, artifactId, "in-progress");

    const harness = path.join(scenario.dbDir, "nowork-agent.cjs");
    fs.writeFileSync(harness, "process.exit(0);\n", "utf8");

    env.set("GUILD_WORKSPACE", scenario.workspace);
    env.set("AGENT_CMD", harness);

    const result = await spawnAgent({
      agent: "code-writer-agent",
      model: "test-model",
      prompt: "no-work regression",
      db: scenario.db,
      preClaim: { fromStatus: "planned" },
    });

    assert.equal(result.exitCode, 0, "no work must be a clean no-op, not a failure");
    const run = scenario.db.prepare("SELECT status, exit_code FROM runs WHERE run_id = ?").get(result.runId) as { status: string; exit_code: number };
    assert.equal(run.status, "completed");
    assert.equal(run.exit_code, 0);
    assert.equal(
      (scenario.db.prepare("SELECT COUNT(*) AS n FROM artifact_claims").get() as { n: number }).n,
      0,
      "a no-work preclaim must not leave a claim",
    );
    const untouched = scenario.db.prepare("SELECT status FROM artifacts WHERE id = ?").get(artifactId) as { status: string };
    assert.equal(untouched.status, "in-progress");
    if (result.logFile) {
      assert.ok(fs.existsSync(result.logFile), "the run log must exist for the no-work close-out");
    }
  } finally {
    env.restore();
    scenario.close();
  }
});

test("runner preclaim surfaces acquisition failures as a failed, finished run", async () => {
  const env = trackedEnv();
  const scenario = setupScenario("guild-preclaim-failure");
  try {
    // An empty registry: the claim layer refuses with a non-no-work registry
    // error ("all tasks complete"), which the runner maps to a failed run —
    // the same treatment the CLI's non-zero exits used to receive.
    const harness = path.join(scenario.dbDir, "failure-agent.cjs");
    fs.writeFileSync(harness, "process.exit(0);\n", "utf8");

    env.set("GUILD_WORKSPACE", scenario.workspace);
    env.set("AGENT_CMD", harness);

    const result = await spawnAgent({
      agent: "code-writer-agent",
      model: "test-model",
      prompt: "acquisition failure regression",
      db: scenario.db,
      preClaim: { fromStatus: "planned" },
    });

    assert.equal(result.exitCode, 1);
    const run = scenario.db.prepare("SELECT status, exit_code, termination_reason FROM runs WHERE run_id = ?").get(result.runId) as { status: string; exit_code: number; termination_reason: string | null };
    assert.equal(run.status, "failed");
    assert.equal(run.exit_code, 1);
    assert.match(run.termination_reason ?? "", /pre-claim failed/);
    assert.equal(
      (scenario.db.prepare("SELECT COUNT(*) AS n FROM artifact_claims").get() as { n: number }).n,
      0,
    );
    assert.equal(
      (scenario.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'claimed'").get() as { n: number }).n,
      0,
    );
  } finally {
    env.restore();
    scenario.close();
  }
});
