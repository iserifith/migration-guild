import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { DEFAULT_GUILD_CONFIG, stringifySimpleYaml } from "../guildctl/config";
import { runAutoCommand, REVIEW_MARKER } from "../guildctl/commands/auto";
import { registerArtifact, setArtifactStatus, setArtifactWave } from "../registry/commands/artifacts";
import { applySchema } from "../registry/db/schema";

/**
 * Issue #293: default autonomous verification executes the stack's per-artifact
 * check ONCE per attempt, and that single structured result supplies the
 * verification state, the close-out reporting, and the signed acceptance
 * evidence. Explicit --command runs remain a genuinely different check and keep
 * their own execution; an agent's own unverifiable self-report still wins; a
 * missing/broken stack still maps to unverified/no-stack-check; and recording
 * verification never becomes an approval gate.
 */

const RUNTIME_EVIDENCE_COUNT = 1;

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

interface JavaWorkspace {
  workspace: string;
  binDir: string;
  javacArgsFile: string;
  dbPath: string;
  db: Database.Database;
  cleanup: () => void;
}

/**
 * Scaffold a java-spring workspace whose verify scope resolves cleanly, a fake
 * `javac` that logs its argv, and a registry DB at a non-default absolute path.
 */
function makeJavaWorkspace(prefix: string): JavaWorkspace {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(os.tmpdir(), `${path.basename(workspace)}.registry.db`);
  fs.mkdirSync(path.join(workspace, "legacy"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "legacy", "App.java"), "class App {}\n");
  fs.mkdirSync(path.join(workspace, ".guild"), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".guild", "config.yaml"), configWithStack("java-spring"));
  const binDir = path.join(workspace, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const javacArgsFile = path.join(workspace, "javac-args.txt");

  const db = new Database(dbPath);
  applySchema(db);
  const artifactId = "legacy-source:com.acme:AutoVerify";
  registerArtifact(db, { id: artifactId, kind: "legacy-source", tier: "first-class", path: "legacy/App.java" });
  setArtifactWave(db, artifactId, 1);
  setArtifactStatus(db, artifactId, "planned");

  return {
    workspace,
    binDir,
    javacArgsFile,
    dbPath,
    db,
    cleanup: () => {
      db.close();
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(dbPath, { force: true });
    },
  };
}

/** Fake `javac`: records its argv (probe and check runs) and exits 0. */
function installFakeJavac(binDir: string, argsFile: string): void {
  fs.writeFileSync(path.join(binDir, "javac"), [
    "#!/usr/bin/env bash",
    `echo "$@" >> ${JSON.stringify(argsFile)}`,
    "exit 0",
    "",
  ].join("\n"), { mode: 0o755 });
}

/** javac invocations that are the actual per-artifact check (not the probe). */
function checkRunCount(javacArgsFile: string): number {
  if (!fs.existsSync(javacArgsFile)) return 0;
  return fs.readFileSync(javacArgsFile, "utf8")
    .split("\n")
    .filter((line) => line.includes("-proc:none"))
    .length;
}

function configWithStack(stack: string): string {
  return stringifySimpleYaml({
    ...DEFAULT_GUILD_CONFIG,
    stack,
    workspace: { name: "auto-single-verification-test", root: "." },
  } as unknown as Record<string, unknown>);
}

/**
 * The fake harness: the migrate phase writes the expected modern output and
 * finalizes the pre-existing claim through the handed registry CLI; the review
 * phase prints the structured approval marker. `extraMigrate` injects
 * per-test migrate-phase steps that run before the status write.
 */
function writeFakeHarness(file: string, extraMigrate: string[]): void {
  fs.writeFileSync(file, [
    "const { execSync } = require(\"node:child_process\");",
    "const fs = require(\"node:fs\");",
    "const path = require(\"node:path\");",
    "const registry = (args) => execSync([process.env.GUILDCTL_REGISTRY_CLI, ...args].join(\" \"), { cwd: process.cwd(), stdio: \"inherit\" });",
    "if (process.env.GUILDCTL_AUTO_PHASE === \"review\") {",
    "  console.log(" + JSON.stringify(REVIEW_MARKER) + " + JSON.stringify({ approved: true, reason: \"single-execution verification accepted\" }));",
    "  process.exit(0);",
    "}",
    ...extraMigrate,
    "fs.mkdirSync(path.join(process.cwd(), \"modern\"), { recursive: true });",
    "fs.writeFileSync(path.join(process.cwd(), \"modern\", \"App.java\"), \"public class App { public int one() { return 1; } }\\n\");",
    "registry([",
    "  \"set-artifact-status\",",
    "  \"--id\", process.env.GUILDCTL_ARTIFACT_ID,",
    "  \"--status\", \"migrated\",",
    "  \"--agent\", process.env.GUILDCTL_AUTO_PHASE === \"repair\" ? \"remediation-agent\" : \"code-writer-agent\",",
    "  \"--claim-id\", process.env.GUILDCTL_CLAIM_ID,",
    "  \"--claim-token\", process.env.GUILDCTL_CLAIM_TOKEN,",
    "]);",
    "",
  ].join("\n"), "utf8");
}

