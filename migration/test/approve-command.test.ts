import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { runApprove } from "../guildctl/commands/approve";
import { getRiskRow } from "./approval-fixtures";
import {
  HIGH_RISK_ARTIFACT_ID,
  createApprovalGateDb,
  seedHighRiskArtifact,
  seedLowRiskArtifact,
} from "./approval-fixtures";
import { appendEvent } from "../registry/commands/events";
import { applySchema } from "../registry/db/schema";
import { registerArtifact } from "../registry/commands/artifacts";
import { applyRiskAssessment } from "../guildctl/risk";
import { RegistryError } from "../registry/types";
import { DEFAULT_GUILD_CONFIG, stringifySimpleYaml } from "../guildctl/config";
import { makeTempDir, repoMigrationRoot, tsxLoaderUrl } from "./truthful-run-state-fixtures";

// US2 / T012 (spec 013, FR-004, contracts/registry-commands.md §listPendingApprovals
// + §CLI contract: guildctl approve): regression suite for the human decision
// path out of pending-approval. Written tests-first — the suite MUST fail until
// T013 (listPendingApprovals), T014 (runApprove) and T015 (cli registration)
// land. All decision tests drive the exported runApprove(db, opts) handler the
// way arbitrate-manual-approval.test.ts drives runArbitrate; the --list tests
// additionally exercise the real CLI dispatch via the compiled cli.ts entry.

function getStatus(db: Database.Database, artifactId: string): string {
  const row = db.prepare("SELECT status FROM artifacts WHERE id = ?").get(artifactId) as { status: string } | undefined;
  return row?.status ?? "";
}

function getApprovalDecisions(db: Database.Database, artifactId: string): Array<Record<string, unknown>> {
  return db.prepare(
    "SELECT * FROM approval_decisions WHERE artifact_id = ? ORDER BY rowid",
  ).all(artifactId) as Array<Record<string, unknown>>;
}

function getEvents(db: Database.Database, artifactId: string, type?: string): Array<{ type: string; data: string | null }> {
  if (type) {
    return db.prepare(
      "SELECT type, event_data AS data FROM events WHERE artifact_id = ? AND type = ? ORDER BY rowid",
    ).all(artifactId, type) as Array<{ type: string; data: string | null }>;
  }
  return db.prepare(
    "SELECT type, event_data AS data FROM events WHERE artifact_id = ? ORDER BY rowid",
  ).all(artifactId) as Array<{ type: string; data: string | null }>;
}

/**
 * Drive a seeded high-risk artifact into `pending-approval` — the state the
 * evidence.ts approval path leaves an above-cutoff artifact in after an
 * approving arbiter verdict (mirrors applyApprovalPathOutcome in
 * approval-gate.test.ts and the real status-transition SQL shape).
 */
function driveIntoPendingApproval(db: Database.Database, artifactId: string): void {
  db.prepare("UPDATE artifacts SET status = 'pending-approval', updated_at = datetime('now') WHERE id = ?").run(artifactId);
  appendEvent(db, {
    id: artifactId,
    type: "approval-gated",
    agent: "arbiter:test",
    summary: "Held for human approval: risk above cutoff",
    data: JSON.stringify({ role: "arbiter", target_status: "pending-approval" }),
  });
}

// ─── Decision path: runApprove handler ──────────────────────────────────────

test("T012: runApprove approves a held artifact — reviewed, one approval_decisions row, approval-approved event", async () => {
  const gate = createApprovalGateDb();
  try {
    seedHighRiskArtifact(gate);
    driveIntoPendingApproval(gate.db, HIGH_RISK_ARTIFACT_ID);

    await runApprove(gate.db, { artifact: HIGH_RISK_ARTIFACT_ID });

    assert.equal(getStatus(gate.db, HIGH_RISK_ARTIFACT_ID), "reviewed");

    const rows = getApprovalDecisions(gate.db, HIGH_RISK_ARTIFACT_ID);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].decision, "approved");
    assert.equal(rows[0].operator, "guildctl-approve");

    const events = getEvents(gate.db, HIGH_RISK_ARTIFACT_ID, "approval-approved");
    assert.equal(events.length, 1);
    const data = events[0].data ? JSON.parse(events[0].data) as Record<string, unknown> : {};
    assert.equal(data.target_status, "reviewed");
  } finally {
    gate.db.close();
  }
});

