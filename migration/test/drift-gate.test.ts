import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { signRuntimeEvidence, sha256 } from "../guildctl/verify";
import { createRunOperatorCredential } from "../registry/commands/claim";
import { registerArtifact, setArtifactStatus } from "../registry/commands/artifacts";
import { addVerifierRuntimeEvidence, approveArtifactWithEvidence, checkEvidenceFreshness } from "../registry/commands/evidence";
import { appendEvent } from "../registry/commands/events";
import { applySchema } from "../registry/db/schema";
import { computeDriftGate, highRiskDriftKinds, type DriftGateResult } from "../guildctl/supervisor/loop";
import { contentSha256 } from "../guildctl/signature";

const ARTIFACT_ID = "legacy-source:com.acme:DriftGateTest";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function registerFixture(db: Database.Database, legacyPath?: string): void {
  registerArtifact(db, {
    id: ARTIFACT_ID,
    kind: "legacy-source",
    tier: "first-class",
    path: legacyPath ?? "legacy/src/DriftGateTest.java",
  });
}

function markMigrated(db: Database.Database): void {
  setArtifactStatus(db, ARTIFACT_ID, "migrated", { agent: "builder-agent" });
}

function setupSignedEvidence(
  db: Database.Database,
  opts: { pass?: 0 | 1; log?: string } = {},
): { runId: string; operatorToken: string } {
  const runId = `run-${Math.random().toString(16).slice(2)}`;
  db.prepare("INSERT INTO runs (run_id, agent, owner_id, status) VALUES (?, 'guildctl-verify', 'guildctl', 'running')").run(runId);
  const operatorToken = createRunOperatorCredential(db, runId).token;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guild-drift-evidence-"));
  const log = opts.log ?? "runtime ok\n";
  const logPath = path.join(dir, "runtime.log");
  fs.writeFileSync(logPath, log);
  const logSha256 = sha256(log);
  addVerifierRuntimeEvidence(db, {
    artifactId: ARTIFACT_ID,
    producedBy: "critic-agent",
    runId,
    command: "npm test",
    exitCode: 0,
    pass: opts.pass ?? 1,
    summary: opts.pass === 0 ? "runtime failed" : "runtime passed",
    outputPath: logPath,
    outputExcerpt: log,
    logSha256,
    durationMs: 10,
    authenticity: signRuntimeEvidence({ artifactId: ARTIFACT_ID, runId, command: "npm test", exitCode: 0, pass: opts.pass ?? 1, logSha256 }, operatorToken),
  });
  return { runId, operatorToken };
}

// ─── Category: whitespace mismatch ──────────────────────────────────────────

