import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { registerArtifact, setArtifactStatus } from "../registry/commands/artifacts";
import { addAcceptanceEvidence, recordArbitrationDecision } from "../registry/commands/evidence";
import { appendEvent } from "../registry/commands/events";
import { applySchema } from "../registry/db/schema";

const ARTIFACT_ID = "legacy-source:com.acme:Foo";
function fixture(seed = false) {
  const cwd = path.resolve(__dirname, "..");
  const dir = mkdtempSync(path.join(tmpdir(), "guildctl-society-report-"));
  const dbPath = path.join(dir, "registry.db");
  const db = new Database(dbPath);
  applySchema(db);
  if (seed) {
    registerArtifact(db, { id: ARTIFACT_ID, kind: "legacy-source", path: "legacy/src/main/java/com/acme/Foo.java", tier: "first-class" });
    setArtifactStatus(db, ARTIFACT_ID, "migrated", { agent: "builder-agent", reason: "proposal" });
    db.prepare("INSERT INTO runs (agent, status, exit_code, started_at, finished_at) VALUES ('analyze-agent','completed',0,datetime('now','-2 minutes'),datetime('now','-1 minutes'))").run();
    appendEvent(db, { id: ARTIFACT_ID, type: "proposal-submitted", agent: "builder-agent", summary: "Builder proposed migrated artifact" });
    const ev = addAcceptanceEvidence(db, { artifactId: ARTIFACT_ID, producedBy: "critic-agent", evidenceType: "test-command", command: "npm test", exitCode: 0, pass: 1, summary: "tests passed" });
    appendEvent(db, { id: ARTIFACT_ID, type: "evidence-submitted", agent: "critic-agent", summary: "Critic submitted evidence" });
    recordArbitrationDecision(db, { artifactId: ARTIFACT_ID, arbiter: "arbiter-agent", decision: "approved", reason: "proof ok", evidenceIds: [ev.evidence_id] });
  }
  db.close();
  return { cwd, dir, dbPath, scriptPath: path.join(cwd, "guildctl", "cli.ts") };
}
function run(fx: ReturnType<typeof fixture>, args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", fx.scriptPath, "--db", fx.dbPath, ...args], { cwd: fx.cwd, encoding: "utf8" });
}
function withFixture(seed: boolean, fn: (fx: ReturnType<typeof fixture>) => void) { const fx=fixture(seed); try { fn(fx); } finally { rmSync(fx.dir,{recursive:true,force:true}); } }

test("society-report empty DB returns zeros", () => withFixture(false, (fx) => {
  const res = run(fx, ["society-report", "--json"]);
  assert.equal(res.status, 0, res.stderr);
  const json = JSON.parse(res.stdout);
  assert.equal(json.evidence.total, 0);
  assert.equal(json.task_division.active_claims, 0);
}));

test("society-report seeded DB shows roles status evidence and arbitration", () => withFixture(true, (fx) => {
  const res = run(fx, ["society-report", "--json"]);
  assert.equal(res.status, 0, res.stderr);
  const json = JSON.parse(res.stdout);
  assert.equal(json.roles["analyze-agent"], 1);
  assert.equal(json.task_division.by_status.migrated, 1);
  assert.equal(json.dialogue["proposal-submitted"], 1);
  assert.equal(json.evidence.passed, 1);
  assert.equal(json.conflict_resolution.arbitration_approved, 1);
}));

test("society-report human output includes judge-facing labels", () => withFixture(true, (fx) => {
  const res = run(fx, ["society-report"]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Roles observed/);
  assert.match(res.stdout, /Task division/);
  assert.match(res.stdout, /Dialogue/);
  assert.match(res.stdout, /Conflict resolution/);
  assert.match(res.stdout, /Evidence/);
  assert.match(res.stdout, /Efficiency hooks/);
}));
