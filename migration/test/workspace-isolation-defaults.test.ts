import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { DEFAULT_DB_PATH, getDb } from "../registry/db/connection";
import { readGuildConfig, resolveRegistryDbPath, scaffoldGuildConfig } from "../guildctl/config";

const repoRoot = path.resolve(__dirname, "..", "..");
const migrationRoot = path.resolve(__dirname, "..");
const cliPath = path.join(migrationRoot, "guildctl", "cli.ts");

function tmpWorkspace(prefix = "guild-task09-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function close(db: Database.Database): void {
  try { db.close(); } catch {}
}

test("registry DB default resolves inside the active workspace, not the toolkit checkout", () => {
  const root = tmpWorkspace();
  try {
    const resolved = resolveRegistryDbPath({ workspaceRoot: root, env: {}, config: {} });
    assert.equal(resolved, path.join(root, ".guild", "registry.db"));
    assert.notEqual(resolved, DEFAULT_DB_PATH);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("registry path precedence is explicit flag > REGISTRY_DB env > config > workspace default", () => {
  const root = tmpWorkspace();
  try {
    assert.equal(
      resolveRegistryDbPath({ workspaceRoot: root, explicitPath: "./flag.db", env: { REGISTRY_DB: "./env.db" }, config: { database: { path: "./config.db" } } }),
      path.resolve("./flag.db"),
    );
    assert.equal(
      resolveRegistryDbPath({ workspaceRoot: root, env: { REGISTRY_DB: "./env.db" }, config: { database: { path: "./config.db" } } }),
      path.resolve("./env.db"),
    );
    assert.equal(
      resolveRegistryDbPath({ workspaceRoot: root, env: {}, config: { database: { path: "./config.db" } } }),
      path.join(root, "config.db"),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("init scaffolds a self-describing workspace-local registry and required toolkit links idempotently", () => {
  const root = tmpWorkspace();
  try {
    const first = scaffoldGuildConfig(root);
    const second = scaffoldGuildConfig(root);
    assert.equal(first, second);

    const config = readGuildConfig(first);
    assert.deepEqual(config["database"], { path: ".guild/registry.db" });

    for (const name of ["migration", "package", "stacks"]) {
      const link = path.join(root, name);
      assert.ok(fs.existsSync(link), `${name} link should exist`);
      assert.equal(fs.realpathSync(link), fs.realpathSync(path.join(repoRoot, name)));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("two initialized workspaces write to distinct local registry databases", () => {
  const a = tmpWorkspace("guild-task09-a-");
  const b = tmpWorkspace("guild-task09-b-");
  let dbA: Database.Database | undefined;
  let dbB: Database.Database | undefined;
  try {
    const toolkitDb = path.join(migrationRoot, "registry.db");
    const toolkitDbExisted = fs.existsSync(toolkitDb);
    scaffoldGuildConfig(a);
    scaffoldGuildConfig(b);
    dbA = getDb(undefined, a);
    dbB = getDb(undefined, b);
    assert.notEqual(dbA, dbB);
    assert.ok(fs.existsSync(path.join(a, ".guild", "registry.db")));
    assert.ok(fs.existsSync(path.join(b, ".guild", "registry.db")));
    assert.notEqual(path.resolve(a, ".guild", "registry.db"), path.resolve(b, ".guild", "registry.db"));
    assert.equal(dbA.name, path.join(a, ".guild", "registry.db"));
    assert.equal(dbB.name, path.join(b, ".guild", "registry.db"));
    assert.equal(fs.existsSync(toolkitDb), toolkitDbExisted, "default DB resolution must not create or remove toolkit checkout registry.db");
  } finally {
    if (dbA) close(dbA);
    if (dbB) close(dbB);
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});

test("CLI warns when an explicit registry path points inside the toolkit checkout", () => {
  const root = tmpWorkspace();
  try {
    scaffoldGuildConfig(root);
    const badDb = path.join(migrationRoot, "registry.db");
    const result = spawnSync(process.execPath, ["--import", "tsx", cliPath, "--workspace", root, "--db", badDb, "status"], {
      cwd: migrationRoot,
      encoding: "utf8",
      env: { ...process.env, DASHSCOPE_API_KEY: "dummy" },
    });
    assert.match(result.stderr, /WARNING: registry database resolves outside workspace/i);
    assert.match(result.stderr, /toolkit checkout/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