test("drift gate treats whitespace-only differences as identical", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "guild-drift-ws-"));
  try {
    const legacyPath = "legacy/src/Foo.java";
    const modernPath = "modern/src/Foo.java";
    fs.mkdirSync(path.join(workspace, "legacy", "src"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "modern", "src"), { recursive: true });
    fs.writeFileSync(path.join(workspace, legacyPath), "public class Foo {\n  public void bar() {}\n}");
    fs.writeFileSync(path.join(workspace, modernPath), "public class Foo {\n\tpublic void bar() {}\n}");

    const db = createDb();
    registerFixture(db, legacyPath);
    try {
      const result = computeDriftGate({
        workspaceRoot: workspace,
        legacyArtifactId: ARTIFACT_ID,
        legacyPath,
        expectedOutputPaths: [modernPath],
        db,
      });
      assert.equal(result.ok, true);
      assert.equal(result.highRisk, false);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

// ─── Category: FieldConstants private constructor ───────────────────────────

test("drift gate rejects private constructor added to a constants class", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "guild-drift-const-"));
  try {
    const legacyPath = "legacy/src/FieldConstants.java";
    const modernPath = "modern/src/FieldConstants.java";
    fs.mkdirSync(path.join(workspace, "legacy", "src"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "modern", "src"), { recursive: true });
    fs.writeFileSync(path.join(workspace, legacyPath), "public class FieldConstants {\n  public static final int MAX = 100;\n}");
    fs.writeFileSync(path.join(workspace, modernPath), "public class FieldConstants {\n  public static final int MAX = 100;\n  private FieldConstants() {}\n}");

    const db = createDb();
    registerFixture(db, legacyPath);
    try {
      const result = computeDriftGate({
        workspaceRoot: workspace,
        legacyArtifactId: ARTIFACT_ID,
        legacyPath,
        expectedOutputPaths: [modernPath],
        db,
      });
      assert.equal(result.ok, false);
      assert.equal(result.highRisk, true);
      assert.ok(result.deltas.some((d) => d.kind === "private-constructor-added"),
        `expected private-constructor-added in deltas: ${JSON.stringify(result.deltas)}`);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

// ─── Category: MediaFileType final fields ────────────────────────────────────

test("drift gate rejects field that became final", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "guild-drift-final-"));
  try {
    const legacyPath = "legacy/src/MediaFileType.java";
    const modernPath = "modern/src/MediaFileType.java";
    fs.mkdirSync(path.join(workspace, "legacy", "src"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "modern", "src"), { recursive: true });
    fs.writeFileSync(path.join(workspace, legacyPath), "public class MediaFileType {\n  public String format;\n  public void setFormat(String f) { format = f; }\n}");
    fs.writeFileSync(path.join(workspace, modernPath), "public class MediaFileType {\n  public final String format;\n  public MediaFileType(String f) { format = f; }\n}");

    const db = createDb();
    registerFixture(db, legacyPath);
    try {
      const result = computeDriftGate({
        workspaceRoot: workspace,
        legacyArtifactId: ARTIFACT_ID,
        legacyPath,
        expectedOutputPaths: [modernPath],
        db,
      });
      assert.equal(result.ok, false);
      assert.equal(result.highRisk, true);
      assert.ok(result.deltas.some((d) => d.kind === "field-became-final"),
        `expected field-became-final in deltas: ${JSON.stringify(result.deltas)}`);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

// ─── Category: stale evidence after repair ───────────────────────────────────

test("checkEvidenceFreshness rejects stale evidence after repair", () => {
  const db = createDb();
  try {
    registerFixture(db);
    markMigrated(db);
    setupSignedEvidence(db, { pass: 1, log: "evidence before repair\n" });
    db.prepare(
      "UPDATE acceptance_evidence SET created_at = datetime('now', '-2 seconds') WHERE artifact_id = ?",
    ).run(ARTIFACT_ID);

    appendEvent(db, {
      id: ARTIFACT_ID,
      type: "auto-rework",
      agent: "guildctl-auto",
      summary: "Repair scheduled",
      data: JSON.stringify({ failure: { kind: "test-failure" } }),
    });

    const result = checkEvidenceFreshness(db, ARTIFACT_ID);
    assert.equal(result.ok, false);
    assert.match(result.reason, /stale evidence/i);
  } finally {
    db.close();
  }
});

test("checkEvidenceFreshness passes with fresh evidence after repair", async () => {
  const db = createDb();
  try {
    registerFixture(db);
    markMigrated(db);

    appendEvent(db, {
      id: ARTIFACT_ID,
      type: "auto-rework",
      agent: "guildctl-auto",
      summary: "Repair scheduled",
      data: JSON.stringify({ failure: { kind: "test-failure" } }),
    });

    // Ensure the repair event timestamp is strictly behind fresh evidence
    await new Promise((r) => setTimeout(r, 1100));

    setupSignedEvidence(db, { pass: 1, log: "evidence after repair\n" });

    const result = checkEvidenceFreshness(db, ARTIFACT_ID);
    assert.equal(result.ok, true);
  } finally {
    db.close();
  }
});

test("checkEvidenceFreshness passes with no repair events", () => {
  const db = createDb();
  try {
    registerFixture(db);
    markMigrated(db);
    setupSignedEvidence(db, { pass: 1, log: "clean evidence\n" });

    const result = checkEvidenceFreshness(db, ARTIFACT_ID);
    assert.equal(result.ok, true);
  } finally {
    db.close();
  }
});

// ─── Category: reviewer arbitration boundary ─────────────────────────────────

test("approveArtifactWithEvidence blocks stale evidence from a prior repair cycle", () => {
  const db = createDb();
  const dirs: string[] = [];
  try {
    registerFixture(db);
    markMigrated(db);

    const first = setupSignedEvidence(db, { pass: 1 });
    dirs.push(first.runId);
    db.prepare(
      "UPDATE acceptance_evidence SET created_at = datetime('now', '-2 seconds') WHERE run_id = ?",
    ).run(first.runId);

    appendEvent(db, {
      id: ARTIFACT_ID,
      type: "auto-rework",
      agent: "guildctl-auto",
      summary: "Repair after first attempt",
      data: JSON.stringify({ failure: { kind: "test-failure" } }),
    });

    assert.throws(
      () => approveArtifactWithEvidence(db, {
        artifactId: ARTIFACT_ID,
        arbiter: "reviewer-agent",
        reason: "should fail due to stale evidence from first attempt",
        runId: first.runId,
        operatorToken: first.operatorToken,
      }),
      /stale evidence/i,
    );
  } finally {
    for (const entry of dirs) {
      const row = db.prepare("SELECT output_path FROM acceptance_evidence WHERE run_id = ?").get(entry) as { output_path: string | null } | undefined;
      if (row?.output_path) {
        const logDir = path.dirname(row.output_path);
        if (fs.existsSync(logDir)) fs.rmSync(logDir, { recursive: true, force: true });
      }
    }
    db.close();
  }
});

test("approveArtifactWithEvidence accepts fresh evidence after all repair cycles", async () => {
  const db = createDb();
  try {
    registerFixture(db);
    markMigrated(db);

    appendEvent(db, {
      id: ARTIFACT_ID,
      type: "auto-rework",
      agent: "guildctl-auto",
      summary: "Repair completed",
      data: JSON.stringify({ failure: { kind: "test-failure" } }),
    });

    // Ensure fresh evidence is created strictly after repair event
    await new Promise((r) => setTimeout(r, 1100));

    const signed = setupSignedEvidence(db, { pass: 1 });

    const decision = approveArtifactWithEvidence(db, {
      artifactId: ARTIFACT_ID,
      arbiter: "reviewer-agent",
      reason: "fresh evidence after repair",
      runId: signed.runId,
      operatorToken: signed.operatorToken,
    });
    assert.equal(decision.decision, "approved");
  } finally {
    db.close();
  }
});

// ─── Method-added recorded but does not block ───────────────────────────────

test("drift gate passes with method-added delta but does not block", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "guild-drift-method-"));
  try {
    const legacyPath = "legacy/src/Service.java";
    const modernPath = "modern/src/Service.java";
    fs.mkdirSync(path.join(workspace, "legacy", "src"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "modern", "src"), { recursive: true });
    fs.writeFileSync(path.join(workspace, legacyPath), "public class Service {\n  public void existing() {}\n}");
    fs.writeFileSync(path.join(workspace, modernPath), "public class Service {\n  public void existing() {}\n  public void brandNew() {}\n}");

    const db = createDb();
    registerFixture(db, legacyPath);
    try {
      const result = computeDriftGate({
        workspaceRoot: workspace,
        legacyArtifactId: ARTIFACT_ID,
        legacyPath,
        expectedOutputPaths: [modernPath],
        db,
      });
      assert.equal(result.ok, true);
      assert.equal(result.highRisk, false);
      assert.ok(result.methodAddedInfo.length >= 1,
        `expected method-added info, got: ${JSON.stringify(result.methodAddedInfo)}`);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

// ─── Content SHA-256 from hashes, not agent prose ───────────────────────────

test("drift gate records byte-identical content_sha256 from actual file hash", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "guild-drift-hash-"));
  try {
    const legacyPath = "legacy/src/HashTest.java";
    const modernPath = "modern/src/HashTest.java";
    fs.mkdirSync(path.join(workspace, "legacy", "src"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "modern", "src"), { recursive: true });
    const modernContent = "public class HashTest {\n  public void go() {}\n}";
    fs.writeFileSync(path.join(workspace, legacyPath), "public class HashTest {\n  public void go() {}\n}");
    fs.writeFileSync(path.join(workspace, modernPath), modernContent);

    const expectedSha = contentSha256(Buffer.from(modernContent));

    const db = createDb();
    registerFixture(db, legacyPath);
    try {
      const result = computeDriftGate({
        workspaceRoot: workspace,
        legacyArtifactId: ARTIFACT_ID,
        legacyPath,
        expectedOutputPaths: [modernPath],
        db,
      });
      assert.equal(result.primaryContentSha256, expectedSha);
      assert.equal(result.primaryContentSha256?.length, 64);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("content-bound static evidence becomes stale when the output changes", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "guild-drift-stale-content-"));
  const legacyPath = "legacy/src/ContentTest.java";
  const modernPath = "modern/src/ContentTest.java";
  fs.mkdirSync(path.join(workspace, "legacy", "src"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "modern", "src"), { recursive: true });
  fs.writeFileSync(path.join(workspace, legacyPath), "public class ContentTest {}\n");
  fs.writeFileSync(path.join(workspace, modernPath), "public class ContentTest {}\n");
  const db = createDb();
  try {
    registerFixture(db, legacyPath);
    const signed = setupSignedEvidence(db, { pass: 1 });
    const gate = computeDriftGate({
      workspaceRoot: workspace,
      legacyArtifactId: ARTIFACT_ID,
      legacyPath,
      expectedOutputPaths: [modernPath],
      db,
      runId: signed.runId,
    });
    assert.equal(gate.ok, true);
    fs.appendFileSync(path.join(workspace, modernPath), "// changed after gate\n");
    const freshness = checkEvidenceFreshness(db, ARTIFACT_ID);
    assert.equal(freshness.ok, false);
    if (!freshness.ok) assert.match(freshness.reason, /output content changed/i);
  } finally {
    db.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

// ─── highRiskDriftKinds set is correctly defined ────────────────────────────

test("highRiskDriftKinds contains all four rejection-worthy kinds", () => {
  assert.ok(highRiskDriftKinds.has("private-constructor-added"));
  assert.ok(highRiskDriftKinds.has("field-became-final"));
  assert.ok(highRiskDriftKinds.has("public-method-removed"));
  assert.ok(highRiskDriftKinds.has("visibility-narrowed"));
  assert.equal(highRiskDriftKinds.has("method-added"), false);
  assert.equal(highRiskDriftKinds.size, 4);
});

// ─── Reviewer cannot write decisions ────────────────────────────────────────

test("approveArtifactWithEvidence preserves supervisor-owned arbitration", () => {
  const db = createDb();
  try {
    registerFixture(db);
    markMigrated(db);
    const signed = setupSignedEvidence(db, { pass: 1 });

    const decision = approveArtifactWithEvidence(db, {
      artifactId: ARTIFACT_ID,
      arbiter: "reviewer-agent",
      reason: "independent passing evidence",
      runId: signed.runId,
      operatorToken: signed.operatorToken,
    });
    assert.equal(decision.decision, "approved");
    const decisionRow = db.prepare("SELECT * FROM arbitration_decisions WHERE artifact_id = ? ORDER BY decided_at DESC LIMIT 1").get(ARTIFACT_ID) as { arbiter: string; decision: string };
    assert.equal(decisionRow.arbiter, "reviewer-agent");
    assert.equal(decisionRow.decision, "approved");
  } finally {
    db.close();
  }
});
