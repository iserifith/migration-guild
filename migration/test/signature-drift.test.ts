import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import {
  extractSignatures,
  signatureDigest,
  contentSha256,
  byteIdentity,
  diffSignatures,
  type SignatureDigest,
} from "../guildctl/signature";
import { registerArtifact } from "../registry/commands/artifacts";
import {
  addAcceptanceEvidence,
  addApprovedCompanionOutput,
  listApprovedCompanionOutputs,
  getApprovedCompanionOutput,
} from "../registry/commands/evidence";
import { applySchema } from "../registry/db/schema";

const ARTIFACT_ID = "legacy-source:com.acme:SignatureTest";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function registerFixture(db: Database.Database): void {
  registerArtifact(db, {
    id: ARTIFACT_ID,
    kind: "legacy-source",
    tier: "first-class",
    path: "legacy/src/main/java/com/acme/SignatureTest.java",
  });
}

// ─── Java signature extraction ──────────────────────────────────────────────

const JAVA_SOURCE = `
public class CustomerService {
  private int id;
  public final String name;

  public CustomerService(int id, String name) {
    this.id = id;
    this.name = name;
  }

  private CustomerService() {
    this(0, "");
  }

  public String getName() {
    return name;
  }

  protected void process() {
    // processing
  }

  private void internalClean() {
    // cleanup
  }
}
`;

test("Java extraction finds methods, constructors, and fields", () => {
  const members = extractSignatures(JAVA_SOURCE, "java");
  assert.ok(members.length >= 5, `expected at least 5 members, got ${members.length}`);

  const methods = members.filter((m) => m.kind === "method");
  const ctors = members.filter((m) => m.kind === "constructor");
  const fields = members.filter((m) => m.kind === "field");

  assert.ok(methods.some((m) => m.name === "getName"), "should find getName method");
  assert.ok(methods.some((m) => m.name === "process"), "should find process method");
  assert.ok(methods.some((m) => m.name === "internalClean"), "should find internalClean method");
  assert.ok(ctors.length >= 1, "should find at least one constructor");
  assert.ok(fields.some((f) => f.name === "id"), "should find id field");
  assert.ok(fields.some((f) => f.name === "name"), "should find name field");
});

test("Java extraction is deterministic across identical sources", () => {
  const a = extractSignatures(JAVA_SOURCE, "java");
  const b = extractSignatures(JAVA_SOURCE, "java");
  assert.deepEqual(
    a.map((m) => m.normalized),
    b.map((m) => m.normalized),
  );
});

// ─── Python signature extraction ────────────────────────────────────────────

const PYTHON_SOURCE = `
class CustomerService:
    def __init__(self, customer_id: int, name: str):
        self.customer_id = customer_id
        self.name = name

    def get_name(self) -> str:
        return self.name

    @staticmethod
    def validate(name: str) -> bool:
        return bool(name)

    @classmethod
    def from_dict(cls, data: dict) -> "CustomerService":
        return cls(data["id"], data["name"])
`;

test("Python extraction finds methods and instance attributes", () => {
  const members = extractSignatures(PYTHON_SOURCE, "python");
  const methods = members.filter((m) => m.kind === "method");
  const fields = members.filter((m) => m.kind === "field");

  assert.ok(methods.some((m) => m.name.includes("get_name")), "should find get_name method");
  assert.ok(methods.some((m) => m.name.includes("validate")), "should find validate method");
  assert.ok(methods.some((m) => m.name.includes("from_dict")), "should find from_dict method");
  assert.ok(fields.some((f) => f.name.includes("customer_id")), "should find customer_id attribute");
  assert.ok(fields.some((f) => f.name.includes("name")), "should find name attribute");
});

// ─── SHA-256 digest ─────────────────────────────────────────────────────────

test("signatureDigest produces consistent SHA-256 for identical sources", () => {
  const a = signatureDigest(JAVA_SOURCE, "java");
  const b = signatureDigest(JAVA_SOURCE, "java");
  assert.equal(a.sha256, b.sha256);
  assert.match(a.sha256, /^[a-f0-9]{64}$/);
});

test("signatureDigest produces different SHA-256 for different sources", () => {
  const modified = JAVA_SOURCE.replace("public String getName()", "public int getId()");
  const a = signatureDigest(JAVA_SOURCE, "java");
  const b = signatureDigest(modified, "java");
  assert.notEqual(a.sha256, b.sha256);
});