const ARTIFACT_ID = "legacy-source:com.acme:AutoVerify";

test("default autonomous verification executes the stack check once and reuses it for state, reporting, and evidence", async () => {
  const ws = makeJavaWorkspace("guild-auto-verify-once-");
  try {
    installFakeJavac(ws.binDir, ws.javacArgsFile);
    const harness = path.join(ws.workspace, "fake-agent.cjs");
    writeFakeHarness(harness, []);

    let result: Awaited<ReturnType<typeof runAutoCommand>> | undefined;
    await withEnv({
      AGENT_CMD: harness,
      GUILD_WORKSPACE: ws.workspace,
      PATH: `${ws.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    }, async () => {
      result = await runAutoCommand(ws.db, {
        artifact: ARTIFACT_ID,
        maxAttempts: 1,
        registryDbPath: ws.dbPath,
      });
    });
    assert.ok(result, "runAutoCommand must return a result");

    // Exactly ONE execution of the executable stack check for the attempt.
    assert.equal(checkRunCount(ws.javacArgsFile), 1, "the default stack check must execute exactly once per attempt");

    // The single result supplies consistent verification state...
    const verification = ws.db.prepare(
      "SELECT state, method, reason FROM artifact_verifications WHERE artifact_id = ?",
    ).get(ARTIFACT_ID) as { state: string; method: string; reason: string | null };
    assert.equal(verification.state, "verified");
    assert.equal(verification.method, "javac-scope-compile");
    assert.equal(verification.reason, null);

    // ...signed acceptance evidence from that one execution...
    const evidence = ws.db.prepare(
      "SELECT evidence_type, pass, produced_by, run_id, authenticity FROM acceptance_evidence WHERE artifact_id = ? AND evidence_type = 'runtime'",
    ).all(ARTIFACT_ID) as Array<{ evidence_type: string; pass: number; produced_by: string; run_id: string | null; authenticity: string | null }>;
    assert.equal(evidence.length, RUNTIME_EVIDENCE_COUNT, "the single execution must record exactly one runtime evidence row");
    assert.equal(evidence[0].pass, 1);
    assert.equal(evidence[0].produced_by, "guildctl-verify-stack");
    assert.match(evidence[0].authenticity ?? "", /^hmac-sha256:/, "runtime evidence must be signed");
    assert.equal(evidence[0].run_id, result.runId, "evidence must be bound to the run that produced it");

    // ...and recording verification still is not the gate: the existing
    // arbitration rules ran on this evidence and approved the artifact.
    assert.equal(result.status, "complete");
    const artifact = ws.db.prepare("SELECT status FROM artifacts WHERE id = ?").get(ARTIFACT_ID) as { status: string };
    assert.equal(artifact.status, "reviewed");
    const decision = ws.db.prepare("SELECT arbiter, decision FROM arbitration_decisions WHERE artifact_id = ?").get(ARTIFACT_ID) as { arbiter: string; decision: string };
    assert.equal(decision.arbiter, "review-agent");
    assert.equal(decision.decision, "approved");
  } finally {
    process.exitCode = 0;
    ws.cleanup();
  }
});

test("an explicit --command keeps its own execution distinct from the stack check", async () => {
  const ws = makeJavaWorkspace("guild-auto-verify-explicit-");
  try {
    installFakeJavac(ws.binDir, ws.javacArgsFile);
    // Pre-existing check script: outside the claim's output paths, never touched.
    fs.writeFileSync(path.join(ws.workspace, "check-ok.js"), "process.exit(0);\n");
    const harness = path.join(ws.workspace, "fake-agent.cjs");
    writeFakeHarness(harness, []);

    let result: Awaited<ReturnType<typeof runAutoCommand>> | undefined;
    await withEnv({
      AGENT_CMD: harness,
      GUILD_WORKSPACE: ws.workspace,
      PATH: `${ws.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    }, async () => {
      result = await runAutoCommand(ws.db, {
        artifact: ARTIFACT_ID,
        command: ["node check-ok.js"],
        maxAttempts: 1,
        registryDbPath: ws.dbPath,
      });
    });
    assert.ok(result, "runAutoCommand must return a result");

    // The stack check still runs at claim close — once — and the explicitly
    // requested different check runs its own execution with its own evidence.
    assert.equal(checkRunCount(ws.javacArgsFile), 1);
    const explicitEvidence = ws.db.prepare(
      "SELECT command, produced_by FROM acceptance_evidence WHERE artifact_id = ? AND evidence_type = 'runtime' AND command LIKE '%check-ok.js%'",
    ).all(ARTIFACT_ID) as Array<{ command: string; produced_by: string }>;
    assert.equal(explicitEvidence.length, 1, "the explicit command must record its own evidence");
    const artifact = ws.db.prepare("SELECT status FROM artifacts WHERE id = ?").get(ARTIFACT_ID) as { status: string };
    assert.equal(artifact.status, "reviewed");
  } finally {
    process.exitCode = 0;
    ws.cleanup();
  }
});

test("an agent-reported-unverifiable self-report wins and is not overwritten by a later default check", async () => {
  const ws = makeJavaWorkspace("guild-auto-verify-selfreport-");
  try {
    installFakeJavac(ws.binDir, ws.javacArgsFile);
    const harness = path.join(ws.workspace, "fake-agent.cjs");
    writeFakeHarness(harness, [
      "registry([",
      "  \"set-verification\",",
      "  \"--id\", process.env.GUILDCTL_ARTIFACT_ID,",
      "  \"--state\", \"unverified\",",
      "  \"--method\", \"self-report\",",
      "  \"--reason\", \"agent-reported-unverifiable\",",
      "  \"--claim-id\", process.env.GUILDCTL_CLAIM_ID,",
      "  \"--claim-token\", process.env.GUILDCTL_CLAIM_TOKEN,",
      "]);",
    ]);

    let result: Awaited<ReturnType<typeof runAutoCommand>> | undefined;
    await withEnv({
      AGENT_CMD: harness,
      GUILD_WORKSPACE: ws.workspace,
      PATH: `${ws.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    }, async () => {
      result = await runAutoCommand(ws.db, {
        artifact: ARTIFACT_ID,
        maxAttempts: 1,
        registryDbPath: ws.dbPath,
      });
    });
    assert.ok(result, "runAutoCommand must return a result");

    // The self-report short-circuits before the stack check (and its
    // availability probe) can run: zero javac invocations.
    assert.equal(checkRunCount(ws.javacArgsFile), 0, "no check may execute over an agent-reported-unverifiable self-report");

    const verification = ws.db.prepare(
      "SELECT state, reason, method FROM artifact_verifications WHERE artifact_id = ?",
    ).get(ARTIFACT_ID) as { state: string; reason: string; method: string };
    assert.equal(verification.state, "unverified");
    assert.equal(verification.reason, "agent-reported-unverifiable");
    assert.equal(verification.method, "self-report");

    // No execution means no evidence: the attempt closes as rework, not as a
    // verified completion, and recording never gates via some new path — the
    // existing budget close-out applies.
    const runtimeEvidence = ws.db.prepare(
      "SELECT COUNT(*) AS n FROM acceptance_evidence WHERE artifact_id = ? AND evidence_type = 'runtime'",
    ).get(ARTIFACT_ID) as { n: number };
    assert.equal(runtimeEvidence.n, 0);
    const eventTypes = (ws.db.prepare("SELECT type FROM events WHERE artifact_id = ? ORDER BY rowid").all(ARTIFACT_ID) as Array<{ type: string }>).map((e) => e.type);
    assert.ok(eventTypes.includes("auto-rework"));
    assert.ok(!eventTypes.includes("auto-completed"));
    const artifact = ws.db.prepare("SELECT status FROM artifacts WHERE id = ?").get(ARTIFACT_ID) as { status: string };
    assert.equal(artifact.status, "blocked");
  } finally {
    process.exitCode = 0;
    ws.cleanup();
  }
});

test("a missing stack pack maps to unverified/no-stack-check and executes nothing", async () => {
  const ws = makeJavaWorkspace("guild-auto-verify-nostack-");
  try {
    // Even with the toolchain present, a broken stack pack resolves no check.
    installFakeJavac(ws.binDir, ws.javacArgsFile);
    fs.writeFileSync(path.join(ws.workspace, ".guild", "config.yaml"), configWithStack("no-such-pack"));
    const harness = path.join(ws.workspace, "fake-agent.cjs");
    writeFakeHarness(harness, []);

    let result: Awaited<ReturnType<typeof runAutoCommand>> | undefined;
    await withEnv({
      AGENT_CMD: harness,
      GUILD_WORKSPACE: ws.workspace,
      PATH: `${ws.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    }, async () => {
      result = await runAutoCommand(ws.db, {
        artifact: ARTIFACT_ID,
        maxAttempts: 1,
        registryDbPath: ws.dbPath,
      });
    });
    assert.ok(result, "runAutoCommand must return a result");

    assert.equal(checkRunCount(ws.javacArgsFile), 0);
    const verification = ws.db.prepare(
      "SELECT state, reason FROM artifact_verifications WHERE artifact_id = ?",
    ).get(ARTIFACT_ID) as { state: string; reason: string };
    // A missing/broken stack is NOT a failed verification.
    assert.equal(verification.state, "unverified");
    assert.equal(verification.reason, "no-stack-check");
    const runtimeEvidence = ws.db.prepare(
      "SELECT COUNT(*) AS n FROM acceptance_evidence WHERE artifact_id = ? AND evidence_type = 'runtime'",
    ).get(ARTIFACT_ID) as { n: number };
    assert.equal(runtimeEvidence.n, 0);
    const artifact = ws.db.prepare("SELECT status FROM artifacts WHERE id = ?").get(ARTIFACT_ID) as { status: string };
    assert.equal(artifact.status, "blocked");
  } finally {
    process.exitCode = 0;
    ws.cleanup();
  }
});