test("T012: runApprove --reject --reason moves the held artifact to needs-rework and stores the reason", async () => {
  const gate = createApprovalGateDb();
  try {
    seedHighRiskArtifact(gate);
    driveIntoPendingApproval(gate.db, HIGH_RISK_ARTIFACT_ID);

    const reason = "not ready";
    await runApprove(gate.db, {
      artifact: HIGH_RISK_ARTIFACT_ID,
      reject: true,
      reason,
    });

    assert.equal(getStatus(gate.db, HIGH_RISK_ARTIFACT_ID), "needs-rework");

    const rows = getApprovalDecisions(gate.db, HIGH_RISK_ARTIFACT_ID);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].decision, "rejected");
    assert.equal(rows[0].reason, reason);

    const events = getEvents(gate.db, HIGH_RISK_ARTIFACT_ID, "approval-rejected");
    assert.equal(events.length, 1);
    const data = events[0].data ? JSON.parse(events[0].data) as Record<string, unknown> : {};
    assert.equal(data.target_status, "needs-rework");
  } finally {
    gate.db.close();
  }
});

test("T012: runApprove --reject without --reason is refused with the registry's exact message, no state change", async () => {
  const gate = createApprovalGateDb();
  try {
    seedHighRiskArtifact(gate);
    driveIntoPendingApproval(gate.db, HIGH_RISK_ARTIFACT_ID);

    await assert.rejects(
      runApprove(gate.db, { artifact: HIGH_RISK_ARTIFACT_ID, reject: true }),
      (error: unknown) => {
        assert.ok(error instanceof RegistryError, `expected RegistryError, got ${error}`);
        assert.equal(error.message, "A rejection reason is required.");
        return true;
      },
    );
    assert.equal(getStatus(gate.db, HIGH_RISK_ARTIFACT_ID), "pending-approval");
    assert.equal(getApprovalDecisions(gate.db, HIGH_RISK_ARTIFACT_ID).length, 0);
  } finally {
    gate.db.close();
  }
});

test("T012: runApprove refuses an artifact that is not awaiting approval", async () => {
  const gate = createApprovalGateDb();
  try {
    // Low-risk artifact left in `migrated` — never held for approval.
    seedLowRiskArtifact(gate, { status: "migrated" });

    await assert.rejects(
      runApprove(gate.db, { artifact: "legacy-source:com.acme.low:LowRiskThing" }),
      (error: unknown) => {
        assert.ok(error instanceof RegistryError, `expected RegistryError, got ${error}`);
        assert.equal(error.message, "Artifact is not awaiting approval.");
        return true;
      },
    );
    assert.equal(getStatus(gate.db, "legacy-source:com.acme.low:LowRiskThing"), "migrated");
  } finally {
    gate.db.close();
  }
});

// ─── CLI boundary: --list through the real dispatch (T015 registration) ─────

const LOW_RISK_ARTIFACT_ID = "legacy-source:com.acme.low:LowRiskThing";

function fixtureWorkspace(): string {
  const root = makeTempDir("guild-approve-cli-");
  fs.mkdirSync(path.join(root, ".guild"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".guild", "config.yaml"),
    stringifySimpleYaml({ ...DEFAULT_GUILD_CONFIG, stack: "java-spring" } as unknown as Record<string, unknown>),
  );
  return root;
}

