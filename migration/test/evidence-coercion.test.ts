import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "path";
import test from "node:test";
import Database from "better-sqlite3";
import { applyBatchClassification, classifyArtifactSource, coerceEvidence, loadClassificationSpec, parseEvidence, validateInventoryQuality } from "../guildctl/classification";
import { loadStackPack } from "../guildctl/stack";
import { applySchema } from "../registry/db/schema";
import { registerArtifact } from "../registry/commands/artifacts";

const repoRoot = path.resolve(__dirname, "..", "..");

function makeRoot(stack = "java-spring"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guild-evidence-"));
  fs.cpSync(path.join(repoRoot, "stacks"), path.join(root, "stacks"), { recursive: true });
  fs.mkdirSync(path.join(root, ".guild"), { recursive: true });
  fs.writeFileSync(path.join(root, ".guild", "config.yaml"), `version: 1\nstack: ${stack}\n`);
  return root;
}

function register(db: Database.Database, id: string, filePath: string): void {
  registerArtifact(db, { id, kind: "legacy-source", tier: "first-class", path: filePath });
}

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

test("coerceEvidence normalizes every shape to a JSON array of strings", () => {
  // array of strings -> stored as-is
  assert.equal(coerceEvidence(["a", "b"]), '["a","b"]');
  // plain string -> wrapped
  assert.equal(coerceEvidence("Makefile.py build helper"), '["Makefile.py build helper"]');
  // array of non-strings -> elements stringified
  assert.equal(coerceEvidence([1, { x: 2 }] as unknown[]), '["1","{\\"x\\":2}"]');
  // null/undefined/empty -> []
  assert.equal(coerceEvidence(null), "[]");
  assert.equal(coerceEvidence(undefined), "[]");
  assert.equal(coerceEvidence(""), "[]");
  assert.equal(coerceEvidence("   "), "[]");
  // object/number -> string form wrapped
  assert.equal(coerceEvidence({ foo: "bar" } as unknown), '["[object Object]"]');
  // already a serialized array (legacy-safe) -> kept verbatim
  assert.equal(coerceEvidence('["already","array"]'), '["already","array"]');
});

test("parseEvidence never throws and always returns string[]", () => {
  assert.deepEqual(parseEvidence('["a","b"]'), ["a", "b"]);
  // legacy stringified string -> recovered as single-element array
  assert.deepEqual(parseEvidence('"plain text"'), ["plain text"]);
  // malformed JSON -> []
  assert.deepEqual(parseEvidence("not json"), []);
  // empty / null -> []
  assert.deepEqual(parseEvidence(""), []);
  assert.deepEqual(parseEvidence(null), []);
  assert.deepEqual(parseEvidence(undefined), []);
  // parsed array with non-string elements -> coerced to strings
  assert.deepEqual(parseEvidence('[1,{"x":2}]'), ["1", '{"x":2}']);
});

test("write path stores evidence_json as a JSON array even when agent sends a plain string", () => {
  const root = makeRoot();
  const spec = loadClassificationSpec(loadStackPack("java-spring", root));
  const db = makeDb();
  try {
    register(db, "legacy-source:app:Widget", "legacy/app/src/main/java/com/acme/Widget.java");
    // Simulate a context-agent that returned plain-string evidence (the B6 crash source).
    applyBatchClassification(db, spec, [
      { id: "legacy-source:app:Widget", module: "app", role: "utility", framework: "plain-java", confidence: 0.8, evidence: "Makefile.py build helper for r2" as unknown as string[] },
    ]);
    const row = db.prepare("SELECT evidence_json FROM artifact_classifications WHERE artifact_id = ?").get("legacy-source:app:Widget") as { evidence_json: string };
    assert.equal(row.evidence_json, '["Makefile.py build helper for r2"]');
    // And the quality gate can read it back without crashing.
    assert.deepEqual(parseEvidence(row.evidence_json), ["Makefile.py build helper for r2"]);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("proper array evidence flows through byte-identical (no behavior change for well-formed input)", () => {
  const root = makeRoot();
  const spec = loadClassificationSpec(loadStackPack("java-spring", root));
  const db = makeDb();
  try {
    register(db, "legacy-source:app:Widget", "legacy/app/src/main/java/com/acme/Widget.java");
    const evidence = ["negative-evidence: no configured framework signal matched", "plain-java: no framework signal"];
    applyBatchClassification(db, spec, [
      { id: "legacy-source:app:Widget", module: "app", role: "utility", framework: "plain-java", confidence: 0.8, evidence },
    ]);
    const row = db.prepare("SELECT evidence_json FROM artifact_classifications WHERE artifact_id = ?").get("legacy-source:app:Widget") as { evidence_json: string };
    assert.equal(row.evidence_json, JSON.stringify(evidence));
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("quality gate over a registry mixing well-formed and legacy-malformed rows completes without exceptions", () => {
  const root = makeRoot();
  const spec = loadClassificationSpec(loadStackPack("java-spring", root));
  const db = makeDb();
  try {
    // Well-formed artifact.
    register(db, "legacy-source:app:Good", "legacy/app/src/main/java/com/acme/Good.java");
    applyBatchClassification(db, spec, [
      { id: "legacy-source:app:Good", module: "app", role: "utility", framework: "plain-java", confidence: 0.85, evidence: ["negative-evidence: no configured framework signal matched"] },
    ]);
    // Legacy-malformed artifact: evidence_json stored as a stringified string (pre-fix shape).
    register(db, "legacy-source:app:Legacy", "legacy/app/src/main/java/com/acme/Legacy.java");
    db.prepare("INSERT INTO artifact_classifications (artifact_id, framework, role, confidence, ambiguous, evidence_json, signals_json, updated_at) VALUES (?, 'plain-java', 'utility', 0.8, 0, ?, '[]', datetime('now'))").run(
      "legacy-source:app:Legacy",
      '"Makefile.py build helper for r2"',
    );

    // The gate must run to completion (no .some crash) and report results, not throw.
    const report = validateInventoryQuality(db, spec, { completionStatus: "completed", workspaceRoot: root });
    assert.ok(report.expectedCount >= 0);
    assert.deepEqual(parseEvidence('"Makefile.py build helper for r2"'), ["Makefile.py build helper for r2"]);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
