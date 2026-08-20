import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { runAuto } from "../guildctl/supervisor/loop";
import {
  enforceWardenSnapshot,
  snapshotWorkspaceForWardenWithExclusions,
} from "../guildctl/warden";
import { registerArtifact, setArtifactStatus, setArtifactWave } from "../registry/commands/artifacts";
import { claimArtifactById } from "../registry/commands/claim";
import { applySchema } from "../registry/db/schema";

// US4 (#156): if the warden reverts an artifact's OWN claimed-path output
// mid-migrate, that artifact must never be left recorded as `migrated`. The
// supervisor already blocks on warden violations it detects during a run, but
// issue #156 describes the case where that branch is not reached — the
// artifact's own output was part of what the warden restored, yet `migrated`
// was still persisted. The gate must check the claim's `expected_output_paths`
// for any warden restore and redirect to a failed/needs-redelivery state.

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function seedPlanned(db: Database.Database, name: string): string {
  const id = `legacy-source:com.acme:${name}`;
  registerArtifact(db, { id, kind: "legacy-source", tier: "first-class", path: `legacy/${name}.java` });
  setArtifactWave(db, id, 1);
  setArtifactStatus(db, id, "planned");
  return id;
}

test("US4: a warden restore that touches an artifact's own claimed output never leaves it migrated", async () => {
  const db = createDb();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "guild-us4-warden-revert-"));
  try {
    fs.mkdirSync(path.join(workspace, "legacy"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "legacy", "WardenRevert.java"), "class WardenRevert {}\n");
    const id = seedPlanned(db, "WardenRevert");

    await runAuto(db, {
      artifactId: id,
      workspaceRoot: workspace,
      commands: ["node --check modern/WardenRevert.js"],
      worker: async ({ claim }) => {
        const ownOutput = (JSON.parse(claim.expected_output_paths ?? "[]") as string[])[0];
        assert.ok(ownOutput, "claim must carry an expected output path");
        const absOutput = path.join(workspace, ownOutput);
        fs.mkdirSync(path.dirname(absOutput), { recursive: true });

        // Simulate the #156 case: the migrate worker produced its output, then
        // the warden reverted that very path (restoring the snapshot's prior
        // state, here "no file"). The workspace no longer holds the produced
        // output after enforcement.
        fs.writeFileSync(absOutput, "function ok() { return 1; }\n");
        const snapshotAfterWrite = snapshotWorkspaceForWardenWithExclusions(workspace, []);
        fs.rmSync(absOutput, { force: true });
        const warden = enforceWardenSnapshot(db, {
          artifactId: id,
          workspaceRoot: workspace,
          snapshot: snapshotAfterWrite,
          allowedPaths: [],          // fail closed: the artifact's own output is NOT allowed
          excludedPaths: [],
          agent: "guildctl-warden",
          claimId: claim.claim_id,
          runId: claim.claim_run_id ?? undefined,
        });
        assert.ok(!warden.clean, "warden must report the restored own-output as a violation");

        // The buggy supervisor would now persist `migrated` even though the
        // artifact's own output was reverted. The fix must prevent this write.
        setArtifactStatus(db, claim.id, "migrated", {
          agent: "code-writer-agent",
          claimId: claim.claim_id,
          claimToken: claim.claim_token,
        });
      },
      verify: async () => ({ pass: true, evidence: [] }),
      review: async () => ({
        approved: true,
        reason: "should be irrelevant — the artifact must not reach a clean migrated approval",
        reviewerAgent: "review-agent",
        reviewerModel: "review-model",
      }),
    });

    const row = db.prepare("SELECT status FROM artifacts WHERE id = ?").get(id) as { status: string };
    assert.notEqual(
      row.status,
      "migrated",
      `an artifact whose own claimed output was warden-reverted must not be recorded as migrated; got ${row.status}`,
    );
    assert.equal(row.status, "blocked", "the warden-reverted artifact routes to the existing failed path");
  } finally {
    db.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

// US4 (#156) / T018: positive control — the gate may only fire on an actual
// own-output restore, never on a legitimate migrate. A claim whose warden
// recorded NO filesystem-violation for its own output must persist `migrated`
// without throwing.
test("US4: the migrated gate does not fire when the warden never reverted an own-output", () => {
  const db = createDb();
  try {
    const id = seedPlanned(db, "CleanMigrate");
    db.prepare("INSERT INTO runs (run_id, agent, owner_id, status) VALUES ('run-us4-clean', 'guildctl-auto', 'guildctl', 'running')").run();
    const claim = claimArtifactById(db, {
      artifactId: id,
      agent: "code-writer-agent",
      ownerId: "guildctl-auto:clean",
      runId: "run-us4-clean",
      fromStatus: "planned",
    });

    // A clean migrate: the warden recorded no filesystem-violation touching
    // the claim's own output, so this must succeed (the gate stays silent).
    setArtifactStatus(db, id, "migrated", {
      agent: "code-writer-agent",
      claimId: claim.claim_id,
      claimToken: claim.claim_token,
    });

    const row = db.prepare("SELECT status FROM artifacts WHERE id = ?").get(id) as { status: string };
    assert.equal(row.status, "migrated", "a clean migrate must persist migrated");
  } finally {
    db.close();
  }
});
