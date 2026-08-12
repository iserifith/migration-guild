import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { sha256, signRuntimeEvidence } from "../guildctl/verify";
import { registerArtifact, setArtifactStatus } from "../registry/commands/artifacts";
import { createRunOperatorCredential } from "../registry/commands/claim";
import {
  addApprovedCompanionOutput,
  addVerifierRuntimeEvidence,
  approveArtifactWithEvidence,
} from "../registry/commands/evidence";
import { applySchema } from "../registry/db/schema";

const ARTIFACT_ID = "legacy-source:com.acme:PromotionCommitTest";
const LEGACY_PATH = "legacy/src/PromotionCommitTest.txt";
const MODERN_PATH = "modern/src/PromotionCommitTest.txt";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

// See the matching comment in registry/commands/evidence.ts: a test run
// invoked from inside this repo's own pre-commit hook inherits GIT_DIR /
// GIT_WORK_TREE / GIT_INDEX_FILE, which would otherwise redirect these
// fixture repos' git commands at the outer checkout instead of `root`.
const GIT_SCOPE_ENV: NodeJS.ProcessEnv = { ...process.env };
for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_CEILING_DIRECTORIES", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR"]) {
  delete GIT_SCOPE_ENV[key];
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", env: GIT_SCOPE_ENV });
}

function initGitRepo(root: string): void {
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "guild@example.com"]);
  git(root, ["config", "user.name", "guild"]);
  fs.writeFileSync(path.join(root, "README.md"), "seed\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-q", "-m", "seed"]);
}

function commitCount(root: string): number {
  return parseInt(git(root, ["rev-list", "--count", "HEAD"]).trim(), 10);
}

function filesInHead(root: string): string[] {
  return git(root, ["ls-tree", "-r", "--name-only", "HEAD"])
    .trim()
    .split("\n")
    .filter(Boolean);
}

function registerFixture(db: Database.Database): void {
  registerArtifact(db, {
    id: ARTIFACT_ID,
    kind: "legacy-source",
    tier: "first-class",
    path: LEGACY_PATH,
  });
}

function setupSignedEvidence(db: Database.Database): { runId: string; operatorToken: string } {
  const runId = `run-${Math.random().toString(16).slice(2)}`;
  db.prepare("INSERT INTO runs (run_id, agent, owner_id, status) VALUES (?, 'guildctl-verify', 'guildctl', 'running')").run(runId);
  const operatorToken = createRunOperatorCredential(db, runId).token;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guild-promotion-evidence-"));
  const log = "runtime ok\n";
  const logPath = path.join(dir, "runtime.log");
  fs.writeFileSync(logPath, log);
  const logSha256 = sha256(log);
  addVerifierRuntimeEvidence(db, {
    artifactId: ARTIFACT_ID,
    producedBy: "critic-agent",
    runId,
    command: "npm test",
    exitCode: 0,
    pass: 1,
    summary: "runtime passed",
    outputPath: logPath,
    outputExcerpt: log,
    logSha256,
    durationMs: 10,
    authenticity: signRuntimeEvidence({ artifactId: ARTIFACT_ID, runId, command: "npm test", exitCode: 0, pass: 1, logSha256 }, operatorToken),
  });
  return { runId, operatorToken };
}

test("approving an artifact with a real output file commits it to git", () => {
  const db = createDb();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "guild-promotion-commit-"));
  try {
    initGitRepo(workspace);
    registerFixture(db);
    setArtifactStatus(db, ARTIFACT_ID, "migrated", { agent: "builder-agent" });

    fs.mkdirSync(path.join(workspace, "modern", "src"), { recursive: true });
    fs.writeFileSync(path.join(workspace, MODERN_PATH), "migrated content\n");

    const before = commitCount(workspace);
    const signed = setupSignedEvidence(db);

    const decision = approveArtifactWithEvidence(db, {
      artifactId: ARTIFACT_ID,
      arbiter: "reviewer-agent",
      reason: "independent passing evidence",
      runId: signed.runId,
      operatorToken: signed.operatorToken,
      workspaceRoot: workspace,
    });

    assert.equal(decision.decision, "approved");
    assert.equal(commitCount(workspace), before + 1);
    assert.ok(filesInHead(workspace).includes(MODERN_PATH));
  } finally {
    db.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("approving an artifact outside a git repo does not throw", () => {
  const db = createDb();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "guild-promotion-nogit-"));
  try {
    registerFixture(db);
    setArtifactStatus(db, ARTIFACT_ID, "migrated", { agent: "builder-agent" });

    fs.mkdirSync(path.join(workspace, "modern", "src"), { recursive: true });
    fs.writeFileSync(path.join(workspace, MODERN_PATH), "migrated content\n");

    const signed = setupSignedEvidence(db);

    const decision = approveArtifactWithEvidence(db, {
      artifactId: ARTIFACT_ID,
      arbiter: "reviewer-agent",
      reason: "independent passing evidence",
      runId: signed.runId,
      operatorToken: signed.operatorToken,
      workspaceRoot: workspace,
    });

    assert.equal(decision.decision, "approved");
    assert.equal(fs.existsSync(path.join(workspace, ".git")), false);
  } finally {
    db.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("approved companion outputs are included in the same promotion commit", () => {
  const db = createDb();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "guild-promotion-companion-"));
  try {
    initGitRepo(workspace);
    registerFixture(db);
    setArtifactStatus(db, ARTIFACT_ID, "migrated", { agent: "builder-agent" });

    fs.mkdirSync(path.join(workspace, "modern", "src"), { recursive: true });
    fs.writeFileSync(path.join(workspace, MODERN_PATH), "migrated content\n");

    const companionPath = "modern/src/PromotionCommitTestHelper.txt";
    fs.writeFileSync(path.join(workspace, companionPath), "companion content\n");
    addApprovedCompanionOutput(db, {
      artifactId: ARTIFACT_ID,
      outputPath: companionPath,
      approvedBy: "reviewer-agent",
    });

    const before = commitCount(workspace);
    const signed = setupSignedEvidence(db);

    const decision = approveArtifactWithEvidence(db, {
      artifactId: ARTIFACT_ID,
      arbiter: "reviewer-agent",
      reason: "independent passing evidence",
      runId: signed.runId,
      operatorToken: signed.operatorToken,
      workspaceRoot: workspace,
    });

    assert.equal(decision.decision, "approved");
    assert.equal(commitCount(workspace), before + 1);
    const files = filesInHead(workspace);
    assert.ok(files.includes(MODERN_PATH));
    assert.ok(files.includes(companionPath));
  } finally {
    db.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("approving an artifact whose output file is missing on disk does not throw", () => {
  const db = createDb();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "guild-promotion-missing-"));
  try {
    initGitRepo(workspace);
    registerFixture(db);
    setArtifactStatus(db, ARTIFACT_ID, "migrated", { agent: "builder-agent" });
    // Deliberately do not create modern/src/PromotionCommitTest.txt on disk.

    const before = commitCount(workspace);
    const signed = setupSignedEvidence(db);

    const decision = approveArtifactWithEvidence(db, {
      artifactId: ARTIFACT_ID,
      arbiter: "reviewer-agent",
      reason: "independent passing evidence",
      runId: signed.runId,
      operatorToken: signed.operatorToken,
      workspaceRoot: workspace,
    });

    assert.equal(decision.decision, "approved");
    assert.equal(commitCount(workspace), before);
  } finally {
    db.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