test("contentSha256 produces valid SHA-256 for buffers", () => {
  const hash = contentSha256(Buffer.from("hello world"));
  assert.equal(hash, "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
  assert.equal(hash.length, 64);
});

test("byteIdentity returns true for identical buffers", () => {
  const a = Buffer.from("identical content");
  const b = Buffer.from("identical content");
  assert.equal(byteIdentity(a, b), true);
});

test("byteIdentity returns false for different buffers", () => {
  const a = Buffer.from("content A");
  const b = Buffer.from("content B");
  assert.equal(byteIdentity(a, b), false);
});

test("byteIdentity returns false for different-length buffers", () => {
  const a = Buffer.from("short");
  const b = Buffer.from("much longer content");
  assert.equal(byteIdentity(a, b), false);
});

// ─── Delta detection ────────────────────────────────────────────────────────

function javaDigest(source: string): SignatureDigest {
  return signatureDigest(source, "java");
}

test("delta: private constructor added", () => {
  const before = javaDigest(`
    public class Foo {
      public Foo(int x) { }
      public void doStuff() { }
    }
  `);
  const after = javaDigest(`
    public class Foo {
      public Foo(int x) { }
      private Foo() { }
      public void doStuff() { }
    }
  `);
  const diff = diffSignatures(before, after);
  assert.equal(diff.identical, false);
  assert.ok(
    diff.deltas.some((d) => d.kind === "private-constructor-added" && d.member === "Foo"),
    `expected private-constructor-added for Foo, got: ${JSON.stringify(diff.deltas)}`,
  );
});

test("delta: field became final", () => {
  const before = javaDigest(`
    public class Bar {
      public String name;
      public void rename(String n) { name = n; }
    }
  `);
  const after = javaDigest(`
    public class Bar {
      public final String name;
      public Bar(String n) { name = n; }
    }
  `);
  const diff = diffSignatures(before, after);
  assert.equal(diff.identical, false);
  assert.ok(
    diff.deltas.some((d) => d.kind === "field-became-final" && d.member === "name"),
    `expected field-became-final for name, got: ${JSON.stringify(diff.deltas)}`,
  );
});

test("delta: method added", () => {
  const before = javaDigest(`
    public class Baz {
      public void existing() { }
    }
  `);
  const after = javaDigest(`
    public class Baz {
      public void existing() { }
      public void brandNew() { }
    }
  `);
  const diff = diffSignatures(before, after);
  assert.equal(diff.identical, false);
  assert.ok(
    diff.deltas.some((d) => d.kind === "method-added" && d.member === "brandNew"),
    `expected method-added for brandNew, got: ${JSON.stringify(diff.deltas)}`,
  );
});

test("delta: public method removed", () => {
  const before = javaDigest(`
    public class Qux {
      public void goingAway() { }
      public void staying() { }
    }
  `);
  const after = javaDigest(`
    public class Qux {
      public void staying() { }
    }
  `);
  const diff = diffSignatures(before, after);
  assert.equal(diff.identical, false);
  assert.ok(
    diff.deltas.some((d) => d.kind === "public-method-removed" && d.member === "goingAway"),
    `expected public-method-removed for goingAway, got: ${JSON.stringify(diff.deltas)}`,
  );
});

test("delta: visibility narrowed", () => {
  const before = javaDigest(`
    public class Vis {
      public void openMethod() { }
    }
  `);
  const after = javaDigest(`
    public class Vis {
      private void openMethod() { }
    }
  `);
  const diff = diffSignatures(before, after);
  assert.equal(diff.identical, false);
  assert.ok(
    diff.deltas.some((d) => d.kind === "visibility-narrowed" && d.member === "openMethod"),
    `expected visibility-narrowed for openMethod, got: ${JSON.stringify(diff.deltas)}`,
  );
});

test("identical sources produce no deltas", () => {
  const a = javaDigest(JAVA_SOURCE);
  const b = javaDigest(JAVA_SOURCE);
  const diff = diffSignatures(a, b);
  assert.equal(diff.identical, true);
  assert.equal(diff.deltas.length, 0);
});

// ─── Schema: content_sha256 / signature_json columns ────────────────────────

test("schema adds content_sha256 and signature_json columns to acceptance_evidence", () => {
  const db = createDb();
  try {
    const columns = db.prepare("SELECT name FROM pragma_table_info('acceptance_evidence')").all() as Array<{ name: string }>;
    const names = columns.map((c) => c.name);
    assert.ok(names.includes("content_sha256"), "content_sha256 column should exist");
    assert.ok(names.includes("signature_json"), "signature_json column should exist");
  } finally {
    db.close();
  }
});

test("schema migration adds content_sha256 and signature_json to legacy DBs", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`
      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY, slug TEXT, kind TEXT, tier TEXT, path TEXT,
        module TEXT, role TEXT, framework TEXT, status TEXT, wave INTEGER,
        data_path TEXT, claimed_by TEXT, claimed_at TEXT, claimed_from TEXT,
        created_at TEXT, updated_at TEXT
      );
      CREATE TABLE runs (
        run_id TEXT PRIMARY KEY, agent TEXT, owner_id TEXT, phase TEXT,
        model TEXT, prompt TEXT, log_file TEXT, pid INTEGER, started_at TEXT,
        finished_at TEXT, exit_code INTEGER, termination_reason TEXT,
        token_input INTEGER, token_output INTEGER, token_reasoning INTEGER,
        token_cache_read INTEGER, token_cache_write INTEGER, token_fresh INTEGER,
        token_total INTEGER, status TEXT
      );
      CREATE TABLE acceptance_evidence (
        evidence_id TEXT PRIMARY KEY, artifact_id TEXT, run_id TEXT,
        produced_by TEXT, evidence_type TEXT, command TEXT, exit_code INTEGER,
        pass INTEGER, summary TEXT, output_path TEXT, output_excerpt TEXT,
        created_at TEXT
      );
    `);
    applySchema(db);
    const columns = db.prepare("SELECT name FROM pragma_table_info('acceptance_evidence')").all() as Array<{ name: string }>;
    const names = columns.map((c) => c.name);
    assert.ok(names.includes("content_sha256"), "content_sha256 should be added via migration");
    assert.ok(names.includes("signature_json"), "signature_json should be added via migration");
    assert.ok(names.includes("log_sha256"), "log_sha256 should still exist");
  } finally {
    db.close();
  }
});

