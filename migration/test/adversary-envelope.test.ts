import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
  ADVERSARY_ENVELOPE_AGENT,
  REJECTION_ENVELOPE_AGENT,
  getAdversaryEnvelope,
  getContext,
  getRejectionEnvelope,
  writeAdversaryEnvelope,
  writeRejectionEnvelope,
} from "../registry/commands/context";
import { addVerifierRuntimeEvidence, approveArtifactWithEvidence, listAcceptanceEvidence } from "../registry/commands/evidence";
import { getEvents } from "../registry/commands/events";
import { sha256, signRuntimeEvidence } from "../guildctl/verify";
import {
  createApprovalGateDb,
  seedHighRiskArtifact,
  seedLowRiskArtifact,
  type ApprovalGateDb,
} from "./approval-fixtures";
import { makeTempDir } from "./truthful-run-state-fixtures";

/**
 * Coverage for the adversary-agent checkpoint (#217, building on #216):
 * - migration/registry/commands/context.ts's writeAdversaryEnvelope/
 *   getAdversaryEnvelope primitives (US1/US2, mirroring rejection-envelope.test.ts)
 * - the checkpoint wired into approveArtifactWithEvidence's below-cutoff and
 *   gate-bound branches (US1, migration/registry/commands/evidence.ts)
 * - the fail-open write / fail-closed routing asymmetry (US3)
 *
 * writeAdversaryEnvelope resolves its write path relative to cwd (mirroring
 * writeContext/writeRejectionEnvelope), and getAdversaryEnvelope resolves
 * reads via GUILD_WORKSPACE, so every test runs inside a throwaway workspace.
 */

const ARTIFACT_ID = "legacy-source:com.acme:ProbedThing";
const OTHER_ARTIFACT_ID = "legacy-source:com.acme:OtherProbedThing";

function withWorkspace<T>(fn: (workspaceRoot: string) => T): T {
  const workspaceRoot = makeTempDir("guild-adversary-envelope-");
  const prevCwd = process.cwd();
  const prevEnv = process.env.GUILD_WORKSPACE;
  process.chdir(workspaceRoot);
  process.env.GUILD_WORKSPACE = workspaceRoot;
  try {
    return fn(workspaceRoot);
  } finally {
    process.chdir(prevCwd);
    if (prevEnv === undefined) {
      delete process.env.GUILD_WORKSPACE;
    } else {
      process.env.GUILD_WORKSPACE = prevEnv;
    }
  }
}

function getStatus(db: Database.Database, artifactId: string): string {
  const row = db.prepare("SELECT status FROM artifacts WHERE id = ?").get(artifactId) as { status: string } | undefined;
  return row?.status ?? "";
}

/**
 * Bind run-scoped, authenticity-signed runtime evidence with a real on-disk
 * log to an artifact — the strict shape approveArtifactWithEvidence's
 * validateRuntimeEvidence requires (run binding, log file matching
 * log_sha256, HMAC authenticity), which the fixtures' default seeded
 * evidence deliberately does not provide (see arbitrate-approve-gate.test.ts's
 * identical helper/comment for why).
 */
function bindApproveableEvidence(gate: ApprovalGateDb, artifactId: string): void {
  const log = "runtime ok\n";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guild-adversary-evidence-"));
  const logPath = path.join(dir, "runtime.log");
  fs.writeFileSync(logPath, log);
  const logSha256 = sha256(log);
  const command = "npm test";
  const exitCode = 0;
  const pass = 1 as const;
  addVerifierRuntimeEvidence(gate.db, {
    artifactId,
    producedBy: "critic-agent",
    runId: gate.runId,
    command,
    exitCode,
    pass,
    summary: "runtime passed",
    outputPath: logPath,
    outputExcerpt: log,
    logSha256,
    durationMs: 10,
    authenticity: signRuntimeEvidence(
      { artifactId, runId: gate.runId, command, exitCode, pass, logSha256 },
      gate.operatorToken,
    ),
  });
}

