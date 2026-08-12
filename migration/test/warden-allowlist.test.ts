import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { enforceWardenSnapshot, snapshotWorkspaceForWarden } from "../guildctl/warden";
import { registerArtifact } from "../registry/commands/artifacts";
import { applySchema } from "../registry/db/schema";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

test("#44: registered-but-unclaimed artifact's modern/ path survives warden enforcement", () => {
  const db = createDb();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "guild-warden-unclaimed-"));
  try {
    fs.mkdirSync(path.join(workspace, "modern"), { recursive: true });

    // Register SystemGlobals (shared dependency) but do NOT claim it
    registerArtifact(db, {
      id: "legacy-source:net.jforum:SystemGlobals",
      kind: "legacy-source",
      tier: "first-class",
      path: "legacy/jforum2-source/src/net/jforum/SystemGlobals.java",
    });

    // Register FooDAOImpl (the claiming artifact)
    registerArtifact(db, {
      id: "legacy-source:net.jforum.dao:FooDAOImpl",
      kind: "legacy-source",
      tier: "first-class",
      path: "legacy/jforum2-source/src/net/jforum/dao/FooDAOImpl.java",
    });

    const snapshot = snapshotWorkspaceForWarden(workspace);

    // Agent working on FooDAOImpl creates a stub for SystemGlobals as a side effect
    fs.mkdirSync(path.join(workspace, "modern", "src", "main", "java", "net", "jforum"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "modern", "src", "main", "java", "net", "jforum", "SystemGlobals.java"),
      "stub\n",
    );

    const result = enforceWardenSnapshot(db, {
      artifactId: "legacy-source:net.jforum.dao:FooDAOImpl",
      workspaceRoot: workspace,
      snapshot,
      allowedPaths: [],
      agent: "guildctl-warden",
    });

    // The stub should survive because SystemGlobals is a registered artifact
    assert.equal(result.clean, true, "stub of registered unclaimed artifact should not be a violation");
    assert.equal(
      fs.readFileSync(
        path.join(workspace, "modern", "src", "main", "java", "net", "jforum", "SystemGlobals.java"),
        "utf8",
      ),
      "stub\n",
    );
  } finally {
    db.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("#44: unrelated unregistered file is still reverted", () => {
  const db = createDb();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "guild-warden-unregistered-"));
  try {
    fs.mkdirSync(path.join(workspace, "modern"), { recursive: true });

    registerArtifact(db, {
      id: "legacy-source:net.jforum:RealArtifact",
      kind: "legacy-source",
      tier: "first-class",
      path: "legacy/jforum2-source/src/net/jforum/RealArtifact.java",
    });

    const snapshot = snapshotWorkspaceForWarden(workspace);

    // Create a file that is NOT any registered artifact's expected output
    fs.writeFileSync(
      path.join(workspace, "modern", "totally-unrelated.txt"),
      "unauthorized\n",
    );

    const result = enforceWardenSnapshot(db, {
      artifactId: "legacy-source:net.jforum:RealArtifact",
      workspaceRoot: workspace,
      snapshot,
      allowedPaths: [],
      agent: "guildctl-warden",
    });

    assert.equal(result.clean, false);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0]!.path, "modern/totally-unrelated.txt");
    assert.equal(
      fs.existsSync(path.join(workspace, "modern", "totally-unrelated.txt")),
      false,
    );
  } finally {
    db.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("#44: review-phase enforcement still catches mutations to the reviewed artifact's own paths", () => {
  const db = createDb();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "guild-warden-review-"));
  try {
    fs.mkdirSync(path.join(workspace, "modern", "src", "main", "java", "net", "jforum"), { recursive: true });

    // Register the artifact under review
    registerArtifact(db, {
      id: "legacy-source:net.jforum:ReviewedService",
      kind: "legacy-source",
      tier: "first-class",
      path: "legacy/jforum2-source/src/net/jforum/ReviewedService.java",
    });

    // Pre-create the migrated file (as if migration completed)
    const reviewedPath = path.join(
      workspace, "modern", "src", "main", "java", "net", "jforum", "ReviewedService.java",
    );
    fs.writeFileSync(reviewedPath, "original migrated content\n");

    const snapshot = snapshotWorkspaceForWarden(workspace);

    // Review phase: mutate the reviewed artifact's own file
    fs.writeFileSync(reviewedPath, "tampered during review\n");

    // Review phase passes allowedPaths: [] (fails closed on own mutations)
    const result = enforceWardenSnapshot(db, {
      artifactId: "legacy-source:net.jforum:ReviewedService",
      workspaceRoot: workspace,
      snapshot,
      allowedPaths: [],
      agent: "guildctl-review-warden",
    });

    // The mutation should be caught — the artifact's own path is excluded from
    // registeredExpectedOutputPaths via the excludeArtifactId parameter
    assert.equal(result.clean, false);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0]!.path, "modern/src/main/java/net/jforum/ReviewedService.java");
    assert.equal(
      fs.readFileSync(reviewedPath, "utf8"),
      "original migrated content\n",
    );
  } finally {
    db.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
