import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { searchSimilar } from "../foundry/retrieval";
import { applySchema } from "../registry/db/schema";
import { registerArtifact } from "../registry/commands/artifacts";

// Minimal FoundryClient stub — embedOne should NOT be called when the table
// is absent or empty (the function returns early).
const stubClient = {
  embedOne: async (_text: string): Promise<number[]> => {
    throw new Error("embedOne should not be called when embeddings are not initialized");
  },
} as import("../foundry/foundry-client").FoundryClient;

const stubClientReturnsVec = {
  embedOne: async (_text: string): Promise<number[]> => [1, 0],
} as import("../foundry/foundry-client").FoundryClient;

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function createEmbeddingsTable(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS artifact_embeddings (
    artifact_id TEXT PRIMARY KEY,
    model TEXT,
    embedding TEXT NOT NULL,
    target_path TEXT,
    embedded_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
}

test("searchSimilar returns [] when artifact_embeddings table does not exist", async () => {
  const db = createDb();
  // applySchema does NOT create artifact_embeddings — only batch-apply does.
  const results = await searchSimilar(db, stubClient, "some query");
  assert.deepEqual(results, []);
});

test("searchSimilar returns [] when artifact_embeddings table exists but is empty", async () => {
  const db = createDb();
  createEmbeddingsTable(db);
  const results = await searchSimilar(db, stubClientReturnsVec, "some query");
  assert.deepEqual(results, []);
});

test("searchSimilar returns ranked results when embeddings are present", async () => {
  const db = createDb();
  registerArtifact(db, {
    id: "legacy-source:com.example:Foo",
    kind: "legacy-source",
    path: "legacy/Foo.java",
    tier: "first-class",
  });
  createEmbeddingsTable(db);
  db.prepare(
    `INSERT INTO artifact_embeddings (artifact_id, model, embedding, target_path) VALUES (?, ?, ?, ?)`,
  ).run("legacy-source:com.example:Foo", "text-embedding-ada-002", JSON.stringify([1, 0]), "modern/Foo.java");

  const client = {
    embedOne: async (_text: string): Promise<number[]> => [1, 0],
  } as import("../foundry/foundry-client").FoundryClient;

  const results = await searchSimilar(db, client, "query");
  assert.equal(results.length, 1);
  assert.equal(results[0]!.artifact_id, "legacy-source:com.example:Foo");
  assert.ok(results[0]!.score > 0.99);
  assert.equal(results[0]!.target_path, "modern/Foo.java");
});

test("searchSimilar propagates real errors unrelated to feature initialization", async () => {
  const db = createDb();
  createEmbeddingsTable(db);
  db.prepare(
    `INSERT INTO artifact_embeddings (artifact_id, model, embedding, target_path) VALUES (?, ?, ?, ?)`,
  ).run("legacy-source:com.example:Foo", "text-embedding-ada-002", JSON.stringify([1, 0]), "modern/Foo.java");

  const brokenClient = {
    embedOne: async (_text: string): Promise<number[]> => {
      throw new Error("Network failure: connection refused");
    },
  } as import("../foundry/foundry-client").FoundryClient;

  await assert.rejects(
    () => searchSimilar(db, brokenClient, "query"),
    /Network failure/,
  );
});
