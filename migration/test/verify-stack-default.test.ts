import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { DEFAULT_GUILD_CONFIG, stringifySimpleYaml, type GuildConfig } from "../guildctl/config";
import { runVerifyCommand } from "../guildctl/commands/verify";
import { hasRemediationConfirmedNoDefect, REMEDIATION_CONFIRMED_NO_DEFECT } from "../guildctl/supervisor/loop";
import { loadActiveStack, resolvePerArtifactVerify } from "../guildctl/stack";
import { runArtifactVerification } from "../guildctl/verify";
import { registerArtifact, setArtifactStatus } from "../registry/commands/artifacts";
import { claimArtifactById, createRunOperatorCredential } from "../registry/commands/claim";
import { appendEvent, getEvents } from "../registry/commands/events";
import { approveArtifactWithEvidence } from "../registry/commands/evidence";
import { startRun } from "../registry/commands/runs";
import { getVerification } from "../registry/commands/verification";
import { applySchema } from "../registry/db/schema";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

/**
 * Scaffold a java-spring workspace whose verify scope resolves cleanly so the
 * per-artifact check actually runs, and point the process at it. Returns the
 * workspace plus the bin dir a fake `javac` can be dropped into.
 */
function makeJavaWorkspace(
  opts: { isolatePath?: boolean } = {},
): { workspace: string; binDir: string; javacArgsFile: string; cleanup: () => void } {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "guild-verify-stack-"));
  fs.mkdirSync(path.join(workspace, "modern", "src", "main", "java", "com", "acme"), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, "modern", "src", "main", "java", "com", "acme", "App.java"),
    "package com.acme;\npublic class App { public int one() { return 1; } }\n",
  );
  fs.mkdirSync(path.join(workspace, "legacy"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "legacy", "App.java"), "class App {}\n");
  const binDir = path.join(workspace, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const javacArgsFile = path.join(workspace, "javac-args.txt");

  const previousCwd = process.cwd();
  const previousWorkspaceEnv = process.env.GUILD_WORKSPACE;
  const previousPath = process.env.PATH;
  process.env.GUILD_WORKSPACE = workspace;
  // isolatePath: PATH is *only* binDir, so a `javac` genuinely can't be found
  // via lookup — prepending binDir to the inherited PATH (the non-isolated
  // default below) still lets a real javac elsewhere on PATH (e.g. the JDK
  // GitHub Actions' Ubuntu runners ship by default) resolve and run for real.
  process.env.PATH = opts.isolatePath ? binDir : `${binDir}${path.delimiter}${previousPath ?? ""}`;
  process.chdir(workspace);
  return {
    workspace,
    binDir,
    javacArgsFile,
    cleanup: () => {
      process.chdir(previousCwd);
      if (previousWorkspaceEnv == null) delete process.env.GUILD_WORKSPACE;
      else process.env.GUILD_WORKSPACE = previousWorkspaceEnv;
      if (previousPath == null) delete process.env.PATH;
      else process.env.PATH = previousPath;
      fs.rmSync(workspace, { recursive: true, force: true });
    },
  };
}

/** Drop a fake `javac` into binDir that records its argv and exits 0. */
function installFakeJavac(binDir: string, argsFile: string): void {
  const script =
    "#!/usr/bin/env bash\n" +
    `echo "$@" >> ${JSON.stringify(argsFile)}\n` +
    "exit 0\n";
  const javacPath = path.join(binDir, "javac");
  fs.writeFileSync(javacPath, script, { mode: 0o755 });
  fs.chmodSync(javacPath, 0o755);
}

function configWithStack(stack: string): GuildConfig {
  return {
    ...DEFAULT_GUILD_CONFIG,
    stack,
    workspace: { name: "verify-stack-test", root: "." },
  };
}

function seedClaimedJavaArtifact(db: Database.Database): string {
  const id = "legacy-source:com.acme:App";
  registerArtifact(db, {
    id,
    kind: "legacy-source",
    tier: "first-class",
    path: "legacy/App.java",
  });
  // Active claim so expected_output_paths resolves; mark migrated so the scope
  // has an output path and no unmigrated dependencies.
  db.prepare("UPDATE artifacts SET status = 'in-progress' WHERE id = ?").run(id);
  const claim = claimArtifactById(db, {
    artifactId: id,
    agent: "code-writer-agent",
    ownerId: "code-writer-agent",
    model: "test",
    fromStatus: "in-progress",
  });
  setArtifactStatus(db, id, "migrated", {
    agent: "code-writer-agent",
    claimId: claim.claim_id,
    claimToken: claim.claim_token,
  });
  return id;
}

