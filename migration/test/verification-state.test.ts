import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { formatVerificationCloseOut } from "../guildctl/verify";
import { registerArtifact, setArtifactStatus } from "../registry/commands/artifacts";
import { createRunOperatorCredential } from "../registry/commands/claim";
import {
  getVerification,
  listVerification,
  resetVerification,
  setVerification,
} from "../registry/commands/verification";
import { applySchema } from "../registry/db/schema";
import { RegistryError, VERIFICATION_REASONS } from "../registry/types";

/**
 * US1 (FR-001, FR-002, FR-007, FR-009): verification is a recorded fact
 * distinct from migration status, and it is triage input only.
 */

const ARTIFACT_ID = "legacy-source:com.acme:VerifiedThing";
const SECRET = "sk-live-verification-secret-01234567";

interface Fixture { db: Database.Database; runId: string; operatorToken: string }

function createFixture(): Fixture {
  const db = new Database(":memory:");
  applySchema(db);
  registerArtifact(db, {
    id: ARTIFACT_ID,
    kind: "legacy-source",
    tier: "first-class",
    path: "legacy/src/main/java/com/acme/VerifiedThing.java",
  });
  const runId = "run-verification-0001";
  db.prepare("INSERT INTO runs (run_id, agent, owner_id, status) VALUES (?, 'code-writer-agent', 'guildctl', 'running')").run(runId);
  const operatorToken = createRunOperatorCredential(db, runId).token;
  return { db, runId, operatorToken };
}

function auth(fixture: Fixture): { runId: string; operatorToken: string } {
  return { runId: fixture.runId, operatorToken: fixture.operatorToken };
}

test("all three verification states are recordable and read back", () => {
  const fixture = createFixture();
  try {
    for (const [state, reason] of [
      ["unverified", "no-stack-check"],
      ["verification-failed", "check-failed"],
    ] as const) {
      setVerification(fixture.db, {
        artifactId: ARTIFACT_ID,
        state,
        method: "java-per-artifact",
        reason,
        ...auth(fixture),
      });
      const record = getVerification(fixture.db, ARTIFACT_ID);
      assert.equal(record.state, state);
      assert.equal(record.reason, reason);
    }

    setVerification(fixture.db, {
      artifactId: ARTIFACT_ID,
      state: "verified",
      method: "java-per-artifact",
      durationMs: 1200,
      scope: ["modern/src/main/java/com/acme/VerifiedThing.java"],
      ...auth(fixture),
    });
    assert.equal(getVerification(fixture.db, ARTIFACT_ID).state, "verified");
  } finally {
    fixture.db.close();
  }
});

test("reason is required, non-empty, and drawn from the closed vocabulary whenever state is not verified", () => {
  const fixture = createFixture();
  try {
    for (const bad of [undefined, "", "   "]) {
      assert.throws(
        () => setVerification(fixture.db, {
          artifactId: ARTIFACT_ID,
          state: "unverified",
          method: "java-per-artifact",
          reason: bad as never,
          ...auth(fixture),
        }),
        RegistryError,
        `reason ${JSON.stringify(bad)} must be rejected`,
      );
    }

    assert.throws(
      () => setVerification(fixture.db, {
        artifactId: ARTIFACT_ID,
        state: "verification-failed",
        method: "java-per-artifact",
        reason: "looks-plausible-but-invented" as never,
        ...auth(fixture),
      }),
      /vocabulary|reason/i,
    );

    // Every vocabulary value is accepted for a non-verified state.
    for (const reason of VERIFICATION_REASONS) {
      setVerification(fixture.db, {
        artifactId: ARTIFACT_ID,
        state: reason === "check-failed" || reason === "check-error" ? "verification-failed" : "unverified",
        method: "java-per-artifact",
        reason,
        ...auth(fixture),
      });
      assert.equal(getVerification(fixture.db, ARTIFACT_ID).reason, reason);
    }
  } finally {
    fixture.db.close();
  }
});

test("a verified record must be able to say what it covered and how long it took", () => {
  const fixture = createFixture();
  try {
    assert.throws(
      () => setVerification(fixture.db, {
        artifactId: ARTIFACT_ID,
        state: "verified",
        method: "java-per-artifact",
        scope: ["modern/Thing.java"],
        ...auth(fixture),
      }),
      /duration/i,
      "verified without duration_ms must be rejected",
    );
    assert.throws(
      () => setVerification(fixture.db, {
        artifactId: ARTIFACT_ID,
        state: "verified",
        method: "java-per-artifact",
        durationMs: 900,
        scope: [],
        ...auth(fixture),
      }),
      /scope/i,
      "verified with an empty scope must be rejected",
    );
  } finally {
    fixture.db.close();
  }
});

