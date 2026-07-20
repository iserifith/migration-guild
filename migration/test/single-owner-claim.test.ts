import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import {
  claimArtifactById,
  claimNextTask,
  releaseClaim,
  reconcileStaleClaims,
  releaseClaimRecord,
} from "../registry/commands/claim";
import {
  registerArtifact,
  setArtifactStatus,
  setArtifactWave,
} from "../registry/commands/artifacts";
import { startRun } from "../registry/commands/runs";
import { applySchema } from "../registry/db/schema";
import { deriveExpectedOutputPaths } from "../registry/commands/claim";

const REGISTRY_CLI = path.resolve(__dirname, "../registry/cli.ts");
const PROJECT_ROOT = path.resolve(__dirname, "..");

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function registerPlanned(db: Database.Database, id: string, legacyPath?: string): void {
  registerArtifact(db, {
    id,
    kind: "legacy-source",
    tier: "first-class",
    path: legacyPath ?? `legacy/src/main/java/${id.replaceAll(":", "/")}.java`,
  });
  setArtifactWave(db, id, 1);
  setArtifactStatus(db, id, "planned");
}

test("TASK-05: conflicting claim by a different owner is rejected (names the owner)", () => {
  const db = createDb();
  const id = "legacy-source:com.acme:Service";
  startRun(db, { runId: "run-1", agent: "analyze-agent", ownerId: "owner-A" });
  registerPlanned(db, id);

  const first = claimArtifactById(db, {
    artifactId: id,
    agent: "analyze-agent",
    ownerId: "owner-A",
    runId: "run-1",
  });
  assert.equal(first.claim_owner_id, "owner-A");

  assert.throws(
    () =>
      claimArtifactById(db, {
        artifactId: id,
        agent: "analyze-agent",
        ownerId: "owner-B",
      }),
    /owner-B|different owner/i,
  );

  const active = db
    .prepare(
      "SELECT COUNT(*) AS n, owner_id FROM artifact_claims WHERE state='active' AND artifact_id=? GROUP BY owner_id",
    )
    .get(id) as { n: number; owner_id: string };
  assert.equal(active.n, 1);
  assert.equal(active.owner_id, "owner-A");
});

test("TASK-05: re-claim by the same owner is idempotent (no duplicate rows)", () => {
  const db = createDb();
  const id = "legacy-source:com.acme:Service2";
  startRun(db, { runId: "run-2", agent: "analyze-agent", ownerId: "owner-A" });
  registerPlanned(db, id);

  const a = claimArtifactById(db, { artifactId: id, agent: "analyze-agent", ownerId: "owner-A", runId: "run-2" });
  const b = claimArtifactById(db, { artifactId: id, agent: "analyze-agent", ownerId: "owner-A", runId: "run-2" });

  assert.equal(a.claim_id, b.claim_id, "same claim id on re-claim");
  const rows = db.prepare("SELECT COUNT(*) AS n FROM artifact_claims WHERE artifact_id=?").get(id) as { n: number };
  assert.equal(rows.n, 1);
});

test("TASK-05: env-var binding — bare claim, matching claim, mismatched claim", () => {
  const db = createDb();
  const A = "legacy-source:com.acme:A";
  const B = "legacy-source:com.acme:B";
  startRun(db, { runId: "run-3", agent: "analyze-agent", ownerId: "owner-A" });
  registerPlanned(db, A);
  registerPlanned(db, B);

  const bare = claimArtifactById(db, {
    agent: "analyze-agent",
    ownerId: "owner-A",
    runId: "run-3",
    envArtifactId: A,
  });
  assert.equal(bare.id, A);

  const matching = claimArtifactById(db, {
    artifactId: A,
    agent: "analyze-agent",
    ownerId: "owner-A",
    runId: "run-3",
    envArtifactId: A,
  });
  assert.equal(matching.id, A);

  assert.throws(
    () =>
      claimArtifactById(db, {
        artifactId: B,
        agent: "analyze-agent",
        ownerId: "owner-A",
        runId: "run-3",
        envArtifactId: A,
      }),
    /assigned artifact|GUILDCTL_ARTIFACT_ID/i,
  );
});

test("TASK-05: owner-only release; --force override", () => {
  const db = createDb();
  const id = "legacy-source:com.acme:Service3";
  startRun(db, { runId: "run-4", agent: "analyze-agent", ownerId: "owner-A" });
  registerPlanned(db, id);

  const claim = claimArtifactById(db, { artifactId: id, agent: "analyze-agent", ownerId: "owner-A", runId: "run-4" });

  assert.throws(
    () => releaseClaim(db, claim.claim_id, "not-the-real-token", "someone-else"),
    /token mismatch/i,
  );

  const released = releaseClaim(db, claim.claim_id, claim.claim_token, "owner-A");
  assert.equal(released.status, "planned");

  const id2 = "legacy-source:com.acme:Service3b";
  registerPlanned(db, id2);
  const claim2 = claimArtifactById(db, { artifactId: id2, agent: "analyze-agent", ownerId: "owner-A", runId: "run-4" });
  const forced = releaseClaim(db, claim2.claim_id, "wrong-token", "operator", true);
  assert.equal(forced.status, "planned");
});

