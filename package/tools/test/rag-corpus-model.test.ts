/**
 * rag-corpus-model.test.ts
 *
 * Tests for the target-side corpus model used by the embedding pipeline.
 *
 * Covers:
 *   - resolveTargetPath: path resolution for each artifact kind
 *   - buildEmbedBatchInput: corpus selection and target-content embedding
 *   - searchSimilar: only returns embeddings that have a target_path
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import Database from "better-sqlite3";

import { applySchema } from "../registry/db/schema";
import { registerArtifact, setArtifactStatus } from "../registry/commands/artifacts";
import { linkArtifacts } from "../registry/commands/dependencies";
import { resolveTargetPath } from "../foundry/batch/target-path";
import { buildEmbedBatchInput } from "../foundry/batch/submit";
import { searchSimilar } from "../foundry/retrieval";
import type { FoundryConfig } from "../foundry/config";

// ─── Helpers ────────────────────────────────────────────────────────────────

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

/** Write a file into a temp directory and return the path. */
function writeTempFile(dir: string, relPath: string, content: string): string {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf-8");
  return full;
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

const minimalCfg: FoundryConfig = {
  openaiEndpoint: "https://example.openai.azure.com/openai/v1",
  projectEndpoint: "https://example.services.ai.azure.com/api/projects/demo",
  apiKey: "test-key",
  chatModel: "gpt-5.4-mini",
  embeddingModel: "text-embedding-ada-002",
  batchEnabled: true,
  providerType: "openai",
};

// ─── resolveTargetPath ───────────────────────────────────────────────────────

test("resolveTargetPath: returns null when no target file exists for legacy-source", () => {
  const db = createDb();
  registerArtifact(db, {
    id: "legacy-source:com.acme:Svc",
    kind: "legacy-source",
    path: "legacy/src/main/java/Svc.java",
    tier: "first-class",
  });
  const artifact = db.prepare("SELECT * FROM artifacts WHERE id = ?")
    .get("legacy-source:com.acme:Svc") as import("../registry/types").Artifact;

  const result = resolveTargetPath(db, artifact);
  assert.equal(result, null);
});

test("resolveTargetPath: derives path by replacing legacy/ → modern/ when no link registered", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "guildctl-test-"));
  try {
    const targetFile = writeTempFile(tmp, "modern/src/main/java/Svc.java", "public class Svc {}");

    const db = createDb();
    // Use relative path that mirrors directory structure under tmp.
    registerArtifact(db, {
      id: "legacy-source:com.acme:Svc",
      kind: "legacy-source",
      path: path.join(tmp, "legacy/src/main/java/Svc.java"),
      tier: "first-class",
    });
    const artifact = db.prepare("SELECT * FROM artifacts WHERE id = ?")
      .get("legacy-source:com.acme:Svc") as import("../registry/types").Artifact;

    // Manually verify the derivation: replace /legacy/ → /modern/
    const expected = path.join(tmp, "modern/src/main/java/Svc.java");
    assert.equal(targetFile, expected);

    const result = resolveTargetPath(db, artifact);
    assert.equal(result, expected);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolveTargetPath: prefers produced-by link over path convention", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "guildctl-test-"));
  try {
    const linkedFile = writeTempFile(tmp, "modern/src/main/java/SvcV2.java", "public class SvcV2 {}");

    const db = createDb();
    registerArtifact(db, {
      id: "legacy-source:com.acme:Svc",
      kind: "legacy-source",
      path: path.join(tmp, "legacy/src/main/java/Svc.java"),
      tier: "first-class",
    });
    // Register a target-source artifact explicitly linked via produced-by
    registerArtifact(db, {
      id: "target-source:com.acme:SvcV2",
      kind: "target-source",
      path: linkedFile,
      tier: "first-class",
    });
    linkArtifacts(db, "target-source:com.acme:SvcV2", "legacy-source:com.acme:Svc", "produced-by");

    const artifact = db.prepare("SELECT * FROM artifacts WHERE id = ?")
      .get("legacy-source:com.acme:Svc") as import("../registry/types").Artifact;

    const result = resolveTargetPath(db, artifact);
    assert.equal(result, linkedFile);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolveTargetPath: returns own path for target-source when file exists", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "guildctl-test-"));
  try {
    const file = writeTempFile(tmp, "modern/Svc.java", "public class Svc {}");

    const db = createDb();
    registerArtifact(db, {
      id: "target-source:com.acme:Svc",
      kind: "target-source",
      path: file,
      tier: "first-class",
    });
    const artifact = db.prepare("SELECT * FROM artifacts WHERE id = ?")
      .get("target-source:com.acme:Svc") as import("../registry/types").Artifact;

    assert.equal(resolveTargetPath(db, artifact), file);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── buildEmbedBatchInput ────────────────────────────────────────────────────

test("buildEmbedBatchInput: excludes legacy-source artifacts not yet migrated", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "guildctl-test-"));
  try {
    // pending artifact with existing target file — should still be excluded
    writeTempFile(tmp, "modern/Svc.java", "class Svc {}");
    const db = createDb();
    registerArtifact(db, {
      id: "legacy-source:com.acme:Svc",
      kind: "legacy-source",
      path: path.join(tmp, "legacy/Svc.java"),
      tier: "first-class",
    });
    // status is 'pending' by default → excluded

    const jsonl = buildEmbedBatchInput(db, minimalCfg);
    assert.equal(jsonl.trim(), "", "no lines expected for pending artifact");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("buildEmbedBatchInput: includes migrated legacy-source and reads target file", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "guildctl-test-"));
  try {
    const legacyFile = writeTempFile(tmp, "legacy/Svc.java", "// legacy content");
    writeTempFile(tmp, "modern/Svc.java", "// migrated target content");

    const db = createDb();
    registerArtifact(db, {
      id: "legacy-source:com.acme:Svc",
      kind: "legacy-source",
      path: legacyFile,
      tier: "first-class",
    });
    setArtifactStatus(db, "legacy-source:com.acme:Svc", "migrated");

    const jsonl = buildEmbedBatchInput(db, minimalCfg);
    const lines = jsonl.split("\n").filter(Boolean);
    assert.equal(lines.length, 1);
    const item = JSON.parse(lines[0]!);
    assert.equal(item.custom_id, "legacy-source:com.acme:Svc");
    assert.ok(item.body.input.includes("migrated target content"), "should embed target-side content");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("buildEmbedBatchInput: excludes artifact when target file does not exist", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "guildctl-test-"));
  try {
    const legacyFile = writeTempFile(tmp, "legacy/Svc.java", "// legacy");
    // No modern/Svc.java written → target file absent

    const db = createDb();
    registerArtifact(db, {
      id: "legacy-source:com.acme:Svc",
      kind: "legacy-source",
      path: legacyFile,
      tier: "first-class",
    });
    setArtifactStatus(db, "legacy-source:com.acme:Svc", "migrated");

    const jsonl = buildEmbedBatchInput(db, minimalCfg);
    assert.equal(jsonl.trim(), "", "no lines expected when target file is missing");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("buildEmbedBatchInput: includes completed and reviewed status artifacts", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "guildctl-test-"));
  try {
    for (const status of ["completed", "reviewed"] as const) {
      const legacyFile = writeTempFile(tmp, `legacy/${status}.java`, `// ${status} legacy`);
      writeTempFile(tmp, `modern/${status}.java`, `// ${status} target`);

      const db = createDb();
      registerArtifact(db, {
        id: `legacy-source:com.acme:${status.charAt(0).toUpperCase() + status.slice(1)}`,
        kind: "legacy-source",
        path: legacyFile,
        tier: "first-class",
      });
      setArtifactStatus(
        db,
        `legacy-source:com.acme:${status.charAt(0).toUpperCase() + status.slice(1)}`,
        status,
      );
      const jsonl = buildEmbedBatchInput(db, minimalCfg);
      const lines = jsonl.split("\n").filter(Boolean);
      assert.equal(lines.length, 1, `status '${status}' should be included`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── searchSimilar corpus filtering ─────────────────────────────────────────

test("searchSimilar: excludes embeddings with null target_path", async () => {
  const db = createDb();
  registerArtifact(db, {
    id: "legacy-source:com.acme:Old",
    kind: "legacy-source",
    path: "legacy/Old.java",
    tier: "first-class",
  });
  createEmbeddingsTable(db);
  // Insert embedding with no target_path (legacy-era entry)
  db.prepare(
    `INSERT INTO artifact_embeddings (artifact_id, model, embedding, target_path) VALUES (?, ?, ?, ?)`,
  ).run("legacy-source:com.acme:Old", "text-embedding-ada-002", JSON.stringify([1, 0]), null);

  const client = {
    embedOne: async (): Promise<number[]> => [1, 0],
  } as import("../foundry/foundry-client").FoundryClient;

  const results = await searchSimilar(db, client, "query");
  assert.equal(results.length, 0, "legacy-era embedding with null target_path must be excluded");
});

test("searchSimilar: includes embeddings with target_path and returns target_path", async () => {
  const db = createDb();
  registerArtifact(db, {
    id: "legacy-source:com.acme:Svc",
    kind: "legacy-source",
    path: "legacy/Svc.java",
    tier: "first-class",
  });
  createEmbeddingsTable(db);
  db.prepare(
    `INSERT INTO artifact_embeddings (artifact_id, model, embedding, target_path) VALUES (?, ?, ?, ?)`,
  ).run("legacy-source:com.acme:Svc", "text-embedding-ada-002", JSON.stringify([1, 0]), "modern/Svc.java");

  const client = {
    embedOne: async (): Promise<number[]> => [1, 0],
  } as import("../foundry/foundry-client").FoundryClient;

  const results = await searchSimilar(db, client, "query");
  assert.equal(results.length, 1);
  assert.equal(results[0]!.target_path, "modern/Svc.java");
  assert.equal(results[0]!.path, "legacy/Svc.java");
});
