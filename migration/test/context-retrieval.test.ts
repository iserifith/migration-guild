import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { getContext } from "../registry/commands/context";
import { registerArtifact } from "../registry/commands/artifacts";
import { applySchema } from "../registry/db/schema";
import { idToSlug } from "../registry/types";
import { makeTempDir } from "./truthful-run-state-fixtures";

/**
 * US6 (FR-040–FR-044, research R12): context retrieval always returns
 * something usable when a record exists, and always labels which form it
 * returned. Deterministic — no filesystem search at any step.
 */

const ARTIFACT_ID = "legacy-source:com.acme:ContextThing";

function createFixture(workspaceRoot: string): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  registerArtifact(db, {
    id: ARTIFACT_ID,
    kind: "legacy-source",
    tier: "first-class",
    path: "legacy/src/main/java/com/acme/ContextThing.java",
  });
  return db;
}

function insertContext(db: Database.Database, filePath: string, summary: string | null): void {
  db.prepare(`
    INSERT INTO agent_context (artifact_id, agent, file_path, summary, updated_at)
    VALUES (@artifact_id, 'analyze-agent', @file_path, @summary, datetime('now'))
  `).run({ artifact_id: ARTIFACT_ID, file_path: filePath, summary });
}

test("an existing file returns form: file with a path that resolves on this host", () => {
  const workspaceRoot = makeTempDir("guild-context-file-");
  const db = createFixture(workspaceRoot);
  const relPath = "migration/artifacts/somewhere/notes.md";
  const abs = path.join(workspaceRoot, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, "## Summary\nhello\n", "utf8");
  insertContext(db, relPath, "hello");

  const response = getContext(db, ARTIFACT_ID, "analyze-agent", { workspaceRoot });
  assert.equal(response.form, "file");
  assert.equal(response.path, abs);
  assert.equal(response.content, "## Summary\nhello\n");
});

test("a record written with foreign separators resolves without caller-side conversion", () => {
  const workspaceRoot = makeTempDir("guild-context-foreign-sep-");
  const db = createFixture(workspaceRoot);
  const abs = path.join(workspaceRoot, "migration", "artifacts", "foo", "context", "analyze-agent.md");
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, "## Summary\nwin\n", "utf8");
  // Stored with Windows-style separators, as a record written on another host would be.
  insertContext(db, "migration\\artifacts\\foo\\context\\analyze-agent.md", "win");

  const response = getContext(db, ARTIFACT_ID, "analyze-agent", { workspaceRoot });
  assert.equal(response.form, "file");
  assert.equal(response.path, abs);
});

test("an unlocatable file with a stored summary returns form: summary", () => {
  const workspaceRoot = makeTempDir("guild-context-summary-");
  const db = createFixture(workspaceRoot);
  insertContext(db, "migration/artifacts/nonexistent/context/analyze-agent.md", "the stored summary text");

  const response = getContext(db, ARTIFACT_ID, "analyze-agent", { workspaceRoot });
  assert.equal(response.form, "summary");
  assert.equal(response.content, "the stored summary text");
  assert.equal(response.path, undefined);
});

test("the canonical layout is tried before falling back to the summary", () => {
  const workspaceRoot = makeTempDir("guild-context-canonical-");
  const db = createFixture(workspaceRoot);
  const slug = idToSlug(ARTIFACT_ID);
  const canonical = path.join(workspaceRoot, "migration", "artifacts", slug, "context", "analyze-agent.md");
  mkdirSync(path.dirname(canonical), { recursive: true });
  writeFileSync(canonical, "## Summary\ncanonical\n", "utf8");
  // Stored path is stale/unlocatable, but the canonical rebuild finds the file.
  insertContext(db, "migration/artifacts/stale-location/context/analyze-agent.md", "stale summary");

  const response = getContext(db, ARTIFACT_ID, "analyze-agent", { workspaceRoot });
  assert.equal(response.form, "file");
  assert.equal(response.path, canonical);
});

test("a whitespace-only summary counts as absent and yields form: none", () => {
  const workspaceRoot = makeTempDir("guild-context-none-");
  const db = createFixture(workspaceRoot);
  insertContext(db, "migration/artifacts/nonexistent/context/analyze-agent.md", "   \n  ");

  const response = getContext(db, ARTIFACT_ID, "analyze-agent", { workspaceRoot });
  assert.equal(response.form, "none");
  assert.equal(response.reason, "no-locatable-file-or-summary");
  assert.ok(response.fallback && response.fallback.length > 0);
});

test("reason is no-context-record when no row exists", () => {
  const workspaceRoot = makeTempDir("guild-context-no-record-");
  const db = createFixture(workspaceRoot);

  const response = getContext(db, ARTIFACT_ID, "analyze-agent", { workspaceRoot });
  assert.equal(response.form, "none");
  assert.equal(response.reason, "no-context-record");
  assert.ok(response.fallback && response.fallback.length > 0);
});

test("all three forms exit 0 shape; only a missing artifact is an error condition", () => {
  const workspaceRoot = makeTempDir("guild-context-missing-artifact-");
  const db = createFixture(workspaceRoot);
  assert.throws(() => getContext(db, "legacy-source:com.acme:DoesNotExist", "analyze-agent", { workspaceRoot }));
});

test("no filesystem search is performed — only the stored path and the canonical rebuild are tried", () => {
  const workspaceRoot = makeTempDir("guild-context-no-search-");
  const db = createFixture(workspaceRoot);
  // A file exists elsewhere in the workspace under a name that a naive search
  // might find, but it is neither the stored path nor the canonical layout.
  const decoy = path.join(workspaceRoot, "somewhere-else", "ContextThing.md");
  mkdirSync(path.dirname(decoy), { recursive: true });
  writeFileSync(decoy, "## Summary\ndecoy\n", "utf8");
  insertContext(db, "migration/artifacts/nonexistent/context/analyze-agent.md", "real summary, not the decoy");

  const response = getContext(db, ARTIFACT_ID, "analyze-agent", { workspaceRoot });
  assert.equal(response.form, "summary");
  assert.equal(response.content, "real summary, not the decoy");
});
