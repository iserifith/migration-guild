import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { registerArtifact, setArtifactStatus } from "../registry/commands/artifacts";
import { createRunOperatorCredential } from "../registry/commands/claim";
import {
  addAcceptanceEvidence,
  addCharacterizationFixtureEvidence,
  checkEvidenceFreshness,
  compareToFixture,
  listAcceptanceEvidence,
} from "../registry/commands/evidence";
import { readFixtureFile, writeFixtureFile } from "../registry/commands/fixture-file";
import { runCaptureFixture } from "../guildctl/commands/capture-fixture";
import { addVerifierRuntimeEvidence } from "../registry/commands/evidence";
import { startRun } from "../registry/commands/runs";
import { applySchema } from "../registry/db/schema";
import { RegistryError } from "../registry/types";

const ARTIFACT_ID = "legacy-source:com.acme:CharacterizationFixture";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function seedArtifact(db: Database.Database): void {
  registerArtifact(db, {
    id: ARTIFACT_ID,
    kind: "legacy-source",
    tier: "first-class",
    path: "legacy/src/main/java/com/acme/CharacterizationFixture.java",
  });
}

// ─── Foundational: evidence-type plumbing ────────────────────────────────────

test("applySchema widens an existing acceptance_evidence CHECK constraint in place, preserving prior rows", () => {
  const db = createDb();
  seedArtifact(db);

  // Simulate a pre-feature database: rebuild acceptance_evidence with the old,
  // narrower CHECK constraint and one pre-existing row.
  db.exec(`
    CREATE TABLE acceptance_evidence_old (
        evidence_id     TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
        artifact_id     TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
        run_id          TEXT REFERENCES runs(run_id) ON DELETE SET NULL,
        produced_by     TEXT NOT NULL,
        evidence_type   TEXT NOT NULL CHECK (evidence_type IN (
                           'runtime', 'test-command', 'build-command',
                           'static-check', 'review-verdict', 'benchmark-result'
                         )),
        command         TEXT,
        exit_code       INTEGER,
        pass            INTEGER NOT NULL CHECK (pass IN (0, 1)),
        summary         TEXT NOT NULL,
        output_path     TEXT,
        output_excerpt  TEXT,
        log_sha256      TEXT,
        duration_ms     INTEGER,
        authenticity    TEXT,
        content_sha256  TEXT,
        signature_json  TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.prepare(
    `INSERT INTO acceptance_evidence_old (evidence_id, artifact_id, produced_by, evidence_type, pass, summary)
     VALUES ('pre-existing-1', ?, 'some-agent', 'test-command', 1, 'pre-feature evidence')`,
  ).run(ARTIFACT_ID);
  db.exec("DROP TABLE acceptance_evidence; ALTER TABLE acceptance_evidence_old RENAME TO acceptance_evidence;");

  assert.throws(() =>
    db.prepare(
      `INSERT INTO acceptance_evidence (artifact_id, produced_by, evidence_type, pass, summary)
       VALUES (?, 'x', 'characterization-fixture', 1, 'should fail pre-upgrade')`,
    ).run(ARTIFACT_ID),
  );

  applySchema(db);

  const preExisting = db.prepare("SELECT * FROM acceptance_evidence WHERE evidence_id = 'pre-existing-1'").get();
  assert.ok(preExisting, "pre-existing evidence row must survive the CHECK-constraint rebuild");

  assert.doesNotThrow(() =>
    addCharacterizationFixtureEvidence(db, {
      artifactId: ARTIFACT_ID,
      pass: 1,
      summary: "post-upgrade fixture",
    }),
  );
});

test("characterization-fixture is a recordable evidence type but is rejected from the caller-asserted evidence-add path", () => {
  const db = createDb();
  seedArtifact(db);
  assert.throws(
    () =>
      addAcceptanceEvidence(db, {
        artifactId: ARTIFACT_ID,
        producedBy: "some-agent",
        evidenceType: "characterization-fixture",
        pass: 1,
        summary: "caller-asserted fixture",
      }),
    /characterization-fixture evidence must be recorded by guildctl capture-fixture/,
  );
});

test("addCharacterizationFixtureEvidence records a characterization-fixture row visible via listAcceptanceEvidence", () => {
  const db = createDb();
  seedArtifact(db);
  const evidence = addCharacterizationFixtureEvidence(db, {
    artifactId: ARTIFACT_ID,
    pass: 1,
    summary: "captured fixture",
    command: "npm test -- --grep Seam",
    outputPath: "/tmp/does-not-need-to-exist-for-this-assertion.json",
    contentSha256: "a".repeat(64),
  });
  assert.equal(evidence.evidence_type, "characterization-fixture");
  assert.equal(evidence.produced_by, "guildctl-capture-fixture");

  const rows = listAcceptanceEvidence(db, ARTIFACT_ID);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].evidence_id, evidence.evidence_id);
});

// ─── User Story 1: capture ───────────────────────────────────────────────────

test("US1: runCaptureFixture records a characterization-fixture evidence row for a passing seam", async () => {
  const db = createDb();
  seedArtifact(db);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "guild-capture-fixture-pass-"));
  try {
    const run = startRun(db, { agent: "guildctl-capture-fixture", ownerId: "guildctl" });
    const operatorToken = createRunOperatorCredential(db, run.run_id).token;
    const result = await runCaptureFixture(db, {
      artifactId: ARTIFACT_ID,
      seam: "UserServiceTest#testCreateUser",
      command: "node -e \"console.log(JSON.stringify({greeting: 'hello'}))\"",
      workspaceRoot: workspace,
      outputDir: path.join(workspace, ".guild/evidence/characterization"),
      runId: run.run_id,
      operatorToken,
    });

    assert.equal(result.captured, true);
    if (!result.captured) throw new Error("unreachable");
    const rows = listAcceptanceEvidence(db, ARTIFACT_ID);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].evidence_type, "characterization-fixture");
    assert.equal(rows[0].pass, 1);
    assert.ok(rows[0].output_path && fs.existsSync(rows[0].output_path));
    assert.ok(rows[0].content_sha256);

    const fixture = readFixtureFile(rows[0].output_path!);
    assert.equal(fixture.seam, "UserServiceTest#testCreateUser");
    assert.deepEqual(fixture.output, { greeting: "hello" });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("US1: runCaptureFixture skips (does not fabricate a fixture) when the seam command fails", async () => {
  const db = createDb();
  seedArtifact(db);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "guild-capture-fixture-skip-"));
  try {
    const run = startRun(db, { agent: "guildctl-capture-fixture", ownerId: "guildctl" });
    const operatorToken = createRunOperatorCredential(db, run.run_id).token;
    const result = await runCaptureFixture(db, {
      artifactId: ARTIFACT_ID,
      seam: "IntegrationTest#testCheckout",
      command: "node -e \"process.exit(1)\"",
      workspaceRoot: workspace,
      outputDir: path.join(workspace, ".guild/evidence/characterization"),
      runId: run.run_id,
      operatorToken,
    });

    assert.equal(result.captured, false);
    if (result.captured) throw new Error("unreachable");
    assert.ok(result.reason.length > 0);
    assert.equal(listAcceptanceEvidence(db, ARTIFACT_ID).length, 0);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("US1: capturing twice for the same artifact/seam produces two independent evidence rows", async () => {
  const db = createDb();
  seedArtifact(db);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "guild-capture-fixture-recapture-"));
  try {
    for (let i = 0; i < 2; i++) {
      const run = startRun(db, { agent: "guildctl-capture-fixture", ownerId: "guildctl" });
      const operatorToken = createRunOperatorCredential(db, run.run_id).token;
      const result = await runCaptureFixture(db, {
        artifactId: ARTIFACT_ID,
        seam: "UserServiceTest#testCreateUser",
        command: "node -e \"console.log(JSON.stringify({n: " + i + "}))\"",
        workspaceRoot: workspace,
        outputDir: path.join(workspace, ".guild/evidence/characterization"),
        runId: run.run_id,
        operatorToken,
      });
      assert.equal(result.captured, true);
    }
    const rows = listAcceptanceEvidence(db, ARTIFACT_ID);
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0].evidence_id, rows[1].evidence_id);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

// ─── User Story 2: Migrate consults the fixture ──────────────────────────────

function captureFixtureDirectly(
  db: Database.Database,
  workspace: string,
  output: unknown,
): void {
  const written = writeFixtureFile({
    dir: path.join(workspace, ".guild/evidence/characterization"),
    id: "fixture-1",
    seam: "UserServiceTest#testCreateUser",
    input: { name: "Ada" },
    output,
  });
  addCharacterizationFixtureEvidence(db, {
    artifactId: ARTIFACT_ID,
    pass: 1,
    summary: "captured fixture",
    command: "npm test -- --grep Seam",
    outputPath: written.path,
    contentSha256: written.contentSha256,
  });
}

test("US2: compareToFixture returns match:true for identical candidate output", () => {
  const db = createDb();
  seedArtifact(db);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "guild-compare-fixture-match-"));
  try {
    captureFixtureDirectly(db, workspace, { greeting: "hello" });
    const result = compareToFixture(db, ARTIFACT_ID, { greeting: "hello" });
    assert.deepEqual(result, { match: true });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("US2: compareToFixture returns match:false with a diff for differing candidate output", () => {
  const db = createDb();
  seedArtifact(db);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "guild-compare-fixture-mismatch-"));
  try {
    captureFixtureDirectly(db, workspace, { greeting: "hello" });
    const result = compareToFixture(db, ARTIFACT_ID, { greeting: "goodbye" });
    assert.equal(result.match, false);
    if (result.match) throw new Error("unreachable");
    assert.ok(result.diff.length > 0);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("US2: compareToFixture throws a distinguishable RegistryError when no fixture has been captured", () => {
  const db = createDb();
  seedArtifact(db);
  assert.throws(
    () => compareToFixture(db, ARTIFACT_ID, { anything: true }),
    (error: unknown) => error instanceof RegistryError && /No characterization-fixture evidence found/.test(error.message),
  );
});

// ─── User Story 3: Arbiter-visible evidence + freshness ─────────────────────

test("US3: a recorded comparison result is visible via listAcceptanceEvidence alongside other evidence types", () => {
  const db = createDb();
  seedArtifact(db);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "guild-fixture-arbiter-visible-"));
  try {
    captureFixtureDirectly(db, workspace, { greeting: "hello" });
    const comparison = compareToFixture(db, ARTIFACT_ID, { greeting: "goodbye" });
    assert.equal(comparison.match, false);
    if (comparison.match) throw new Error("unreachable");

    addCharacterizationFixtureEvidence(db, {
      artifactId: ARTIFACT_ID,
      pass: 0,
      summary: `Fixture comparison failed: ${comparison.diff}`,
      outputExcerpt: comparison.diff,
    });

    const rows = listAcceptanceEvidence(db, ARTIFACT_ID);
    const comparisonRows = rows.filter((row) => row.evidence_type === "characterization-fixture");
    assert.equal(comparisonRows.length, 2);
    assert.ok(comparisonRows.some((row) => row.pass === 0));
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("US3: checkEvidenceFreshness flags a characterization-fixture as stale when its file content no longer matches its recorded hash", () => {
  const db = createDb();
  seedArtifact(db);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "guild-fixture-freshness-"));
  try {
    captureFixtureDirectly(db, workspace, { greeting: "hello" });

    // Bind a passing runtime evidence row so checkEvidenceFreshness's early
    // "no runtime evidence" short-circuit doesn't skip the fixture check.
    const run = startRun(db, { agent: "guildctl-verify", ownerId: "guildctl" });
    const operatorToken = createRunOperatorCredential(db, run.run_id).token;
    addVerifierRuntimeEvidence(db, {
      artifactId: ARTIFACT_ID,
      runId: run.run_id,
      command: "npm test",
      exitCode: 0,
      pass: 1,
      summary: "runtime evidence",
      outputPath: (() => {
        const logPath = path.join(workspace, "runtime.log");
        fs.writeFileSync(logPath, "log");
        return logPath;
      })(),
      logSha256: createHash("sha256").update("log").digest("hex"),
      durationMs: 1,
      authenticity: "irrelevant-for-this-assertion",
    });

    assert.equal(checkEvidenceFreshness(db, ARTIFACT_ID).ok, true);

    // Mutate the fixture file on disk without updating the recorded hash.
    const rows = listAcceptanceEvidence(db, ARTIFACT_ID);
    const fixtureRow = rows.find((row) => row.evidence_type === "characterization-fixture");
    assert.ok(fixtureRow?.output_path);
    const mutated = { ...readFixtureFile(fixtureRow!.output_path!), output: { greeting: "tampered" } };
    fs.writeFileSync(fixtureRow!.output_path!, JSON.stringify(mutated));

    const freshness = checkEvidenceFreshness(db, ARTIFACT_ID);
    assert.equal(freshness.ok, false);
    if (freshness.ok) throw new Error("unreachable");
    assert.match(freshness.reason, /characterization-fixture output changed after capture/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