// ─── Evidence persistence with new fields ───────────────────────────────────

test("evidence records accept content_sha256 and signature_json", () => {
  const db = createDb();
  try {
    registerFixture(db);
    const sigJson = JSON.stringify([{ kind: "method-added", member: "newMethod" }]);
    const evidence = addAcceptanceEvidence(db, {
      artifactId: ARTIFACT_ID,
      producedBy: "signature-agent",
      evidenceType: "static-check",
      pass: 1,
      summary: "signature drift check",
      contentSha256: "a".repeat(64),
      signatureJson: sigJson,
    });
    assert.equal(evidence.content_sha256, "a".repeat(64));
    assert.equal(evidence.signature_json, sigJson);
    assert.equal(evidence.evidence_type, "static-check");
  } finally {
    db.close();
  }
});

test("evidence persists null content_sha256 and signature_json by default", () => {
  const db = createDb();
  try {
    registerFixture(db);
    const evidence = addAcceptanceEvidence(db, {
      artifactId: ARTIFACT_ID,
      producedBy: "test-agent",
      evidenceType: "test-command",
      command: "npm test",
      exitCode: 0,
      pass: 1,
      summary: "tests passed",
    });
    assert.equal(evidence.content_sha256, null);
    assert.equal(evidence.signature_json, null);
  } finally {
    db.close();
  }
});

// ─── Approved companion outputs ─────────────────────────────────────────────

test("schema creates approved_companion_outputs table", () => {
  const db = createDb();
  try {
    const table = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'approved_companion_outputs'",
    ).get();
    assert.ok(table, "approved_companion_outputs table should exist");
  } finally {
    db.close();
  }
});

test("addApprovedCompanionOutput stores and returns row", () => {
  const db = createDb();
  try {
    registerFixture(db);
    const output = addApprovedCompanionOutput(db, {
      artifactId: ARTIFACT_ID,
      outputPath: "artifacts/sig-digest.json",
      approvedBy: "review-agent",
    });
    assert.equal(output.artifact_id, ARTIFACT_ID);
    assert.equal(output.output_path, "artifacts/sig-digest.json");
    assert.equal(output.approved_by, "review-agent");
  } finally {
    db.close();
  }
});

test("addApprovedCompanionOutput is idempotent via UPSERT", () => {
  const db = createDb();
  try {
    registerFixture(db);
    const first = addApprovedCompanionOutput(db, {
      artifactId: ARTIFACT_ID,
      outputPath: "artifacts/sig-digest.json",
      approvedBy: "agent-a",
    });
    const second = addApprovedCompanionOutput(db, {
      artifactId: ARTIFACT_ID,
      outputPath: "artifacts/sig-digest.json",
      approvedBy: "agent-b",
    });
    assert.equal(first.approved_by, "agent-a");
    assert.equal(second.approved_by, "agent-b");
    const rows = listApprovedCompanionOutputs(db, ARTIFACT_ID);
    assert.equal(rows.length, 1, "UPSERT should not create duplicate rows");
  } finally {
    db.close();
  }
});

test("listApprovedCompanionOutputs returns rows ordered by approved_at DESC", () => {
  const db = createDb();
  try {
    registerFixture(db);
    addApprovedCompanionOutput(db, {
      artifactId: ARTIFACT_ID,
      outputPath: "out/a.json",
      approvedBy: "agent-a",
    });
    addApprovedCompanionOutput(db, {
      artifactId: ARTIFACT_ID,
      outputPath: "out/b.json",
      approvedBy: "agent-b",
    });
    const rows = listApprovedCompanionOutputs(db, ARTIFACT_ID);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.output_path, "out/b.json");
    assert.equal(rows[1]!.output_path, "out/a.json");
  } finally {
    db.close();
  }
});

test("getApprovedCompanionOutput returns null for missing rows", () => {
  const db = createDb();
  try {
    registerFixture(db);
    const result = getApprovedCompanionOutput(db, ARTIFACT_ID, "nonexistent.json");
    assert.equal(result, null);
  } finally {
    db.close();
  }
});
