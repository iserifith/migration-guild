import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { enforceWardenSnapshot, snapshotWorkspaceForWarden, snapshotWorkspaceForWardenWithExclusions, transientWardenExclusions } from "../guildctl/warden";
import { expandWardenExclusions } from "../guildctl/runner";
import { registerArtifact } from "../registry/commands/artifacts";
import { applySchema } from "../registry/db/schema";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

test("filesystem warden restores unauthorized writes creations and deletions exactly", () => {
  const db = createDb();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "guild-warden-"));
  try {
    fs.mkdirSync(path.join(workspace, "modern"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "legacy"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "modern", "Allowed.java"), "old allowed\n");
    fs.writeFileSync(path.join(workspace, "legacy", "Forbidden.java"), "original forbidden\n");
    fs.writeFileSync(path.join(workspace, "legacy", "DeleteMe.java"), "restore me\n");
    registerArtifact(db, {
      id: "legacy-source:com.acme:Warden",
      kind: "legacy-source",
      tier: "first-class",
      path: "legacy/Warden.java",
    });

    const snapshot = snapshotWorkspaceForWarden(workspace);
    fs.writeFileSync(path.join(workspace, "modern", "Allowed.java"), "new allowed\n");
    fs.writeFileSync(path.join(workspace, "legacy", "Forbidden.java"), "tampered\n");
    fs.writeFileSync(path.join(workspace, "legacy", "Created.java"), "new forbidden\n");
    fs.rmSync(path.join(workspace, "legacy", "DeleteMe.java"));

    const result = enforceWardenSnapshot(db, {
      artifactId: "legacy-source:com.acme:Warden",
      workspaceRoot: workspace,
      snapshot,
      allowedPaths: ["modern/Allowed.java"],
      agent: "guildctl-warden",
    });

    assert.equal(result.clean, false);
    assert.deepEqual(result.violations.map((v) => v.path).sort(), [
      "legacy/Created.java",
      "legacy/DeleteMe.java",
      "legacy/Forbidden.java",
    ]);
    assert.equal(fs.readFileSync(path.join(workspace, "modern", "Allowed.java"), "utf8"), "new allowed\n");
    assert.equal(fs.readFileSync(path.join(workspace, "legacy", "Forbidden.java"), "utf8"), "original forbidden\n");
    assert.equal(fs.readFileSync(path.join(workspace, "legacy", "DeleteMe.java"), "utf8"), "restore me\n");
    assert.equal(fs.existsSync(path.join(workspace, "legacy", "Created.java")), false);

    const event = db.prepare("SELECT type, summary, event_data FROM events WHERE artifact_id = ? ORDER BY ts DESC LIMIT 1")
      .get("legacy-source:com.acme:Warden") as { type: string; summary: string; event_data: string };
    assert.equal(event.type, "filesystem-violation");
    assert.match(event.summary, /3 unauthorized filesystem change/);
  } finally {
    db.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("filesystem warden skips excluded directory subtrees for transient build and evidence outputs", () => {
  const db = createDb();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "guild-warden-transient-"));
  try {
    const dirs = transientWardenExclusions(workspace);
    for (const dir of dirs) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.mkdirSync(path.join(workspace, "legacy"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "modern", "build", "classes"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "modern", ".gradle", "8.10.2", "fileHashes"), { recursive: true });
    fs.mkdirSync(path.join(workspace, ".guild", "evidence"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "modern", "build", "classes", "App.class"), "original class bytes\n");
    fs.writeFileSync(path.join(workspace, "modern", ".gradle", "8.10.2", "fileHashes", "fileHashes.bin"), "original gradle cache\n");
    fs.writeFileSync(path.join(workspace, ".guild", "evidence", "runtime.log"), "original evidence\n");
    fs.writeFileSync(path.join(workspace, "legacy", "Keep.java"), "keep me\n");
    registerArtifact(db, {
      id: "legacy-source:com.acme:TransientWarden",
      kind: "legacy-source",
      tier: "first-class",
      path: "legacy/Keep.java",
    });

    const snapshot = snapshotWorkspaceForWardenWithExclusions(workspace, dirs);
    assert.equal(snapshot.files.has("modern/build/classes/App.class"), false);
    assert.equal(snapshot.files.has("modern/.gradle/8.10.2/fileHashes/fileHashes.bin"), false);
    assert.equal(snapshot.files.has(".guild/evidence/runtime.log"), false);

    fs.writeFileSync(path.join(workspace, "modern", "build", "classes", "App.class"), "tampered class bytes\n");
    fs.writeFileSync(path.join(workspace, "modern", ".gradle", "8.10.2", "fileHashes", "fileHashes.bin"), "tampered gradle cache\n");
    fs.writeFileSync(path.join(workspace, ".guild", "evidence", "runtime.log"), "tampered evidence\n");

    const result = enforceWardenSnapshot(db, {
      artifactId: "legacy-source:com.acme:TransientWarden",
      workspaceRoot: workspace,
      snapshot,
      allowedPaths: ["legacy/Keep.java"],
      excludedPaths: dirs,
      agent: "guildctl-warden",
    });

    assert.equal(result.clean, true);
    assert.equal(fs.readFileSync(path.join(workspace, "modern", "build", "classes", "App.class"), "utf8"), "tampered class bytes\n");
    assert.equal(fs.readFileSync(path.join(workspace, "modern", ".gradle", "8.10.2", "fileHashes", "fileHashes.bin"), "utf8"), "tampered gradle cache\n");
    assert.equal(fs.readFileSync(path.join(workspace, ".guild", "evidence", "runtime.log"), "utf8"), "tampered evidence\n");
  } finally {
    db.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("filesystem warden excludes exact active registry DB sidecars while protecting the rest of .guild", () => {
  const db = createDb();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "guild-warden-guilddir-"));
  try {
    fs.mkdirSync(path.join(workspace, ".guild"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "modern"), { recursive: true });
    const registryPath = path.join(workspace, ".guild", "registry.db");
    const walPath = `${registryPath}-wal`;
    const shmPath = `${registryPath}-shm`;
    const journalPath = `${registryPath}-journal`;
    fs.writeFileSync(registryPath, "original registry bytes\n");
    fs.writeFileSync(walPath, "original wal bytes\n");
    fs.writeFileSync(path.join(workspace, ".guild", "config.yaml"), "version: 1\n");
    registerArtifact(db, {
      id: "legacy-source:com.acme:Warden",
      kind: "legacy-source",
      tier: "first-class",
      path: "legacy/Warden.java",
    });

    const excludedPaths = [registryPath, walPath, shmPath, journalPath];
    const snapshot = snapshotWorkspaceForWardenWithExclusions(workspace, excludedPaths);
    assert.equal(snapshot.files.has(".guild/registry.db"), false);
    assert.equal(snapshot.files.has(".guild/registry.db-wal"), false);
    assert.equal(snapshot.files.has(".guild/config.yaml"), true);

    fs.writeFileSync(registryPath, "tampered registry bytes\n");
    fs.writeFileSync(walPath, "tampered wal bytes\n");
    fs.writeFileSync(shmPath, "created shm bytes\n");
    fs.writeFileSync(journalPath, "created journal bytes\n");
    fs.writeFileSync(path.join(workspace, ".guild", "config.yaml"), "tampered config\n");
    fs.writeFileSync(path.join(workspace, ".guild", "worker-created.txt"), "unauthorized\n");

    const result = enforceWardenSnapshot(db, {
      artifactId: "legacy-source:com.acme:Warden",
      workspaceRoot: workspace,
      snapshot,
      allowedPaths: ["modern/Warden.java"],
      excludedPaths,
      agent: "guildctl-warden",
    });

    assert.equal(result.clean, false);
    assert.deepEqual(result.violations.map((v) => v.path).sort(), [
      ".guild/config.yaml",
      ".guild/worker-created.txt",
    ]);
    assert.equal(fs.readFileSync(registryPath, "utf8"), "tampered registry bytes\n");
    assert.equal(fs.readFileSync(walPath, "utf8"), "tampered wal bytes\n");
    assert.equal(fs.readFileSync(shmPath, "utf8"), "created shm bytes\n");
    assert.equal(fs.readFileSync(journalPath, "utf8"), "created journal bytes\n");
    assert.equal(fs.readFileSync(path.join(workspace, ".guild", "config.yaml"), "utf8"), "version: 1\n");
    assert.equal(fs.existsSync(path.join(workspace, ".guild", "worker-created.txt")), false);
  } finally {
    db.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("filesystem warden excludes a runner-owned log directory subtree", () => {
  const db = createDb();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "guild-warden-logs-"));
  try {
    const logDir = path.join(workspace, "migration", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    fs.mkdirSync(path.join(workspace, "legacy"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "legacy", "Forbidden.java"), "original\n");
    registerArtifact(db, {
      id: "legacy-source:com.acme:WardenLogs",
      kind: "legacy-source",
      tier: "first-class",
      path: "legacy/WardenLogs.java",
    });

    const snapshot = snapshotWorkspaceForWardenWithExclusions(workspace, [logDir]);
    fs.writeFileSync(path.join(logDir, "worker-a.log"), "worker a\n");
    fs.mkdirSync(path.join(logDir, "nested"), { recursive: true });
    fs.writeFileSync(path.join(logDir, "nested", "worker-b.log"), "worker b\n");
    fs.writeFileSync(path.join(workspace, "legacy", "Forbidden.java"), "tampered\n");

    const result = enforceWardenSnapshot(db, {
      artifactId: "legacy-source:com.acme:WardenLogs",
      workspaceRoot: workspace,
      snapshot,
      allowedPaths: [],
      excludedPaths: [logDir],
      agent: "guildctl-warden",
    });

    assert.equal(result.clean, false);
    assert.deepEqual(result.violations.map((v) => v.path), ["legacy/Forbidden.java"]);
    assert.equal(fs.readFileSync(path.join(logDir, "worker-a.log"), "utf8"), "worker a\n");
    assert.equal(fs.readFileSync(path.join(logDir, "nested", "worker-b.log"), "utf8"), "worker b\n");
    assert.equal(fs.readFileSync(path.join(workspace, "legacy", "Forbidden.java"), "utf8"), "original\n");
  } finally {
    db.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("filesystem warden preserves registry-owned migration artifact context", () => {
  const db = createDb();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "guild-warden-context-"));
  try {
    const contextDir = path.join(workspace, "nested-package", "migration", "artifacts", "artifact-one", "context");
    fs.mkdirSync(contextDir, { recursive: true });
    registerArtifact(db, {
      id: "legacy-source:com.acme:ContextOwner",
      kind: "legacy-source",
      tier: "first-class",
      path: "legacy/ContextOwner.java",
    });

    const snapshot = snapshotWorkspaceForWarden(workspace);
    const contextFile = path.join(contextDir, "analyze-agent.md");
    fs.writeFileSync(contextFile, "## Summary\ncontext\n");

    const result = enforceWardenSnapshot(db, {
      artifactId: "legacy-source:com.acme:ContextOwner",
      workspaceRoot: workspace,
      snapshot,
      allowedPaths: [],
      agent: "guildctl-warden",
    });

    assert.equal(result.clean, true);
    assert.equal(fs.readFileSync(contextFile, "utf8"), "## Summary\ncontext\n");
  } finally {
    db.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("filesystem warden preserves output paths sanctioned by parallel claims", () => {
  const db = createDb();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "guild-warden-parallel-"));
  try {
    fs.mkdirSync(path.join(workspace, "modern"), { recursive: true });
    registerArtifact(db, {
      id: "legacy-source:com.acme:Current",
      kind: "legacy-source",
      tier: "first-class",
      path: "legacy/Current.java",
    });
    registerArtifact(db, {
      id: "legacy-source:com.acme:Sibling",
      kind: "legacy-source",
      tier: "first-class",
      path: "legacy/Sibling.java",
    });
    db.prepare(`
      INSERT INTO artifact_claims (
        claim_id, artifact_id, owner_id, agent, from_status, claim_token,
        state, attempt_no, expected_output_paths, claimed_at, lease_expires_at
      ) VALUES (
        'claim-sibling', 'legacy-source:com.acme:Sibling', 'sibling-owner',
        'test-writer-agent', 'analyzed', 'token-sibling', 'completed', 1,
        '["modern/SiblingTest.java"]', datetime('now'), datetime('now', '+30 minutes')
      )
    `).run();

    const snapshot = snapshotWorkspaceForWarden(workspace);
    fs.writeFileSync(path.join(workspace, "modern", "SiblingTest.java"), "sanctioned\n");
    fs.writeFileSync(path.join(workspace, "modern", "Unauthorized.java"), "unauthorized\n");

    const result = enforceWardenSnapshot(db, {
      artifactId: "legacy-source:com.acme:Current",
      workspaceRoot: workspace,
      snapshot,
      allowedPaths: [],
      agent: "guildctl-warden",
    });

    assert.equal(result.clean, false);
    assert.deepEqual(result.violations.map((v) => v.path), ["modern/Unauthorized.java"]);
    assert.equal(fs.readFileSync(path.join(workspace, "modern", "SiblingTest.java"), "utf8"), "sanctioned\n");
    assert.equal(fs.existsSync(path.join(workspace, "modern", "Unauthorized.java")), false);
  } finally {
    db.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("runner expands a junction log path to its canonical target", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guild-warden-junction-"));
  try {
    const realMigration = path.join(root, "migration-guild-src", "migration");
    const realLogs = path.join(realMigration, "logs");
    const migrationAlias = path.join(root, "migration");
    fs.mkdirSync(realLogs, { recursive: true });
    fs.symlinkSync(realMigration, migrationAlias, "junction");

    const aliasLogs = path.join(migrationAlias, "logs");
    const exclusions = expandWardenExclusions([aliasLogs]);

    assert.ok(exclusions.includes(path.resolve(aliasLogs)));
    assert.ok(exclusions.includes(fs.realpathSync.native(realLogs)));

    const snapshot = snapshotWorkspaceForWardenWithExclusions(root, exclusions);
    fs.writeFileSync(path.join(realLogs, "concurrent-worker.log"), "still here\n");
    const after = snapshotWorkspaceForWardenWithExclusions(root, exclusions);
    assert.deepEqual([...after.files.keys()], [...snapshot.files.keys()]);
    assert.equal(fs.readFileSync(path.join(realLogs, "concurrent-worker.log"), "utf8"), "still here\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
