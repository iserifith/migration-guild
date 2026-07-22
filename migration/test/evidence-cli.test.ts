import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { registerArtifact, setArtifactStatus } from "../registry/commands/artifacts";
import { getEvents } from "../registry/commands/events";
import { getArtifactById } from "../registry/commands/queries";
import { applySchema } from "../registry/db/schema";

const ARTIFACT_ID = "legacy-source:com.acme.customer:LegacyCustomerService";

function createFixture(): { dir: string; dbPath: string; cwd: string; scriptPath: string } {
  const cwd = path.resolve(__dirname, "..");
  const dir = mkdtempSync(path.join(tmpdir(), "guildctl-evidence-cli-"));
  const dbPath = path.join(dir, "registry.db");
  const db = new Database(dbPath);
  try {
    applySchema(db);
    registerArtifact(db, {
      id: ARTIFACT_ID,
      kind: "legacy-source",
      path: "legacy/src/main/java/com/acme/customer/LegacyCustomerService.java",
      tier: "first-class",
    });
    setArtifactStatus(db, ARTIFACT_ID, "migrated", {
      agent: "builder-agent",
      reason: "builder proposal",
    });
  } finally {
    db.close();
  }
  return {
    dir,
    dbPath,
    cwd,
    scriptPath: path.join(cwd, "guildctl", "cli.ts"),
  };
}

function runCli(fixture: { cwd: string; scriptPath: string; dbPath: string }, args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", fixture.scriptPath, "--db", fixture.dbPath, ...args], {
    cwd: fixture.cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      DOTENV_CONFIG_SILENT: "true",
    },
  });
}

function runRegistryCli(fixture: { cwd: string; dbPath: string }, args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", path.join(fixture.cwd, "registry", "cli.ts"), "--db", fixture.dbPath, ...args], {
    cwd: fixture.cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      DOTENV_CONFIG_SILENT: "true",
    },
  });
}

function withFixture(fn: (fixture: ReturnType<typeof createFixture>) => void): void {
  const fixture = createFixture();
  try {
    fn(fixture);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
}

test("help output includes evidence and arbitrate commands", () => {
  withFixture((fixture) => {
    const result = runCli(fixture, ["--help"]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /evidence/);
    assert.match(result.stdout, /arbitrate/);
  });
});

test("registry CLI forbids direct promotion to reviewed", () => {
  withFixture((fixture) => {
    const result = runRegistryCli(fixture, [
      "set-artifact-status",
      "--id",
      ARTIFACT_ID,
      "--status",
      "reviewed",
      "--agent",
      "review-agent",
    ]);

    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /Direct promotion to reviewed is forbidden/);

    const db = new Database(fixture.dbPath);
    try {
      assert.equal(getArtifactById(db, ARTIFACT_ID)?.status, "migrated");
      const decisions = db.prepare("SELECT COUNT(*) AS count FROM arbitration_decisions WHERE artifact_id = ?").get(ARTIFACT_ID) as { count: number };
      assert.equal(decisions.count, 0);
    } finally {
      db.close();
    }
  });
});

test("evidence add records evidence", () => {
  withFixture((fixture) => {
    const result = runCli(fixture, [
      "evidence",
      "add",
      "--artifact",
      ARTIFACT_ID,
      "--type",
      "test-command",
      "--produced-by",
      "review-agent",
      "--command",
      "npm test",
      "--exit-code",
      "0",
      "--summary",
      "tests passed",
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Evidence recorded/);
    const db = new Database(fixture.dbPath);
    try {
      const rows = db.prepare("SELECT * FROM acceptance_evidence WHERE artifact_id = ?").all(ARTIFACT_ID) as Array<Record<string, unknown>>;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.produced_by, "review-agent");
      assert.equal(rows[0]?.pass, 1);
      const events = getEvents(db, ARTIFACT_ID, "evidence-submitted", 1);
      assert.equal(events.length, 1);
      assert.match(events[0].summary, /Evidence submitted/i);
    } finally {
      db.close();
    }
  });
});

test("evidence list --json returns rows", () => {
  withFixture((fixture) => {
    const addResult = runCli(fixture, [
      "evidence",
      "add",
      "--artifact",
      ARTIFACT_ID,
      "--type",
      "build-command",
      "--produced-by",
      "critic-agent",
      "--command",
      "npm run build",
      "--exit-code",
      "0",
      "--summary",
      "build passed",
    ]);
    assert.equal(addResult.status, 0, addResult.stderr);

    const result = runCli(fixture, ["evidence", "list", "--artifact", ARTIFACT_ID, "--json"]);

    assert.equal(result.status, 0, result.stderr);
    const rows = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.evidence_type, "build-command");
    assert.equal(rows[0]?.summary, "build passed");
  });
});

test("arbitrate --approve fails without evidence", () => {
  withFixture((fixture) => {
    const result = runCli(fixture, [
      "arbitrate",
      "--artifact",
      ARTIFACT_ID,
      "--approve",
      "--arbiter",
      "arbiter-agent",
      "--reason",
      "approve with no proof",
    ]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /runtime evidence/i);
  });
});

test("arbitrate --approve rejects runtime evidence without a run operator credential", () => {
  withFixture((fixture) => {
    const verifyResult = runCli(fixture, [
      "verify",
      "--artifact",
      ARTIFACT_ID,
      "--command",
      "node -e \"console.log('runtime ok')\"",
    ]);
    assert.equal(verifyResult.status, 0, verifyResult.stderr);

    const result = runCli(fixture, [
      "arbitrate",
      "--artifact",
      ARTIFACT_ID,
      "--approve",
      "--arbiter",
      "arbiter-agent",
      "--reason",
      "passing independent runtime evidence",
    ]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /valid run operator credential/i);
    const db = new Database(fixture.dbPath);
    try {
      assert.equal(getArtifactById(db, ARTIFACT_ID).status, "migrated");
      const decisions = db.prepare("SELECT * FROM arbitration_decisions WHERE artifact_id = ?").all(ARTIFACT_ID);
      assert.equal(decisions.length, 0);
    } finally {
      db.close();
    }
  });
});

test("verify --json exits nonzero when runtime verification fails", () => {
  withFixture((fixture) => {
    const result = runCli(fixture, [
      "verify",
      "--artifact",
      ARTIFACT_ID,
      "--command",
      "node -e \"process.exit(9)\"",
      "--json",
    ]);

    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout) as { pass: boolean; evidence: Array<{ exit_code: number; pass: number }> };
    assert.equal(payload.pass, false);
    assert.equal(payload.evidence[0]?.exit_code, 9);
    assert.equal(payload.evidence[0]?.pass, 0);
  });
});

test("arbitrate --reject moves artifact to needs-rework", () => {
  withFixture((fixture) => {
    const addResult = runCli(fixture, [
      "evidence",
      "add",
      "--artifact",
      ARTIFACT_ID,
      "--type",
      "test-command",
      "--produced-by",
      "critic-agent",
      "--command",
      "npm test",
      "--exit-code",
      "1",
      "--summary",
      "tests failed",
    ]);
    assert.equal(addResult.status, 0, addResult.stderr);

    const result = runCli(fixture, [
      "arbitrate",
      "--artifact",
      ARTIFACT_ID,
      "--reject",
      "--arbiter",
      "arbiter-agent",
      "--reason",
      "tests failed",
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /rejected/);
    const db = new Database(fixture.dbPath);
    try {
      assert.equal(getArtifactById(db, ARTIFACT_ID).status, "needs-rework");
    } finally {
      db.close();
    }
  });
});
