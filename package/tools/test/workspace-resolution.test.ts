import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { applySchema } from "../registry/db/schema";
import { scanAndRegister } from "../guildctl/commands/inventory";
import {
  readGuildConfig,
  resolveWorkspaceRoot,
  scaffoldGuildConfig,
  writeGuildConfig,
} from "../guildctl/config";
import { detectStack } from "../guildctl/stack";

const repoRoot = path.resolve(__dirname, "..", "..");

function stageWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guild-workspace-"));
  fs.cpSync(path.join(repoRoot, "stacks"), path.join(root, "stacks"), { recursive: true });
  fs.cpSync(path.join(repoRoot, "package", "mock", "legacy-python-utils"), path.join(root, "legacy"), { recursive: true });
  // init: detect stack from legacy/ and record it (mirrors `guildctl init`)
  const configPath = scaffoldGuildConfig(root);
  const raw = readGuildConfig(configPath);
  raw["stack"] = detectStack(root);
  writeGuildConfig(raw, configPath);
  return root;
}

test("resolveWorkspaceRoot precedence: flag > GUILD_WORKSPACE env > fallback", () => {
  const prev = process.env.GUILD_WORKSPACE;
  try {
    delete process.env.GUILD_WORKSPACE;
    // flag wins, resolved to absolute
    assert.equal(resolveWorkspaceRoot({ workspace: "relative/dir" }), path.resolve("relative/dir"));

    // env used when no flag
    process.env.GUILD_WORKSPACE = "/tmp/guild-env-root";
    assert.equal(resolveWorkspaceRoot(), path.resolve("/tmp/guild-env-root"));

    // flag beats env
    assert.equal(resolveWorkspaceRoot({ workspace: "/tmp/guild-flag-root" }), path.resolve("/tmp/guild-flag-root"));
  } finally {
    if (prev === undefined) delete process.env.GUILD_WORKSPACE;
    else process.env.GUILD_WORKSPACE = prev;
  }
});

test("inventory scan registers files from an external workspace without chdir (the --workspace fix)", () => {
  const root = stageWorkspace();
  const db = new Database(":memory:");
  const prev = process.env.GUILD_WORKSPACE;
  try {
    // cwd stays the repo (NOT the workspace). Before the fix, scanAndRegister
    // resolved config/stack from cwd and registered 0 files.
    delete process.env.GUILD_WORKSPACE;
    assert.notEqual(process.cwd(), root);
    applySchema(db);

    const registered = scanAndRegister(db, root);
    assert.ok(registered > 0, `expected >0 artifacts registered, got ${registered}`);
    assert.equal(registered, 3);
    assert.deepEqual(
      db.prepare("SELECT path FROM artifacts ORDER BY path").pluck().all(),
      [
        "legacy/src/legacy_python_utils/__init__.py",
        "legacy/src/legacy_python_utils/names.py",
        "legacy/tests/test_names.py",
      ],
    );
  } finally {
    db.close();
    if (prev === undefined) delete process.env.GUILD_WORKSPACE;
    else process.env.GUILD_WORKSPACE = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