function approveOpts(gate: ApprovalGateDb, artifactId: string, extra: Record<string, unknown> = {}) {
  return {
    artifactId,
    arbiter: "arbiter-agent",
    reason: "independent executable evidence passed",
    runId: gate.runId,
    operatorToken: gate.operatorToken,
    ...extra,
  };
}

// ─── writeAdversaryEnvelope / getAdversaryEnvelope primitives (T019) ──────

function createFixture(): Database.Database {
  const gate = createApprovalGateDb();
  seedLowRiskArtifact(gate, { artifactId: ARTIFACT_ID });
  seedLowRiskArtifact(gate, { artifactId: OTHER_ARTIFACT_ID });
  return gate.db;
}

test("writeAdversaryEnvelope then getAdversaryEnvelope round-trips the exact finding text", () => {
  withWorkspace(() => {
    const db = createFixture();
    const finding = "Constructed case: empty-cart checkout bypasses the minimum-order-total check.";
    writeAdversaryEnvelope(db, ARTIFACT_ID, finding);

    const result = getAdversaryEnvelope(db, ARTIFACT_ID);
    assert.ok(result);
    assert.equal(result!.finding, finding);
  });
});

test("getAdversaryEnvelope returns null when no adversary finding was ever recorded (FR-013)", () => {
  withWorkspace(() => {
    const db = createFixture();
    assert.equal(getAdversaryEnvelope(db, ARTIFACT_ID), null);
  });
});

test("writeAdversaryEnvelope on one artifact leaves another artifact's envelope untouched", () => {
  withWorkspace(() => {
    const db = createFixture();
    writeAdversaryEnvelope(db, ARTIFACT_ID, "Finding for ProbedThing.");
    assert.equal(getAdversaryEnvelope(db, OTHER_ARTIFACT_ID), null);
  });
});

test("a second adversary finding overwrites the first — only the most recent finding is surfaced", () => {
  withWorkspace(() => {
    const db = createFixture();
    writeAdversaryEnvelope(db, ARTIFACT_ID, "First finding.");
    writeAdversaryEnvelope(db, ARTIFACT_ID, "Second, more recent finding.");

    const result = getAdversaryEnvelope(db, ARTIFACT_ID);
    assert.ok(result);
    assert.equal(result!.finding, "Second, more recent finding.");

    const rows = db
      .prepare("SELECT COUNT(*) AS n FROM agent_context WHERE artifact_id = ? AND agent = ?")
      .get(ARTIFACT_ID, ADVERSARY_ENVELOPE_AGENT) as { n: number };
    assert.equal(rows.n, 1);
  });
});

// ─── Distinguishability from rejection-envelope (T009's data-model non-clobber, T021) ──

test("adversary-envelope and rejection-envelope coexist for the same artifact without clobbering each other (FR-009, T021)", () => {
  withWorkspace((workspaceRoot) => {
    const db = createFixture();
    writeRejectionEnvelope(db, ARTIFACT_ID, "Human rejection reason text.");
    writeAdversaryEnvelope(db, ARTIFACT_ID, "Adversary finding text.");

    const rejection = getContext(db, ARTIFACT_ID, REJECTION_ENVELOPE_AGENT, { workspaceRoot });
    const adversary = getContext(db, ARTIFACT_ID, ADVERSARY_ENVELOPE_AGENT, { workspaceRoot });

    assert.notEqual(rejection.content, adversary.content);
    assert.match(rejection.content ?? "", /Human rejection reason text\./);
    assert.match(adversary.content ?? "", /Adversary finding text\./);

    // Both read back correctly and independently via the thin wrappers too.
    assert.equal(getRejectionEnvelope(db, ARTIFACT_ID)!.reason, "Human rejection reason text.");
    assert.equal(getAdversaryEnvelope(db, ARTIFACT_ID)!.finding, "Adversary finding text.");
  });
});