test("TASK-05: reap releases only claims older than the threshold", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "guild-reap-"));
  const dbPath = path.join(tmp, "registry.db");
  const db = new Database(dbPath);
  applySchema(db);
  const old = "legacy-source:com.acme:Old";
  const fresh = "legacy-source:com.acme:Fresh";
  startRun(db, { runId: "run-5-old", agent: "analyze-agent", ownerId: "owner-A" });
  startRun(db, { runId: "run-5-fresh", agent: "analyze-agent", ownerId: "owner-A" });
  registerPlanned(db, old);
  registerPlanned(db, fresh);

  const oldClaim = claimArtifactById(db, { artifactId: old, agent: "analyze-agent", ownerId: "owner-A", runId: "run-5-old" });
  claimArtifactById(db, { artifactId: fresh, agent: "analyze-agent", ownerId: "owner-A", runId: "run-5-fresh" });
  db.prepare("UPDATE artifact_claims SET claimed_at = datetime('now', '-120 minutes') WHERE claim_id = ?").run(oldClaim.claim_id);

  const before = db.prepare("SELECT COUNT(*) AS n FROM artifact_claims WHERE state='active'").get() as { n: number };
  assert.equal(before.n, 2);

  const stale = db
    .prepare("SELECT claim_id FROM artifact_claims WHERE state='active' AND (julianday('now') - julianday(claimed_at))*1440 >= 60")
    .all() as { claim_id: string }[];
  for (const r of stale) releaseClaim(db, r.claim_id, "x", "guildctl", true, "reaped");

  const afterOld = db.prepare("SELECT COUNT(*) AS n FROM artifact_claims WHERE state='active' AND artifact_id=?").get(old) as { n: number };
  assert.equal(afterOld.n, 0, "old claim reaped");
  const afterFresh = db.prepare("SELECT COUNT(*) AS n FROM artifact_claims WHERE state='active' AND artifact_id=?").get(fresh) as { n: number };
  assert.equal(afterFresh.n, 1, "fresh claim survives");
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("TASK-05: concurrency smoke — two processes race to claim the same artifact → exactly one wins", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "guild-claim-"));
  const dbPath = path.join(tmp, "registry.db");
  // Seed the registry on disk (mirrors what init does).
  const seed = new Database(dbPath);
  applySchema(seed);
  startRun(seed, { runId: "run-6", agent: "analyze-agent", ownerId: "owner-A" });
  registerPlanned(seed, "legacy-source:com.acme:Race", "legacy/com/acme/Race.java");
  seed.close();

  const env = { ...process.env, REGISTRY_DB: dbPath };
  const cliPrefix = ["--import", "tsx", REGISTRY_CLI];
  const p1 = spawnSync(process.execPath, [...cliPrefix, "claim", "--id", "legacy-source:com.acme:Race", "--agent", "a1", "--owner", "owner-A", "--run-id", "run-6"], { cwd: PROJECT_ROOT, env, encoding: "utf8" });
  const p2 = spawnSync(process.execPath, [...cliPrefix, "claim", "--id", "legacy-source:com.acme:Race", "--agent", "a2", "--owner", "owner-B", "--run-id", "run-6"], { cwd: PROJECT_ROOT, env, encoding: "utf8" });

  const okCount = [p1, p2].filter((p) => p.status === 0).length;
  const errCount = [p1, p2].filter((p) => p.status !== 0 && p.status !== 2).length;
  assert.ok(okCount === 1, `expected exactly one winner, got ${okCount} (p1=${p1.status} p2=${p2.status})`);
  assert.ok(errCount === 1, `expected the loser to fail cleanly, got ${errCount} errors`);
  for (const p of [p1, p2]) {
    if (p.status !== 0 && p.status !== 2) {
      assert.ok(!/SQLITE_BUSY|database is locked/i.test(p.stderr ?? ""), "loser must not crash with SQLITE_BUSY");
    }
  }

  const verify = new Database(dbPath);
  const rows = verify.prepare("SELECT COUNT(*) AS n FROM artifact_claims WHERE state='active' AND artifact_id=?").get("legacy-source:com.acme:Race") as { n: number };
  assert.equal(rows.n, 1, "exactly one active claim for the raced artifact");
  verify.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("TASK-05: serial run leaves zero active claims after worker completion", () => {
  const db = createDb();
  const id = "legacy-source:com.acme:Service5";
  startRun(db, { runId: "run-8", agent: "analyze-agent", ownerId: "owner-A" });
  registerPlanned(db, id);

  const claim = claimArtifactById(db, { artifactId: id, agent: "analyze-agent", ownerId: "owner-A", runId: "run-8" });
  // The runner releases the claim on worker exit; releasing returns the artifact
  // to its pre-claim status (no dangling claim).
  releaseClaim(db, claim.claim_id, claim.claim_token, "owner-A");
  const active = db.prepare("SELECT COUNT(*) AS n FROM artifact_claims WHERE state='active'").get() as { n: number };
  assert.equal(active.n, 0);
});
test("TASK-05: deriveExpectedOutputPaths mirrors legacy/ to modern/", () => {
  assert.deepEqual(deriveExpectedOutputPaths({ path: "legacy/a/b/C.java" } as any), ["modern/a/b/C.java"]);
  assert.deepEqual(
    deriveExpectedOutputPaths({ path: "legacy/jforum2-source/src/net/jforum/ForumSessionListener.java" } as any),
    [
      "modern/src/main/java/net/jforum/ForumSessionListener.java",
      "modern/src/test/java/net/jforum/ForumSessionListenerTest.java",
    ],
  );
  assert.deepEqual(
    deriveExpectedOutputPaths({ path: "legacy/jforum2-source/tests/core/net/jforum/http/FakeHttpResponse.java" } as any),
    [
      "modern/src/main/java/net/jforum/http/FakeHttpResponse.java",
      "modern/src/test/java/net/jforum/http/FakeHttpResponse.java",
      "modern/src/test/java/net/jforum/http/FakeHttpResponseTest.java",
    ],
  );
  assert.deepEqual(deriveExpectedOutputPaths({ path: "src/main/C.java" } as any), []);
});

void claimNextTask;
void reconcileStaleClaims;
void releaseClaimRecord;