test("an artifact with no verification attempt reads as unverified/not-attempted/none, never blank", () => {
  const fixture = createFixture();
  try {
    const record = getVerification(fixture.db, ARTIFACT_ID);
    assert.equal(record.state, "unverified");
    assert.equal(record.reason, "not-attempted");
    assert.equal(record.method, "none");
    assert.equal(record.determined_at, null);
    assert.equal(record.duration_ms, null);

    // The read-model is a LEFT JOIN, so no historical row is touched to make
    // this true.
    assert.equal(
      fixture.db.prepare("SELECT COUNT(*) FROM artifact_verifications").pluck().get(),
      0,
    );

    assert.throws(() => getVerification(fixture.db, "legacy-source:com.acme:Missing"), RegistryError);
  } finally {
    fixture.db.close();
  }
});

test("writes are last-write-wins per artifact and each one appends an events audit row", () => {
  const fixture = createFixture();
  try {
    setVerification(fixture.db, {
      artifactId: ARTIFACT_ID,
      state: "verification-failed",
      method: "java-per-artifact",
      reason: "check-failed",
      ...auth(fixture),
    });
    setVerification(fixture.db, {
      artifactId: ARTIFACT_ID,
      state: "verified",
      method: "java-per-artifact",
      durationMs: 42,
      scope: ["modern/Thing.java"],
      ...auth(fixture),
    });

    assert.equal(fixture.db.prepare("SELECT COUNT(*) FROM artifact_verifications").pluck().get(), 1);
    assert.equal(getVerification(fixture.db, ARTIFACT_ID).state, "verified");

    const auditRows = fixture.db.prepare(
      "SELECT summary FROM events WHERE artifact_id = ? AND summary LIKE '%erification%' ORDER BY rowid",
    ).pluck().all(ARTIFACT_ID) as string[];
    assert.equal(auditRows.length, 2, "history lives in events, not in the verification table");
  } finally {
    fixture.db.close();
  }
});

test("detail is redacted before it is persisted", () => {
  const fixture = createFixture();
  const previous = process.env["ROOTSYS_API_KEY"];
  process.env["ROOTSYS_API_KEY"] = SECRET;
  try {
    setVerification(fixture.db, {
      artifactId: ARTIFACT_ID,
      state: "verification-failed",
      method: "java-per-artifact",
      reason: "check-error",
      detail: `command failed while using ${SECRET} as the key`,
      ...auth(fixture),
    });

    const stored = getVerification(fixture.db, ARTIFACT_ID);
    assert.equal(String(stored.detail).includes(SECRET), false);
    assert.match(String(stored.detail), /<redacted>/);
  } finally {
    if (previous === undefined) delete process.env["ROOTSYS_API_KEY"];
    else process.env["ROOTSYS_API_KEY"] = previous;
    fixture.db.close();
  }
});

test("verification resets when the artifact re-enters in-progress or needs-rework", () => {
  for (const status of ["in-progress", "needs-rework"] as const) {
    const fixture = createFixture();
    try {
      setVerification(fixture.db, {
        artifactId: ARTIFACT_ID,
        state: "verified",
        method: "java-per-artifact",
        durationMs: 900,
        scope: ["modern/Thing.java"],
        ...auth(fixture),
      });
      assert.equal(getVerification(fixture.db, ARTIFACT_ID).state, "verified");

      setArtifactStatus(fixture.db, ARTIFACT_ID, status, { agent: "guildctl", reason: "rework" });

      const record = getVerification(fixture.db, ARTIFACT_ID);
      assert.equal(record.state, "unverified", `${status} must invalidate a stale verification`);
      assert.equal(record.reason, "not-attempted");
    } finally {
      fixture.db.close();
    }
  }
});

test("resetVerification is idempotent and safe on an artifact that was never verified", () => {
  const fixture = createFixture();
  try {
    resetVerification(fixture.db, ARTIFACT_ID);
    resetVerification(fixture.db, ARTIFACT_ID);
    const record = getVerification(fixture.db, ARTIFACT_ID);
    assert.equal(record.state, "unverified");
    assert.equal(record.reason, "not-attempted");
  } finally {
    fixture.db.close();
  }
});