test("an artifact with neither envelope returns null from both reads (FR-013, T022 baseline)", () => {
  withWorkspace(() => {
    const db = createFixture();
    assert.equal(getRejectionEnvelope(db, ARTIFACT_ID), null);
    assert.equal(getAdversaryEnvelope(db, ARTIFACT_ID), null);
  });
});

// ─── approveArtifactWithEvidence checkpoint routing (US1: T007-T011) ──────

test("US1/T007: below-cutoff artifact with a clean adversary probe reaches reviewed with no envelope row and no new adversary event", () => {
  withWorkspace(() => {
    const gate = createApprovalGateDb();
    const artifactId = seedLowRiskArtifact(gate);
    bindApproveableEvidence(gate, artifactId);

    approveArtifactWithEvidence(gate.db, approveOpts(gate, artifactId, {
      adversaryProbe: { outcome: "clean" },
    }));

    assert.equal(getStatus(gate.db, artifactId), "reviewed");
    assert.equal(getAdversaryEnvelope(gate.db, artifactId), null);
    const events = getEvents(gate.db, artifactId);
    assert.ok(!events.some((e) => e.type.startsWith("adversary-")));
  });
});

test("US1/T008: below-cutoff artifact with a flagged adversary probe reaches needs-rework, not reviewed", () => {
  withWorkspace(() => {
    const gate = createApprovalGateDb();
    const artifactId = seedLowRiskArtifact(gate);
    bindApproveableEvidence(gate, artifactId);
    const finding = "Constructed case: negative quantity bypasses the stock-check guard.";

    approveArtifactWithEvidence(gate.db, approveOpts(gate, artifactId, {
      adversaryProbe: { outcome: "violation", finding },
    }));

    assert.equal(getStatus(gate.db, artifactId), "needs-rework");
    const events = getEvents(gate.db, artifactId, "adversary-flagged");
    assert.equal(events.length, 1);
    const envelope = getAdversaryEnvelope(gate.db, artifactId);
    assert.ok(envelope);
    assert.match(envelope!.finding, /negative quantity/);
  });
});

test("US1/T009: below-cutoff artifact with an inconclusive adversary probe reaches needs-rework with an inconclusive-reason envelope", () => {
  withWorkspace(() => {
    const gate = createApprovalGateDb();
    const artifactId = seedLowRiskArtifact(gate);
    bindApproveableEvidence(gate, artifactId);
    const reason = "Verify command unusable for this stack; probe could not run.";

    approveArtifactWithEvidence(gate.db, approveOpts(gate, artifactId, {
      adversaryProbe: { outcome: "inconclusive", finding: reason },
    }));

    assert.equal(getStatus(gate.db, artifactId), "needs-rework");
    const events = getEvents(gate.db, artifactId, "adversary-inconclusive");
    assert.equal(events.length, 1);
    const envelope = getAdversaryEnvelope(gate.db, artifactId);
    assert.ok(envelope);
    assert.match(envelope!.finding, /could not run/);
  });
});

test("US1/T010: gate-bound artifact with a clean adversary probe still holds at pending-approval, plus a non-evidence adversary-probe-passed event", () => {
  withWorkspace(() => {
    const gate = createApprovalGateDb();
    const artifactId = seedHighRiskArtifact(gate);
    bindApproveableEvidence(gate, artifactId);
    const evidenceCountBefore = listAcceptanceEvidence(gate.db, artifactId).length;

    approveArtifactWithEvidence(gate.db, approveOpts(gate, artifactId, {
      adversaryProbe: { outcome: "clean" },
    }));

    assert.equal(getStatus(gate.db, artifactId), "pending-approval");
    const events = getEvents(gate.db, artifactId, "adversary-probe-passed");
    assert.equal(events.length, 1);
    assert.equal(getAdversaryEnvelope(gate.db, artifactId), null);
    // The signal-only event is not, and cannot be, selectable as acceptance
    // evidence — it lives in a wholly separate table (FR-008b, Constitution I).
    assert.equal(listAcceptanceEvidence(gate.db, artifactId).length, evidenceCountBefore);
  });
});

