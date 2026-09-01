import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
  REJECTION_ENVELOPE_AGENT,
  getContext,
  getRejectionEnvelope,
  writeContext,
  writeRejectionEnvelope,
} from "../registry/commands/context";
import { registerArtifact } from "../registry/commands/artifacts";
import { applySchema } from "../registry/db/schema";
import { makeTempDir } from "./truthful-run-state-fixtures";

/**
 * Unit tests for the rejection-envelope read/write primitives (#216,
 * data-model.md, contracts/registry-commands.md). Both writeRejectionEnvelope
 * and getRejectionEnvelope resolve relative to the current working directory
 * (writeRejectionEnvelope, mirroring writeContext) and GUILD_WORKSPACE
 * (getRejectionEnvelope → getContext → resolveWorkspaceRoot), so every test
 * chdirs into a throwaway workspace and points GUILD_WORKSPACE at it.
 */

const ARTIFACT_ID = "legacy-source:com.acme:RejectedThing";
const OTHER_ARTIFACT_ID = "legacy-source:com.acme:OtherThing";

function createFixture(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  registerArtifact(db, {
    id: ARTIFACT_ID,
    kind: "legacy-source",
    tier: "first-class",
    path: "legacy/src/main/java/com/acme/RejectedThing.java",
  });
  registerArtifact(db, {
    id: OTHER_ARTIFACT_ID,
    kind: "legacy-source",
    tier: "first-class",
    path: "legacy/src/main/java/com/acme/OtherThing.java",
  });
  return db;
}

/** Run `fn` with cwd and GUILD_WORKSPACE both pointed at a fresh temp dir. */
function withWorkspace<T>(fn: (workspaceRoot: string) => T): T {
  const workspaceRoot = makeTempDir("guild-rejection-envelope-");
  const prevCwd = process.cwd();
  const prevEnv = process.env.GUILD_WORKSPACE;
  process.chdir(workspaceRoot);
  process.env.GUILD_WORKSPACE = workspaceRoot;
  try {
    return fn(workspaceRoot);
  } finally {
    process.chdir(prevCwd);
    if (prevEnv === undefined) {
      delete process.env.GUILD_WORKSPACE;
    } else {
      process.env.GUILD_WORKSPACE = prevEnv;
    }
  }
}

test("writeRejectionEnvelope then getRejectionEnvelope round-trips the exact reason text (FR-009)", () => {
  withWorkspace(() => {
    const db = createFixture();
    const reason = "God-method still present in migrated output; split before promoting.";
    writeRejectionEnvelope(db, ARTIFACT_ID, reason);

    const result = getRejectionEnvelope(db, ARTIFACT_ID);
    assert.ok(result);
    assert.equal(result!.reason, reason);
  });
});

test("getRejectionEnvelope returns null when no rejection was ever recorded (FR-007)", () => {
  withWorkspace(() => {
    const db = createFixture();
    assert.equal(getRejectionEnvelope(db, ARTIFACT_ID), null);
  });
});

test("writeRejectionEnvelope never touches another agent's agent_context row for the same artifact (FR-003)", () => {
  withWorkspace((workspaceRoot) => {
    const db = createFixture();
    const contextFile = path.join(workspaceRoot, "context-agent-notes.md");
    fs.writeFileSync(contextFile, "## Summary\nreal analysis notes\n", "utf-8");
    writeContext(db, ARTIFACT_ID, "context-agent", contextFile);

    const before = getContext(db, ARTIFACT_ID, "context-agent", { workspaceRoot });
    assert.equal(before.form, "file");

    writeRejectionEnvelope(db, ARTIFACT_ID, "Rejected: needs another pass.");

    const after = getContext(db, ARTIFACT_ID, "context-agent", { workspaceRoot });
    assert.deepEqual(after, before);
  });
});

test("a second rejection overwrites the first — only the most recent reason is surfaced (FR-004)", () => {
  withWorkspace(() => {
    const db = createFixture();
    writeRejectionEnvelope(db, ARTIFACT_ID, "First rejection reason.");
    writeRejectionEnvelope(db, ARTIFACT_ID, "Second, more recent rejection reason.");

    const result = getRejectionEnvelope(db, ARTIFACT_ID);
    assert.ok(result);
    assert.equal(result!.reason, "Second, more recent rejection reason.");

    const rows = db
      .prepare("SELECT COUNT(*) AS n FROM agent_context WHERE artifact_id = ? AND agent = ?")
      .get(ARTIFACT_ID, REJECTION_ENVELOPE_AGENT) as { n: number };
    assert.equal(rows.n, 1);
  });
});

test("the rejection-envelope key and a real agent key never return each other's content, even when both exist (FR-002)", () => {
  withWorkspace((workspaceRoot) => {
    const db = createFixture();
    const contextFile = path.join(workspaceRoot, "context-agent-notes.md");
    fs.writeFileSync(contextFile, "## Summary\nreal analysis notes\n", "utf-8");
    writeContext(db, ARTIFACT_ID, "context-agent", contextFile);
    writeRejectionEnvelope(db, ARTIFACT_ID, "Rejection reason text.");

    const contextAgentResponse = getContext(db, ARTIFACT_ID, "context-agent", { workspaceRoot });
    const rejectionResponse = getContext(db, ARTIFACT_ID, REJECTION_ENVELOPE_AGENT, { workspaceRoot });

    assert.notEqual(contextAgentResponse.content, rejectionResponse.content);
    assert.match(contextAgentResponse.content ?? "", /real analysis notes/);
    assert.match(rejectionResponse.content ?? "", /Rejection reason text\./);
  });
});

test("writeRejectionEnvelope on one artifact leaves another artifact's envelope untouched", () => {
  withWorkspace(() => {
    const db = createFixture();
    writeRejectionEnvelope(db, ARTIFACT_ID, "Reason for RejectedThing.");

    assert.equal(getRejectionEnvelope(db, OTHER_ARTIFACT_ID), null);
  });
});