test("US2: a bare `verify` (no --command) resolves the stack pack's javac check, never npm test", async () => {
  const db = createDb();
  const { workspace, binDir, javacArgsFile, cleanup } = makeJavaWorkspace();
  try {
    installFakeJavac(binDir, javacArgsFile);
    fs.mkdirSync(path.join(workspace, ".guild"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, ".guild", "config.yaml"),
      stringifySimpleYaml(configWithStack("java-spring") as unknown as Record<string, unknown>),
    );
    const id = seedClaimedJavaArtifact(db);

    let resultError: unknown = null;
    try {
      await runVerifyCommand(db, { artifact: id });
    } catch (error) {
      resultError = error;
    }
    assert.equal(resultError, null, "verify command should not throw");

    // The stack check ran javac (both the availability probe and the compile),
    // and never fell back to an npm command.
    const javacRuns = fs.existsSync(javacArgsFile) ? fs.readFileSync(javacArgsFile, "utf8") : "";
    assert.ok(javacRuns.length > 0, "expected the stack javac check to run");
    assert.ok(javacRuns.includes("-proc:none"), `expected the javac-scope-compile args, got:\n${javacRuns}`);
    assert.ok(!/npm (test|error)/.test(javacRuns), `must not fall back to npm test, got:\n${javacRuns}`);

    const verification = getVerification(db, id);
    assert.equal(verification.state, "verified");
    assert.notEqual(verification.method, "none");
  } finally {
    db.close();
    cleanup();
  }
});

test("US2: a passing stack-resolved check produces evidence that can back an arbitration approval", async () => {
  const db = createDb();
  const { workspace, binDir, javacArgsFile, cleanup } = makeJavaWorkspace();
  try {
    installFakeJavac(binDir, javacArgsFile);
    fs.mkdirSync(path.join(workspace, ".guild"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, ".guild", "config.yaml"),
      stringifySimpleYaml(configWithStack("java-spring") as unknown as Record<string, unknown>),
    );
    const id = seedClaimedJavaArtifact(db);
    const check = resolvePerArtifactVerify(loadActiveStack(configWithStack("java-spring"), workspace));

    const run = startRun(db, { agent: "guildctl-auto", ownerId: "guildctl-auto", phase: "auto", prompt: `auto ${id}` });
    const operator = createRunOperatorCredential(db, run.run_id);

    const outcome = await runArtifactVerification(db, {
      artifactId: id,
      workspaceRoot: workspace,
      check,
      runId: run.run_id,
      operatorToken: operator.token,
      recordEvidence: true,
    });
    assert.equal(outcome.state, "verified");
    assert.equal(outcome.evidence.length, 1, "a passing stack check must record exactly one evidence row");
    assert.equal(outcome.evidence[0].evidence_type, "runtime");
    assert.equal(outcome.evidence[0].pass, 1);

    // This is exactly what the supervisor loop does after a passing
    // verification: approve using the run credential that produced it.
    const decision = approveArtifactWithEvidence(db, {
      artifactId: id,
      arbiter: "independent-reviewer-agent",
      reason: "stack check passed",
      evidenceIds: outcome.evidence.map((item) => item.evidence_id),
      runId: run.run_id,
      operatorToken: operator.token,
    });
    assert.equal(decision.decision, "approved");
  } finally {
    db.close();
    cleanup();
  }
});

test("US2: a missing javac toolchain maps to unverified/no-stack-check, not a blocked artifact", async () => {
  const db = createDb();
  // isolatePath: PATH is scoped to an empty binDir with no fake javac
  // installed, so the availability probe fails regardless of whether the
  // host running this test happens to have a real javac on its own PATH.
  const { workspace, cleanup } = makeJavaWorkspace({ isolatePath: true });
  try {
    fs.mkdirSync(path.join(workspace, ".guild"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, ".guild", "config.yaml"),
      stringifySimpleYaml(configWithStack("java-spring") as unknown as Record<string, unknown>),
    );
    const id = seedClaimedJavaArtifact(db);

    await runVerifyCommand(db, { artifact: id });

    const verification = getVerification(db, id);
    assert.equal(verification.state, "unverified");
    assert.equal(verification.reason, "no-stack-check");
    const artifact = db.prepare("SELECT status FROM artifacts WHERE id = ?").get(id) as { status: string };
    assert.notEqual(artifact.status, "blocked", "a missing toolchain must not block the artifact");
  } finally {
    // runVerifyCommand is a CLI wrapper that sets process.exitCode=1 on a
    // non-pass outcome; clear it so the test harness doesn't report a failure.
    process.exitCode = 0;
    db.close();
    cleanup();
  }
});

test("US2: a remediation-confirmed-no-defect event is recorded and detectable by the supervisor signal reader", () => {
  const db = createDb();
  try {
    const id = "legacy-source:com.acme:NoDefect";
    registerArtifact(db, { id, kind: "legacy-source", tier: "first-class", path: "legacy/NoDefect.java" });
    assert.equal(hasRemediationConfirmedNoDefect(db, id), false);

    // The remediation pass appends the signal via the existing appendEvent mechanism.
    appendEvent(db, {
      id,
      type: REMEDIATION_CONFIRMED_NO_DEFECT,
      agent: "remediation-agent",
      summary: "no defect reproduced; not a real failure",
    });

    assert.equal(hasRemediationConfirmedNoDefect(db, id), true);
    const events = getEvents(db, id, REMEDIATION_CONFIRMED_NO_DEFECT);
    assert.equal(events.length, 1);
  } finally {
    db.close();
  }
});