test("US1/T011: gate-bound artifact with a flagged adversary probe routes to needs-rework instead of pending-approval (FR-006)", () => {
  withWorkspace(() => {
    const gate = createApprovalGateDb();
    const artifactId = seedHighRiskArtifact(gate);
    bindApproveableEvidence(gate, artifactId);
    const finding = "Constructed case: admin-role check is skipped on the bulk-delete path.";

    approveArtifactWithEvidence(gate.db, approveOpts(gate, artifactId, {
      adversaryProbe: { outcome: "violation", finding },
    }));

    assert.equal(getStatus(gate.db, artifactId), "needs-rework");
    assert.notEqual(getStatus(gate.db, artifactId), "pending-approval");
    const flagged = getEvents(gate.db, artifactId, "adversary-flagged");
    assert.equal(flagged.length, 1);
    const gated = getEvents(gate.db, artifactId, "approval-gated");
    assert.equal(gated.length, 0);
  });
});

test("omitting adversaryProbe defaults to a clean probe, preserving pre-feature behavior", () => {
  withWorkspace(() => {
    const gate = createApprovalGateDb();
    const artifactId = seedLowRiskArtifact(gate);
    bindApproveableEvidence(gate, artifactId);

    approveArtifactWithEvidence(gate.db, approveOpts(gate, artifactId));

    assert.equal(getStatus(gate.db, artifactId), "reviewed");
    assert.equal(getAdversaryEnvelope(gate.db, artifactId), null);
  });
});

// ─── Fail-open write / fail-closed routing asymmetry (US3: T027-T028) ─────

test("US3/T027: writeAdversaryEnvelope failing does not prevent the needs-rework transition or the adversary-flagged event", () => {
  withWorkspace((workspaceRoot) => {
    const gate = createApprovalGateDb();
    const artifactId = seedLowRiskArtifact(gate);
    bindApproveableEvidence(gate, artifactId);

    // Force writeAdversaryEnvelope's fs.mkdirSync("migration/artifacts/.../context")
    // to fail with a real filesystem error: "migration" already exists as a
    // plain file, not a directory, so mkdirSync(..., { recursive: true }) throws
    // ENOTDIR — mirrors approval-rejection-envelope.test.ts's equivalent case.
    fs.writeFileSync(path.join(workspaceRoot, "migration"), "not a directory", "utf-8");

    const finding = "Constructed case that should still route to needs-rework despite the write failing.";
    const decision = approveArtifactWithEvidence(gate.db, approveOpts(gate, artifactId, {
      adversaryProbe: { outcome: "violation", finding },
    }));

    assert.equal(decision.decision, "approved"); // arbitration verdict recorded either way
    assert.equal(getStatus(gate.db, artifactId), "needs-rework");
    const events = getEvents(gate.db, artifactId, "adversary-flagged");
    assert.equal(events.length, 1);

    // The best-effort relay simply didn't land — no error was raised, and no
    // envelope is readable.
    assert.equal(getAdversaryEnvelope(gate.db, artifactId), null);
  });
});

test("US3/T028: after a write failure, the event record alone still identifies the adversary-agent origin", () => {
  withWorkspace((workspaceRoot) => {
    const gate = createApprovalGateDb();
    const artifactId = seedLowRiskArtifact(gate);
    bindApproveableEvidence(gate, artifactId);

    fs.writeFileSync(path.join(workspaceRoot, "migration"), "not a directory", "utf-8");

    approveArtifactWithEvidence(gate.db, approveOpts(gate, artifactId, {
      adversaryProbe: { outcome: "inconclusive", finding: "Probe could not run for this stack." },
    }));

    // Purely from the event record, independent of whether get-context resolves.
    const events = getEvents(gate.db, artifactId, "adversary-inconclusive");
    assert.equal(events.length, 1);
    assert.match(events[0].summary, /needs-rework/);
    assert.equal(getAdversaryEnvelope(gate.db, artifactId), null);
    assert.equal(getStatus(gate.db, artifactId), "needs-rework");
  });
});
