import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { enforceWardenSnapshot, snapshotWorkspaceForWarden, snapshotWorkspaceForWardenWithExclusions } from "../guildctl/warden";
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
