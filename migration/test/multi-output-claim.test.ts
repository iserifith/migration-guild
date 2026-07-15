import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
  claimArtifactById,
  deriveExpectedOutputPaths,
} from "../registry/commands/claim";
import {
  registerArtifact,
  setArtifactStatus,
  setArtifactWave,
} from "../registry/commands/artifacts";
import {
  addApprovedCompanionOutput,
  listApprovedCompanionOutputs,
  validateCompanionOutputPath,
} from "../registry/commands/evidence";
import { enforceWardenSnapshot, snapshotWorkspaceForWarden } from "../guildctl/warden";
import { startRun } from "../registry/commands/runs";
import { applySchema } from "../registry/db/schema";

const ARTIFACT_ID = "legacy-source:com.acme:MultiOutput";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function registerPlanned(db: Database.Database, id: string): void {
  registerArtifact(db, {
    id,
    kind: "legacy-source",
    tier: "first-class",
    path: `legacy/src/main/java/${id.replaceAll(":", "/")}.java`,
  });
  setArtifactWave(db, id, 1);
  setArtifactStatus(db, id, "planned");
}

const DERIVED_MODERN_PATH = "modern/src/main/java/legacy-source/com.acme/MultiOutput.java";

// ─── deriveExpectedOutputPaths unions companion outputs ──────────────────────

test("deriveExpectedOutputPaths returns modern path plus approved companion outputs", () => {
  const db = createDb();
  try {
    registerPlanned(db, ARTIFACT_ID);
    addApprovedCompanionOutput(db, {
      artifactId: ARTIFACT_ID,
      outputPath: "modern/src/main/java/com/acme/MultiOutputTest.java",
      approvedBy: "operator",
    });

    const artifact = db.prepare("SELECT * FROM artifacts WHERE id = ?").get(ARTIFACT_ID) as any;
    const paths = deriveExpectedOutputPaths(artifact, db);
    assert.ok(paths.includes(DERIVED_MODERN_PATH), "should include the normal derived modern path");
    assert.ok(paths.includes("modern/src/main/java/com/acme/MultiOutputTest.java"), "should include the approved companion path");
    assert.equal(paths.length, 2, "should have exactly 2 paths");
  } finally {
    db.close();
  }
});

test("deriveExpectedOutputPaths without db returns only the normal derived path", () => {
  const db = createDb();
  try {
    registerPlanned(db, ARTIFACT_ID);
    addApprovedCompanionOutput(db, {
      artifactId: ARTIFACT_ID,
      outputPath: "modern/src/main/java/com/acme/MultiOutputTest.java",
      approvedBy: "operator",
    });

    const artifact = db.prepare("SELECT * FROM artifacts WHERE id = ?").get(ARTIFACT_ID) as any;
    const paths = deriveExpectedOutputPaths(artifact);
    assert.deepEqual(paths, [DERIVED_MODERN_PATH]);
  } finally {
    db.close();
  }
});

test("deriveExpectedOutputPaths deduplicates companion paths already in the normal derived set", () => {
  const db = createDb();
  const id = "legacy-source:com.acme:Dedup";
  try {
    registerPlanned(db, id);
    const derivedModern = "modern/src/main/java/legacy-source/com.acme/Dedup.java";
    addApprovedCompanionOutput(db, {
      artifactId: id,
      outputPath: derivedModern,
      approvedBy: "operator",
    });

    const artifact = db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as any;
    const paths = deriveExpectedOutputPaths(artifact, db);
    assert.deepEqual(paths, [derivedModern]);
  } finally {
    db.close();
  }
});

// ─── Claim with companion outputs stores expected_output_paths correctly ─────

test("claimArtifactById stores unioned expected_output_paths including companion", () => {
  const db = createDb();
  try {
    registerPlanned(db, ARTIFACT_ID);
    addApprovedCompanionOutput(db, {
      artifactId: ARTIFACT_ID,
      outputPath: "modern/src/main/java/com/acme/MultiOutputTest.java",
      approvedBy: "operator",
    });

    startRun(db, { runId: "run-comp", agent: "code-writer", ownerId: "owner-comp" });
    const claimed = claimArtifactById(db, {
      artifactId: ARTIFACT_ID,
      agent: "code-writer",
      ownerId: "owner-comp",
      runId: "run-comp",
    });

    const stored = JSON.parse(claimed.expected_output_paths ?? "[]");
    assert.ok(stored.includes(DERIVED_MODERN_PATH), "should include normal derived path");
    assert.ok(stored.includes("modern/src/main/java/com/acme/MultiOutputTest.java"), "should include companion path");
  } finally {
    db.close();
  }
});

