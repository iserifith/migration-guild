import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { DEFAULT_GUILD_CONFIG, stringifySimpleYaml } from "../guildctl/config";
import { registerArtifact } from "../registry/commands/artifacts";
import { applySchema } from "../registry/db/schema";
import { makeTempDir, repoMigrationRoot, tsxLoaderUrl } from "./truthful-run-state-fixtures";

// US1 (#122, FR-001..FR-004, NFR-001): `run [phase]` must exit non-zero when a
// phase throws or fails its own postcondition check, mirroring the existing
// preflight/doctor `process.exit(1)` pattern (cli.ts:180/195/237). Case (a)
// must fail against the unmodified cli.ts — today the run [phase] action has
// no try/catch, so the rejection from `runInventory` is not reliably
// converted into a non-zero OS exit code.

const repoRoot = path.resolve(__dirname, "..", "..");

function fixtureRoot(): string {
  const root = makeTempDir("guild-run-exit-");
  fs.cpSync(path.join(repoRoot, "stacks"), path.join(root, "stacks"), { recursive: true });
  fs.mkdirSync(path.join(root, ".guild", "prompts", "default"), { recursive: true });
  fs.mkdirSync(path.join(root, "legacy", "app", "src", "main", "java", "com", "acme"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".guild", "config.yaml"),
    stringifySimpleYaml({
      ...DEFAULT_GUILD_CONFIG,
      stack: "java-spring",
      evidence: { ...DEFAULT_GUILD_CONFIG.evidence, include_git_diff: false },
    } as unknown as Record<string, unknown>),
  );
  return root;
}

function writePlainUtil(root: string): { relPath: string; id: string } {
  const relPath = "legacy/app/src/main/java/com/acme/PlainUtil.java";
  fs.writeFileSync(path.join(root, relPath), "package com.acme;\nclass PlainUtil {}\n");
  return { relPath, id: "legacy-source:app:PlainUtil" };
}

function seedDb(root: string): string {
  const dbPath = path.join(root, ".guild", "registry.db");
  const db = new Database(dbPath);
  try {
    applySchema(db);
  } finally {
    db.close();
  }
  return dbPath;
}

