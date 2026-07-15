import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "path";
import test from "node:test";
import Database from "better-sqlite3";
import { scanAndRegister, reconcileInventoryCounts } from "../guildctl/commands/inventory";
import { loadStackPack } from "../guildctl/stack";
import { applySchema } from "../registry/db/schema";
import { registerArtifact } from "../registry/commands/artifacts";

const repoRoot = path.resolve(__dirname, "..", "..");

function makeRoot(stack = "java-spring"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guild-inv-skip-"));
  fs.cpSync(path.join(repoRoot, "stacks"), path.join(root, "stacks"), { recursive: true });
  fs.mkdirSync(path.join(root, ".guild"), { recursive: true });
  fs.writeFileSync(path.join(root, ".guild", "config.yaml"), `version: 1\nstack: ${stack}\n`);
  return root;
}

function writeJava(root: string, relFromLegacy: string, content: string): string {
  const file = path.join(root, "legacy", ...relFromLegacy.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
  return path.relative(root, file).split(path.sep).join("/");
}

function register(db: Database.Database, id: string, filePath: string): void {
  registerArtifact(db, { id, kind: "legacy-source", tier: "first-class", path: filePath });
}

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout.write as unknown) = (chunk: string | Uint8Array): boolean => {
    chunks.push(chunk.toString());
    return true;
  };
  try {
    fn();
  } finally {
    (process.stdout.write as unknown) = orig;
  }
  return chunks.join("");
}

test("reconcileInventoryCounts enforces discovered === registered + skipped", () => {
  // Balanced: 10 discovered, 7 registered, 3 skipped across two reasons.
  const report = reconcileInventoryCounts(10, 7, { "already-registered": 2, "duplicate-slug": 1 });
  assert.match(report, /discovered: 10  registered: 7  skipped: 3/);
  assert.match(report, /skip reasons: already-registered: 2, duplicate-slug: 1/);

  // Imbalance is a scanner bug -> must throw.
  assert.throws(
    () => reconcileInventoryCounts(10, 7, { "already-registered": 1 }),
    /Inventory count mismatch/,
  );
});

test("clean fixture records 0 skips and emits no skip-reasons noise", () => {
  const root = makeRoot();
  const db = makeDb();
  try {
    writeJava(root, "app/src/main/java/com/acme/Clean.java", "class Clean {}");
    const out = captureStdout(() => scanAndRegister(db, root));
    assert.match(out, /discovered: 1  registered: 1  skipped: 0/);
    assert.doesNotMatch(out, /skip reasons:/);
    const logPath = path.join(root, ".guild", "logs", "inventory-skips.log");
    assert.equal(fs.existsSync(logPath), false, "no skip log should be written when nothing is skipped");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM artifacts").get().n, 1);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("already-registered files are counted with reason and logged per-file", () => {
  const root = makeRoot();
  const db = makeDb();
  try {
    const rel = writeJava(root, "app/src/main/java/com/acme/Dup.java", "class Dup {}");
    // Pre-register the same id as if from a prior run.
    register(db, "legacy-source:app:Dup", rel);
    const out = captureStdout(() => scanAndRegister(db, root));
    assert.match(out, /discovered: 1  registered: 0  skipped: 1/);
    assert.match(out, /skip reasons: already-registered: 1/);

    const logPath = path.join(root, ".guild", "logs", "inventory-skips.log");
    const logLines = fs.readFileSync(logPath, "utf8").trim().split("\n");
    assert.equal(logLines.length, 1);
    assert.match(logLines[0], new RegExp(`${rel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\talready-registered`));
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("duplicate basenames are registered with distinct path-qualified ids", () => {
  const root = makeRoot();
  const db = makeDb();
  try {
    // Same module (app) + same class name in two subdirs -> identical artifact id.
    writeJava(root, "app/src/main/java/com/acme/Collision.java", "class Collision {}");
    writeJava(root, "app/src/main/java/com/acme/nested/Collision.java", "class Collision {}");
    writeJava(root, "app/src/main/java/com/acme/lower/collision.java", "class collision {}");
    const out = captureStdout(() => scanAndRegister(db, root));
    assert.match(out, /discovered: 3  registered: 3  skipped: 0/);
    assert.doesNotMatch(out, /skip reasons:/);

    const logPath = path.join(root, ".guild", "logs", "inventory-skips.log");
    assert.equal(fs.existsSync(logPath), false);
    const rows = db.prepare("SELECT id, slug FROM artifacts ORDER BY id").all() as Array<{ id: string; slug: string }>;
    assert.equal(rows.length, 3);
    assert.equal(new Set(rows.map((row) => row.id)).size, 3);
    assert.equal(new Set(rows.map((row) => row.slug)).size, 3);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("mixed fixture reconciles across reasons", () => {
  const root = makeRoot();
  const db = makeDb();
  try {
    writeJava(root, "app/src/main/java/com/acme/A.java", "class A {}");
    writeJava(root, "app/src/main/java/com/acme/nested/A.java", "class A {}"); // collision-safe id
    const pre = writeJava(root, "app/src/main/java/com/acme/B.java", "class B {}");
    register(db, "legacy-source:app:B", pre); // already-registered
    const out = captureStdout(() => scanAndRegister(db, root));
    assert.match(out, /discovered: 3  registered: 2  skipped: 1/);
    assert.match(out, /skip reasons: already-registered: 1/);

    const logPath = path.join(root, ".guild", "logs", "inventory-skips.log");
    const logLines = fs.readFileSync(logPath, "utf8").trim().split("\n");
    assert.equal(logLines.length, 1);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("forced imbalance throws (scanner bug surfacing)", () => {
  // A file that is neither registered nor counted as skipped would break the
  // invariant. Simulate directly against the reconciliation helper.
  const root = makeRoot();
  const db = makeDb();
  try {
    writeJava(root, "app/src/main/java/com/acme/Z.java", "class Z {}");
    assert.throws(() => captureStdout(() => {
      reconcileInventoryCounts(1, 0, {}); // 1 discovered, 0 registered, 0 skipped
    }), /Inventory count mismatch/);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