function runCli(root: string, dbPath: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ["--import", tsxLoaderUrl(), path.join(repoMigrationRoot(), "guildctl", "cli.ts"), "--workspace", root, "--db", dbPath, ...args],
    {
      cwd: repoMigrationRoot(),
      encoding: "utf8",
      env: { ...process.env, DOTENV_CONFIG_SILENT: "true" },
    },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Seed an on-disk registry the way createApprovalGateDb does in memory:
 * schema, a run + operator credential, and one high-risk artifact held at
 * pending-approval (with its signed runtime evidence and risk row). The CLI
 * child process reopens this db path.
 */
function seedHeldArtifactDb(dbPath: string): { artifactId: string; reasonCodes: string[]; verdictSummary: string; enteredPendingApprovalAt: string } {
  const db = new Database(dbPath);
  try {
    applySchema(db);
    registerArtifact(db, {
      id: HIGH_RISK_ARTIFACT_ID,
      kind: "legacy-source",
      path: "legacy/src/main/java/HighRiskThing.java",
    });
    const reasonCodes = ["god_method", "reflection_usage"];
    applyRiskAssessment(db, {
      id: HIGH_RISK_ARTIFACT_ID,
      riskScore: 82,
      highRisk: true,
      reasonCodes,
      signals: {},
    });
    assert.ok(getRiskRow(db, HIGH_RISK_ARTIFACT_ID));
    const verdictSummary = "Automated review passed on signed runtime evidence.";
    db.prepare(
      "INSERT INTO arbitration_decisions (artifact_id, arbiter, decision, reason, evidence_ids) VALUES (?, ?, 'approved', ?, '[]')",
    ).run(HIGH_RISK_ARTIFACT_ID, "arbiter-agent", verdictSummary);
    db.prepare("UPDATE artifacts SET status = 'pending-approval', updated_at = datetime('now') WHERE id = ?").run(HIGH_RISK_ARTIFACT_ID);
    appendEvent(db, {
      id: HIGH_RISK_ARTIFACT_ID,
      type: "approval-gated",
      agent: "arbiter:test",
      summary: "Held for human approval: risk above cutoff",
      data: JSON.stringify({ role: "arbiter", target_status: "pending-approval" }),
    });
    const row = db.prepare("SELECT updated_at FROM artifacts WHERE id = ?").get(HIGH_RISK_ARTIFACT_ID) as { updated_at: string };
    return {
      artifactId: HIGH_RISK_ARTIFACT_ID,
      reasonCodes,
      verdictSummary,
      enteredPendingApprovalAt: row.updated_at,
    };
  } finally {
    db.close();
  }
}

test("T012: guildctl approve --list with nothing pending prints an empty list and exits 0", () => {
  const root = fixtureWorkspace();
  try {
    const dbPath = path.join(root, ".guild", "registry.db");
    const db = new Database(dbPath);
    try {
      applySchema(db);
    } finally {
      db.close();
    }

    const { status, stdout, stderr } = runCli(root, dbPath, ["approve", "--list"]);
    assert.equal(status, 0, `expected exit 0\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    assert.match(stdout, /no artifacts/i);
    assert.doesNotMatch(stdout, new RegExp(HIGH_RISK_ARTIFACT_ID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const json = runCli(root, dbPath, ["approve", "--list", "--json"]);
    assert.equal(json.status, 0, `expected exit 0\nstdout:\n${json.stdout}\nstderr:\n${json.stderr}`);
    assert.deepEqual(JSON.parse(json.stdout.trim()), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("T012: guildctl approve --list surfaces the PendingApproval shape for a held artifact", () => {
  const root = fixtureWorkspace();
  try {
    const dbPath = path.join(root, ".guild", "registry.db");
    const seeded = seedHeldArtifactDb(dbPath);

    const human = runCli(root, dbPath, ["approve", "--list"]);
    assert.equal(human.status, 0, `expected exit 0\nstdout:\n${human.stdout}\nstderr:\n${human.stderr}`);
    assert.match(human.stdout, new RegExp(seeded.artifactId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    for (const code of seeded.reasonCodes) {
      assert.match(human.stdout, new RegExp(code));
    }
    assert.match(human.stdout, new RegExp(seeded.verdictSummary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(human.stdout, new RegExp(seeded.enteredPendingApprovalAt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const json = runCli(root, dbPath, ["approve", "--list", "--json"]);
    assert.equal(json.status, 0, `expected exit 0\nstdout:\n${json.stdout}\nstderr:\n${json.stderr}`);
    const parsed = JSON.parse(json.stdout.trim()) as Array<{
      artifactId: string;
      riskReasonCodes: string[];
      arbitrationVerdictSummary: string;
      enteredPendingApprovalAt: string;
    }>;
    assert.equal(parsed.length, 1);
    assert.deepEqual(parsed[0], {
      artifactId: seeded.artifactId,
      riskReasonCodes: seeded.reasonCodes,
      arbitrationVerdictSummary: seeded.verdictSummary,
      enteredPendingApprovalAt: seeded.enteredPendingApprovalAt,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("T012: guildctl approve --reject without --reason exits non-zero with one clean stderr line", () => {
  const root = fixtureWorkspace();
  try {
    const dbPath = path.join(root, ".guild", "registry.db");
    seedHeldArtifactDb(dbPath);

    const { status, stderr } = runCli(root, dbPath, ["approve", HIGH_RISK_ARTIFACT_ID, "--reject"]);
    assert.notEqual(status, 0, `expected non-zero exit, got ${status}\nstderr:\n${stderr}`);
    assert.match(stderr, /A rejection reason is required\./);
    assert.doesNotMatch(stderr, /Command\.listener|Command\._parseCommand|node_modules[\\/]commander/);

    const after = new Database(dbPath);
    try {
      assert.equal(getStatus(after, HIGH_RISK_ARTIFACT_ID), "pending-approval");
    } finally {
      after.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("T012: guildctl approve on an artifact not in pending-approval exits non-zero with the exact gate message", () => {
  const root = fixtureWorkspace();
  try {
    const dbPath = path.join(root, ".guild", "registry.db");
    const db = new Database(dbPath);
    try {
      applySchema(db);
      registerArtifact(db, {
        id: LOW_RISK_ARTIFACT_ID,
        kind: "legacy-source",
        path: "legacy/src/main/java/LowRiskThing.java",
      });
      db.prepare("UPDATE artifacts SET status = 'migrated', updated_at = datetime('now') WHERE id = ?").run(LOW_RISK_ARTIFACT_ID);
    } finally {
      db.close();
    }

    const { status, stderr } = runCli(root, dbPath, ["approve", LOW_RISK_ARTIFACT_ID]);
    assert.notEqual(status, 0, `expected non-zero exit, got ${status}\nstderr:\n${stderr}`);
    assert.match(stderr, /Artifact is not awaiting approval\./);
    assert.doesNotMatch(stderr, /Command\.listener|Command\._parseCommand|node_modules[\\/]commander/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