function runCli(root: string, dbPath: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ["--import", tsxLoaderUrl(), path.join(repoMigrationRoot(), "guildctl", "cli.ts"), "--workspace", root, "--db", dbPath, ...args],
    {
      cwd: repoMigrationRoot(),
      encoding: "utf8",
      env: { ...process.env, DOTENV_CONFIG_SILENT: "true" },
    },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// ─── (a) a failing inventory quality gate exits non-zero ──────────────────────

test("guildctl run inventory exits non-zero when the quality gate fails, and preserves the diagnostic", () => {
  const root = fixtureRoot();
  try {
    const { relPath, id } = writePlainUtil(root);
    const dbPath = seedDb(root);
    const db = new Database(dbPath);
    try {
      registerArtifact(db, { id, kind: "legacy-source", tier: "first-class", path: relPath, module: "app" });
      // A framework value outside the java-spring allowed set — an invalid
      // classification the quality gate must reject regardless of completion
      // status. Pre-seed artifact_classifications too so runInventory sees the
      // artifact as already-classified and never spawns a live agent.
      db.prepare("UPDATE artifacts SET module = 'app', role = 'service', framework = 'not-a-real-framework' WHERE id = ?").run(id);
      db.prepare(`
        INSERT INTO artifact_classifications (artifact_id, framework, role, confidence, ambiguous, evidence_json, signals_json)
        VALUES (?, 'not-a-real-framework', 'service', 0.9, 0, '[]', '[]')
      `).run(id);
    } finally {
      db.close();
    }

    const { status, stderr } = runCli(root, dbPath, ["run", "inventory"]);

    assert.notEqual(status, 0, `expected non-zero exit, got ${status}\nstderr:\n${stderr}`);
    assert.match(stderr, /Inventory quality gate failed/);
    // On this runtime (Node 22, unhandled-rejection default "throw"), an
    // un-caught rejection already yields exit 1 — but via a raw uncaught-
    // exception crash dump (a commander/node internal stack trace), not a
    // deterministic, catch-based failure report. FR-002 requires the exit to
    // be explicit (`process.exitCode` / `process.exit`), not a byproduct of
    // that runtime default — so the fixed path must NOT leak commander/node
    // internals onto stderr. This is the part that fails before T003.
    assert.doesNotMatch(stderr, /Command\.listener|Command\._parseCommand|node_modules[\\/]commander/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ─── (b) a passing inventory fixture still exits 0 (green-path regression) ────

test("guildctl run inventory still exits 0 on a passing quality gate", () => {
  const root = fixtureRoot();
  try {
    const { relPath, id } = writePlainUtil(root);
    const dbPath = seedDb(root);
    const db = new Database(dbPath);
    try {
      registerArtifact(db, { id, kind: "legacy-source", tier: "first-class", path: relPath, module: "app" });
      db.prepare("UPDATE artifacts SET module = 'app', role = 'utility', framework = 'plain-java' WHERE id = ?").run(id);
      db.prepare(`
        INSERT INTO artifact_classifications (artifact_id, framework, role, confidence, ambiguous, evidence_json, signals_json)
        VALUES (?, 'plain-java', 'utility', 0.85, 0, ?, '[]')
      `).run(id, JSON.stringify(["negative-evidence: no configured framework signal matched"]));
      db.prepare("INSERT OR REPLACE INTO operator_state (key, value) VALUES ('inventory_completion', ?)").run(
        JSON.stringify({ status: "completed" }),
      );
    } finally {
      db.close();
    }

    const { status, stdout, stderr } = runCli(root, dbPath, ["run", "inventory"]);

    assert.equal(status, 0, `expected exit 0, got ${status}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    assert.doesNotMatch(stderr, /Inventory quality gate failed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ─── (c) regression guard: preflight/doctor non-zero-exit paths are untouched ─

test("guildctl preflight still exits non-zero on a failing verdict (regression guard, cli.ts:180)", () => {
  const root = fixtureRoot();
  try {
    const dbPath = seedDb(root);
    const env: NodeJS.ProcessEnv = { ...process.env, GUILD_PREFLIGHT_OFFLINE: "1" };
    delete env["OPENAI_API_KEY"];
    const result = spawnSync(
      process.execPath,
      ["--import", tsxLoaderUrl(), path.join(repoMigrationRoot(), "guildctl", "cli.ts"), "--workspace", root, "--db", dbPath, "preflight"],
      { cwd: repoMigrationRoot(), encoding: "utf8", env },
    );
    assert.notEqual(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("guildctl doctor still exits non-zero when pipeline-state checks fail (regression guard, cli.ts:237)", () => {
  const root = fixtureRoot();
  try {
    const dbPath = seedDb(root);
    const db = new Database(dbPath);
    try {
      const id = "legacy-source:app:Stray";
      registerArtifact(db, { id, kind: "legacy-source", tier: "first-class", path: "legacy/app/Stray.java", module: "app" });
      db.prepare("UPDATE artifacts SET module='app', role='service', framework='spring-mvc' WHERE id = ?").run(id);
      db.prepare("INSERT OR REPLACE INTO operator_state (key, value) VALUES ('plan_verification_planner', ?)").run(
        JSON.stringify({ phase: "planner", agentExited: 0, invariantPassed: true, message: "claimed complete", at: new Date().toISOString() }),
      );
    } finally {
      db.close();
    }
    const env = { ...process.env, OPENAI_API_KEY: "dummy", GUILD_PREFLIGHT_OFFLINE: "1" };
    const result = spawnSync(
      process.execPath,
      ["--import", tsxLoaderUrl(), path.join(repoMigrationRoot(), "guildctl", "cli.ts"), "--workspace", root, "--db", dbPath, "doctor"],
      { cwd: repoMigrationRoot(), encoding: "utf8", env },
    );
    assert.notEqual(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout + result.stderr, /Pipeline state:/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