test("setVerification never touches artifact status, evidence, or arbitration", () => {
  const fixture = createFixture();
  try {
    setArtifactStatus(fixture.db, ARTIFACT_ID, "migrated", { agent: "code-writer-agent" });
    setVerification(fixture.db, {
      artifactId: ARTIFACT_ID,
      state: "verified",
      method: "java-per-artifact",
      durationMs: 500,
      scope: ["modern/Thing.java"],
      ...auth(fixture),
    });

    const artifact = fixture.db.prepare("SELECT status FROM artifacts WHERE id = ?").get(ARTIFACT_ID) as { status: string };
    assert.equal(artifact.status, "migrated", "verification must not advance status");
    assert.equal(fixture.db.prepare("SELECT COUNT(*) FROM acceptance_evidence").pluck().get(), 0);
    assert.equal(fixture.db.prepare("SELECT COUNT(*) FROM arbitration_decisions").pluck().get(), 0);
  } finally {
    fixture.db.close();
  }
});

test("recording verification requires a claim token or run operator credential, not a privileged-looking name", () => {
  const fixture = createFixture();
  try {
    assert.throws(
      () => setVerification(fixture.db, {
        artifactId: ARTIFACT_ID,
        state: "verified",
        method: "java-per-artifact",
        durationMs: 10,
        scope: ["modern/Thing.java"],
        actor: "guildctl-operator-root",
      } as never),
      /claim token|operator credential/i,
    );
    assert.throws(
      () => setVerification(fixture.db, {
        artifactId: ARTIFACT_ID,
        state: "unverified",
        method: "none",
        reason: "not-attempted",
        runId: fixture.runId,
        operatorToken: "not-the-real-token",
      }),
      /claim token|operator credential/i,
    );
  } finally {
    fixture.db.close();
  }
});

test("listVerification returns the three-state split plus a total, and lists one state on demand", () => {
  const fixture = createFixture();
  try {
    for (const [index, state] of ["verified", "unverified", "verification-failed", "unverified"].entries()) {
      const id = `legacy-source:com.acme:Thing${index}`;
      registerArtifact(fixture.db, { id, kind: "legacy-source", tier: "first-class", path: `legacy/Thing${index}.java` });
      setVerification(fixture.db, {
        artifactId: id,
        state: state as never,
        method: "java-per-artifact",
        reason: state === "verified" ? undefined : state === "unverified" ? "tree-incomplete" : "check-failed",
        durationMs: state === "verified" ? 10 : undefined,
        scope: state === "verified" ? [`modern/Thing${index}.java`] : undefined,
        ...auth(fixture),
      });
    }

    const all = listVerification(fixture.db, {});
    // The registered-but-unrecorded fixture artifact coalesces into unverified.
    assert.equal(all.counts.verified, 1);
    assert.equal(all.counts["verification-failed"], 1);
    assert.equal(all.counts.unverified, 3);
    assert.equal(all.counts.total, 5);

    const failed = listVerification(fixture.db, { state: "verification-failed" });
    assert.equal(failed.artifacts.length, 1);
    assert.equal(failed.artifacts[0].state, "verification-failed");
    assert.equal(failed.artifacts[0].reason, "check-failed");
    assert.ok(failed.artifacts[0].path);

    const byReason = listVerification(fixture.db, { reason: "tree-incomplete" });
    assert.equal(byReason.artifacts.length, 2);
  } finally {
    fixture.db.close();
  }
});

test("the close-out summary states verification state, method, and reason separately from migration status", () => {
  const unverified = formatVerificationCloseOut({
    artifact_id: ARTIFACT_ID,
    state: "unverified",
    method: "java-per-artifact",
    reason: "tree-incomplete",
    detail: null,
    scope_json: null,
    budget_ms: 120000,
    duration_ms: null,
    run_id: null,
    determined_at: "2026-08-01 00:00:00",
  });
  assert.match(unverified, /unverified/);
  assert.match(unverified, /tree-incomplete/);
  assert.match(unverified, /java-per-artifact/);
  // Migration status is a separate line; verification must not restate it.
  assert.equal(/migrated|status/i.test(unverified), false);

  const verified = formatVerificationCloseOut({
    artifact_id: ARTIFACT_ID,
    state: "verified",
    method: "java-per-artifact",
    reason: null,
    detail: null,
    scope_json: JSON.stringify(["modern/Thing.java"]),
    budget_ms: 120000,
    duration_ms: 812,
    run_id: null,
    determined_at: "2026-08-01 00:00:00",
  });
  assert.match(verified, /verified/);
  assert.match(verified, /java-per-artifact/);
});
