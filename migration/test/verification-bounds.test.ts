import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import type { PerArtifactVerify } from "../guildctl/stack";
import { buildVerificationScope, runArtifactVerification } from "../guildctl/verify";
import { registerArtifact, setArtifactStatus } from "../registry/commands/artifacts";
import { claimArtifactById, createRunOperatorCredential } from "../registry/commands/claim";
import { getVerification } from "../registry/commands/verification";
import { applySchema } from "../registry/db/schema";
import { makeTempDir } from "./truthful-run-state-fixtures";

/**
 * US1 (FR-003, FR-004, FR-005, FR-006): verification is bounded to the claimed
 * unit plus one hop of declared dependencies, never waits on a tree-wide build,
 * never reads outside the workspace, and never blocks an artifact.
 */

const CLAIMED = "legacy-source:com.acme:Claimed";
const ONE_HOP = "legacy-source:com.acme:OneHop";
const TWO_HOP = "legacy-source:com.acme:TwoHop";

interface Fixture {
  db: Database.Database;
  root: string;
  runId: string;
  operatorToken: string;
  cleanup: () => void;
}

function createFixture(): Fixture {
  const root = makeTempDir("guild-verify-bounds-");
  const db = new Database(":memory:");
  applySchema(db);

  for (const [id, file] of [
    [CLAIMED, "Claimed"],
    [ONE_HOP, "OneHop"],
    [TWO_HOP, "TwoHop"],
  ] as const) {
    registerArtifact(db, {
      id,
      kind: "legacy-source",
      tier: "first-class",
      path: `legacy/src/main/java/com/acme/${file}.java`,
    });
    const modern = path.join(root, "modern", "src", "main", "java", "com", "acme", `${file}.java`);
    fs.mkdirSync(path.dirname(modern), { recursive: true });
    fs.writeFileSync(modern, `class ${file} {}\n`);
  }

  // Claimed → OneHop → TwoHop. Only the first hop may ever enter scope.
  db.prepare("INSERT INTO source_dependencies (dependent_id, dependency_id, signal) VALUES (?, ?, 'import')").run(CLAIMED, ONE_HOP);
  db.prepare("INSERT INTO source_dependencies (dependent_id, dependency_id, signal) VALUES (?, ?, 'import')").run(ONE_HOP, TWO_HOP);

  const runId = "run-bounds-0001";
  db.prepare("INSERT INTO runs (run_id, agent, owner_id, status) VALUES (?, 'code-writer-agent', 'guildctl', 'running')").run(runId);
  const operatorToken = createRunOperatorCredential(db, runId).token;

  setArtifactStatus(db, CLAIMED, "planned", { agent: "planner-agent" });
  setArtifactStatus(db, ONE_HOP, "planned", { agent: "planner-agent" });
  claimArtifactById(db, { artifactId: CLAIMED, agent: "code-writer-agent", ownerId: "owner-1", runId, fromStatus: "planned" });

  return {
    db,
    root,
    runId,
    operatorToken,
    cleanup: () => {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** A verify block that always passes, so the *bounds* are what is under test. */
function passingCheck(overrides: Partial<PerArtifactVerify> = {}): PerArtifactVerify {
  return {
    id: "test-check",
    cmd: process.execPath,
    args: ["-e", "process.exit(0)"],
    availability_args: ["--version"],
    pass_exit_codes: [0],
    ...overrides,
  };
}

test("scope is the claim's own outputs plus one hop, never the transitive closure", () => {
  const fixture = createFixture();
  try {
    setArtifactStatus(fixture.db, ONE_HOP, "migrated", { agent: "code-writer-agent" });

    const scope = buildVerificationScope(fixture.db, {
      artifactId: CLAIMED,
      workspaceRoot: fixture.root,
    });

    assert.equal(scope.artifactId, CLAIMED);
    assert.ok(scope.ownOutputPaths.some((p) => p.includes("Claimed")));
    assert.ok(scope.dependencyPaths.some((p) => p.includes("OneHop")), "one hop is in scope");
    assert.equal(
      [...scope.ownOutputPaths, ...scope.dependencyPaths].some((p) => p.includes("TwoHop")),
      false,
      "the second hop must never enter scope",
    );
  } finally {
    fixture.cleanup();
  }
});

test("every substituted path is asserted inside the workspace root", () => {
  const fixture = createFixture();
  try {
    const scope = buildVerificationScope(fixture.db, {
      artifactId: CLAIMED,
      workspaceRoot: fixture.root,
    });
    for (const relative of [...scope.ownOutputPaths, ...scope.dependencyPaths]) {
      const resolved = path.resolve(fixture.root, relative);
      assert.equal(resolved.startsWith(path.resolve(fixture.root) + path.sep), true, `${relative} escaped the workspace`);
    }
  } finally {
    fixture.cleanup();
  }
});

test("a path that escapes the workspace yields verification-failed / check-error", async () => {
  const fixture = createFixture();
  try {
    setArtifactStatus(fixture.db, ONE_HOP, "migrated", { agent: "code-writer-agent" });
    // A claim recording an escaping output path must abort the check, not run it.
    fixture.db.prepare("UPDATE artifact_claims SET expected_output_paths = ? WHERE artifact_id = ?")
      .run(JSON.stringify(["../../etc/passwd"]), CLAIMED);

    const outcome = await runArtifactVerification(fixture.db, {
      artifactId: CLAIMED,
      workspaceRoot: fixture.root,
      check: passingCheck(),
      runId: fixture.runId,
      operatorToken: fixture.operatorToken,
    });

    assert.equal(outcome.state, "verification-failed");
    assert.equal(outcome.reason, "check-error");
    assert.equal(getVerification(fixture.db, CLAIMED).state, "verification-failed");
  } finally {
    fixture.cleanup();
  }
});

test("a working_dir outside the workspace yields verification-failed / check-error", async () => {
  const fixture = createFixture();
  try {
    setArtifactStatus(fixture.db, ONE_HOP, "migrated", { agent: "code-writer-agent" });

    const outcome = await runArtifactVerification(fixture.db, {
      artifactId: CLAIMED,
      workspaceRoot: fixture.root,
      check: passingCheck({ working_dir: "../outside" }),
      runId: fixture.runId,
      operatorToken: fixture.operatorToken,
    });

    assert.equal(outcome.state, "verification-failed");
    assert.equal(outcome.reason, "check-error");
  } finally {
    fixture.cleanup();
  }
});

test("an unmigrated one-hop dependency records unverified / tree-incomplete and never blocks the artifact", async () => {
  const fixture = createFixture();
  try {
    // ONE_HOP is left at 'planned' — the tree is incomplete.
    const outcome = await runArtifactVerification(fixture.db, {
      artifactId: CLAIMED,
      workspaceRoot: fixture.root,
      check: passingCheck(),
      runId: fixture.runId,
      operatorToken: fixture.operatorToken,
    });

    assert.equal(outcome.state, "unverified");
    assert.equal(outcome.reason, "tree-incomplete");
    assert.equal(outcome.ranCheck, false, "the check must not run against an incomplete tree");

    // The claimed artifact still advances: verification informs, it does not gate.
    setArtifactStatus(fixture.db, CLAIMED, "migrated", {
      agent: "guildctl",
      runId: fixture.runId,
      operatorToken: fixture.operatorToken,
    });
    const status = fixture.db.prepare("SELECT status FROM artifacts WHERE id = ?").get(CLAIMED) as { status: string };
    assert.equal(status.status, "migrated");
  } finally {
    fixture.cleanup();
  }
});

test("the budget terminates the check's process group and records unverified / budget-exhausted", async () => {
  const fixture = createFixture();
  try {
    setArtifactStatus(fixture.db, ONE_HOP, "migrated", { agent: "code-writer-agent" });

    const outcome = await runArtifactVerification(fixture.db, {
      artifactId: CLAIMED,
      workspaceRoot: fixture.root,
      // Sleeps far past its budget; the budget must stop it rather than wait.
      check: passingCheck({ args: ["-e", "setTimeout(() => {}, 60000)"], budget_seconds: undefined }),
      budgetMs: 400,
      runId: fixture.runId,
      operatorToken: fixture.operatorToken,
    });

    assert.equal(outcome.state, "unverified");
    assert.equal(outcome.reason, "budget-exhausted");
    assert.ok(outcome.durationMs != null && outcome.durationMs < 30_000, "the check must not outlive its budget");

    const stored = getVerification(fixture.db, CLAIMED);
    assert.equal(stored.state, "unverified");
    assert.equal(stored.reason, "budget-exhausted");
    assert.equal(stored.budget_ms, 400, "the effective budget is reported from the record");

    // The claim still closes even though verification was cut short.
    setArtifactStatus(fixture.db, CLAIMED, "migrated", {
      agent: "guildctl",
      runId: fixture.runId,
      operatorToken: fixture.operatorToken,
    });
    const status = fixture.db.prepare("SELECT status FROM artifacts WHERE id = ?").get(CLAIMED) as { status: string };
    assert.equal(status.status, "migrated");
  } finally {
    fixture.cleanup();
  }
});

test("a passing bounded check records verified with the scope it actually covered", async () => {
  const fixture = createFixture();
  try {
    setArtifactStatus(fixture.db, ONE_HOP, "migrated", { agent: "code-writer-agent" });

    const outcome = await runArtifactVerification(fixture.db, {
      artifactId: CLAIMED,
      workspaceRoot: fixture.root,
      check: passingCheck(),
      runId: fixture.runId,
      operatorToken: fixture.operatorToken,
    });

    assert.equal(outcome.state, "verified");
    assert.equal(outcome.reason, null);
    const stored = getVerification(fixture.db, CLAIMED);
    assert.equal(stored.state, "verified");
    assert.equal(stored.method, "test-check");
    assert.ok(stored.duration_ms != null);
    const scope = JSON.parse(String(stored.scope_json)) as string[];
    assert.ok(scope.length > 0, "a verified record must say what it verified");
    assert.equal(scope.some((p) => p.includes("TwoHop")), false);
  } finally {
    fixture.cleanup();
  }
});

test("a failing availability probe degrades to unverified / no-stack-check, not verification-failed", async () => {
  const fixture = createFixture();
  try {
    setArtifactStatus(fixture.db, ONE_HOP, "migrated", { agent: "code-writer-agent" });

    const outcome = await runArtifactVerification(fixture.db, {
      artifactId: CLAIMED,
      workspaceRoot: fixture.root,
      check: passingCheck({
        cmd: path.join(fixture.root, "definitely-not-installed"),
        availability_args: ["--version"],
        unavailable_note: "toolchain missing; per-artifact verification was skipped",
      }),
      runId: fixture.runId,
      operatorToken: fixture.operatorToken,
    });

    assert.equal(outcome.state, "unverified");
    assert.equal(outcome.reason, "no-stack-check", "a missing toolchain is not a failed verification");
  } finally {
    fixture.cleanup();
  }
});

test("no verify: block at all maps to unverified / no-stack-check", async () => {
  const fixture = createFixture();
  try {
    setArtifactStatus(fixture.db, ONE_HOP, "migrated", { agent: "code-writer-agent" });

    const outcome = await runArtifactVerification(fixture.db, {
      artifactId: CLAIMED,
      workspaceRoot: fixture.root,
      check: undefined,
      runId: fixture.runId,
      operatorToken: fixture.operatorToken,
    });

    assert.equal(outcome.state, "unverified");
    assert.equal(outcome.reason, "no-stack-check");
  } finally {
    fixture.cleanup();
  }
});

test("a non-passing exit code maps to verification-failed / check-failed", async () => {
  const fixture = createFixture();
  try {
    setArtifactStatus(fixture.db, ONE_HOP, "migrated", { agent: "code-writer-agent" });

    const outcome = await runArtifactVerification(fixture.db, {
      artifactId: CLAIMED,
      workspaceRoot: fixture.root,
      check: passingCheck({ args: ["-e", "process.exit(3)"] }),
      runId: fixture.runId,
      operatorToken: fixture.operatorToken,
    });

    assert.equal(outcome.state, "verification-failed");
    assert.equal(outcome.reason, "check-failed");
  } finally {
    fixture.cleanup();
  }
});

test("scope construction performs no filesystem globbing and reads nothing outside the workspace", () => {
  const fixture = createFixture();
  const readdir = fs.readdirSync;
  const readFile = fs.readFileSync;
  const outside: string[] = [];
  let globbed = 0;
  try {
    setArtifactStatus(fixture.db, ONE_HOP, "migrated", { agent: "code-writer-agent" });
    const root = path.resolve(fixture.root);

    (fs as { readdirSync: typeof fs.readdirSync }).readdirSync = ((...args: Parameters<typeof readdir>) => {
      globbed += 1;
      return readdir(...args);
    }) as typeof fs.readdirSync;
    (fs as { readFileSync: typeof fs.readFileSync }).readFileSync = ((...args: Parameters<typeof readFile>) => {
      const target = args[0];
      if (typeof target === "string" && path.isAbsolute(target) && !path.resolve(target).startsWith(root)) {
        outside.push(target);
      }
      return readFile(...args);
    }) as typeof fs.readFileSync;

    buildVerificationScope(fixture.db, { artifactId: CLAIMED, workspaceRoot: fixture.root });

    assert.equal(globbed, 0, "scope construction must not walk the filesystem");
    assert.deepEqual(outside, [], "scope construction must not read outside the workspace");
  } finally {
    (fs as { readdirSync: typeof fs.readdirSync }).readdirSync = readdir;
    (fs as { readFileSync: typeof fs.readFileSync }).readFileSync = readFile;
    fixture.cleanup();
  }
});