// ─── Warden respects approved companion paths ────────────────────────────────

test("warden allows writes to approved companion paths and blocks unapproved writes", () => {
  const db = createDb();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "guild-multi-output-"));
  try {
    fs.mkdirSync(path.join(workspace, "modern", "src"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "modern", "src", "Original.java"), "original\n");
    registerPlanned(db, ARTIFACT_ID);
    addApprovedCompanionOutput(db, {
      artifactId: ARTIFACT_ID,
      outputPath: "modern/src/MultiOutputTest.java",
      approvedBy: "operator",
    });

    const snapshot = snapshotWorkspaceForWarden(workspace);

    // Write to the approved companion path (should be allowed)
    fs.writeFileSync(path.join(workspace, "modern", "src", "MultiOutputTest.java"), "new test\n");
    // Write to an unapproved path (should be blocked)
    fs.writeFileSync(path.join(workspace, "modern", "src", "Unapproved.java"), "unapproved\n");

    const result = enforceWardenSnapshot(db, {
      artifactId: ARTIFACT_ID,
      workspaceRoot: workspace,
      snapshot,
      allowedPaths: ["modern/src/MultiOutputTest.java"],
      agent: "guildctl-warden",
    });

    assert.equal(result.clean, false, "should have violations for unapproved path");
    assert.ok(result.violations.some((v) => v.path === "modern/src/Unapproved.java"), "unapproved file should be a violation");
    assert.ok(!result.violations.some((v) => v.path === "modern/src/MultiOutputTest.java"), "approved companion should NOT be a violation");
    assert.equal(fs.readFileSync(path.join(workspace, "modern", "src", "MultiOutputTest.java"), "utf8"), "new test\n");
    assert.equal(fs.existsSync(path.join(workspace, "modern", "src", "Unapproved.java")), false, "unapproved file should be removed");
  } finally {
    db.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

// ─── Unsafe approval path rejection ──────────────────────────────────────────

test("validateCompanionOutputPath rejects absolute paths", () => {
  assert.throws(
    () => validateCompanionOutputPath("/etc/passwd"),
    /must be relative|absolute/i,
  );
});

test("validateCompanionOutputPath rejects paths with traversal", () => {
  assert.throws(
    () => validateCompanionOutputPath("modern/../etc/passwd"),
    /\.\.|\.\.\/|traversal/i,
  );
});

test("validateCompanionOutputPath rejects paths not under modern/", () => {
  assert.throws(
    () => validateCompanionOutputPath("legacy/src/Foo.java"),
    /must be under modern\//i,
  );
});

test("validateCompanionOutputPath rejects non-normalized paths", () => {
  assert.throws(
    () => validateCompanionOutputPath("modern//src//Foo.java"),
    /not normalized/i,
  );
});

test("validateCompanionOutputPath rejects whitespace and Windows separators", () => {
  assert.throws(
    () => validateCompanionOutputPath(" modern/src/Foo.java "),
    /canonical POSIX/i,
  );
  assert.throws(
    () => validateCompanionOutputPath("modern\\src\\Foo.java"),
    /canonical POSIX/i,
  );
});

test("validateCompanionOutputPath accepts valid paths under modern/", () => {
  const result = validateCompanionOutputPath("modern/src/main/java/com/acme/FooTest.java");
  assert.equal(result, "modern/src/main/java/com/acme/FooTest.java");
  assert.equal(
    validateCompanionOutputPath("modern/src/Foo..generated.java"),
    "modern/src/Foo..generated.java",
  );
});

test("addApprovedCompanionOutput rejects absolute path", () => {
  const db = createDb();
  try {
    registerPlanned(db, ARTIFACT_ID);
    assert.throws(
      () => addApprovedCompanionOutput(db, {
        artifactId: ARTIFACT_ID,
        outputPath: "/tmp/evil.java",
        approvedBy: "attacker",
      }),
      /must be relative|absolute/i,
    );
  } finally {
    db.close();
  }
});

test("addApprovedCompanionOutput rejects traversal path", () => {
  const db = createDb();
  try {
    registerPlanned(db, ARTIFACT_ID);
    assert.throws(
      () => addApprovedCompanionOutput(db, {
        artifactId: ARTIFACT_ID,
        outputPath: "modern/../../evil.java",
        approvedBy: "attacker",
      }),
      /\.\.|\.\.\/|traversal/i,
    );
  } finally {
    db.close();
  }
});

test("addApprovedCompanionOutput rejects path not under modern/", () => {
  const db = createDb();
  try {
    registerPlanned(db, ARTIFACT_ID);
    assert.throws(
      () => addApprovedCompanionOutput(db, {
        artifactId: ARTIFACT_ID,
        outputPath: "legacy/Foo.java",
        approvedBy: "attacker",
      }),
      /must be under modern\//i,
    );
  } finally {
    db.close();
  }
});

// ─── Warden blocks unapproved writes even with companion outputs present ─────

test("warden reverts writes outside allowed paths when companion outputs are present", () => {
  const db = createDb();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "guild-multi-warden-"));
  try {
    fs.mkdirSync(path.join(workspace, "modern"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "modern", "Main.java"), "main\n");
    fs.writeFileSync(path.join(workspace, "modern", "Allowed.java"), "allowed\n");
    registerPlanned(db, ARTIFACT_ID);
    addApprovedCompanionOutput(db, {
      artifactId: ARTIFACT_ID,
      outputPath: "modern/Allowed.java",
      approvedBy: "operator",
    });

    const snapshot = snapshotWorkspaceForWarden(workspace);
    fs.writeFileSync(path.join(workspace, "modern", "Main.java"), "tampered\n");
    fs.writeFileSync(path.join(workspace, "modern", "Allowed.java"), "new content\n");

    const result = enforceWardenSnapshot(db, {
      artifactId: ARTIFACT_ID,
      workspaceRoot: workspace,
      snapshot,
      allowedPaths: ["modern/Allowed.java"],
      agent: "guildctl-warden",
    });

    assert.equal(result.clean, false, "modification to Main.java should be a violation");
    assert.ok(result.violations.some((v) => v.path === "modern/Main.java" && v.kind === "modified"));
    assert.ok(!result.violations.some((v) => v.path === "modern/Allowed.java"), "allowed companion should NOT be a violation");
    assert.equal(fs.readFileSync(path.join(workspace, "modern", "Main.java"), "utf8"), "main\n", "Main.java should be restored");
    assert.equal(fs.readFileSync(path.join(workspace, "modern", "Allowed.java"), "utf8"), "new content\n", "Allowed.java should be kept");
  } finally {
    db.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

// ─── Multiple companion outputs ──────────────────────────────────────────────

test("deriveExpectedOutputPaths with multiple companion outputs", () => {
  const db = createDb();
  const id = "legacy-source:com.acme:MultiComp";
  try {
    registerPlanned(db, id);
    const derivedModern = "modern/src/main/java/legacy-source/com.acme/MultiComp.java";
    addApprovedCompanionOutput(db, {
      artifactId: id,
      outputPath: "modern/src/FooTest.java",
      approvedBy: "operator",
    });
    addApprovedCompanionOutput(db, {
      artifactId: id,
      outputPath: "modern/src/FooIntegrationTest.java",
      approvedBy: "operator",
    });

    const artifact = db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as any;
    const paths = deriveExpectedOutputPaths(artifact, db);
    assert.equal(paths.length, 3, "should have 3 paths: 1 derived + 2 companion");
    assert.ok(paths.includes(derivedModern));
    assert.ok(paths.includes("modern/src/FooTest.java"));
    assert.ok(paths.includes("modern/src/FooIntegrationTest.java"));
  } finally {
    db.close();
  }
});

test("listApprovedCompanionOutputs returns all approved paths for an artifact", () => {
  const db = createDb();
  const id = "legacy-source:com.acme:ListComp";
  try {
    registerPlanned(db, id);
    addApprovedCompanionOutput(db, {
      artifactId: id,
      outputPath: "modern/src/FooTest.java",
      approvedBy: "op1",
    });
    addApprovedCompanionOutput(db, {
      artifactId: id,
      outputPath: "modern/src/BarTest.java",
      approvedBy: "op2",
    });
    const rows = listApprovedCompanionOutputs(db, id);
    assert.equal(rows.length, 2);
  } finally {
    db.close();
  }
});
