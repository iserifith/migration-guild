import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { spawnCopilot } from "../legmod/runner";
import { startRun, reapDeadRuns } from "../registry/commands/runs";
import { applySchema } from "../registry/db/schema";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

test("reapDeadRuns marks a missing pid as failed", () => {
  const db = createDb();

  try {
    const run = startRun(db, { agent: "review-agent", model: "test-model", pid: 999999 });
    const reaped = reapDeadRuns(db, "review-agent");
    const stored = db.prepare(
      "SELECT status, exit_code, finished_at FROM runs WHERE run_id = ?",
    ).get(run.run_id) as { status: string; exit_code: number; finished_at: string | null };

    assert.equal(reaped.length, 1);
    assert.equal(stored.status, "failed");
    assert.equal(stored.exit_code, 1);
    assert.notEqual(stored.finished_at, null);
  } finally {
    db.close();
  }
});

test("spawnCopilot records failed stub runs and writes a log file", async () => {
  const db = createDb();
  const workDir = mkdtempSync(path.join(tmpdir(), "legmod-runner-"));
  const stubPath = path.join(workDir, "fake-copilot.sh");
  const original = process.env["COPILOT_CMD"];

  try {
    writeFileSync(stubPath, "#!/bin/sh\necho simulated runner failure >&2\nexit 1\n", {
      mode: 0o755,
    });
    process.env["COPILOT_CMD"] = stubPath;

    const result = await spawnCopilot({
      agent: "review-agent",
      model: "test-model",
      prompt: "small task",
      db,
      logDir: workDir,
    });
    const stored = db.prepare(
      "SELECT status, exit_code, log_file FROM runs WHERE run_id = ?",
    ).get(result.runId) as { status: string; exit_code: number; log_file: string | null };

    assert.equal(result.exitCode, 1);
    assert.equal(stored.status, "failed");
    assert.equal(stored.exit_code, 1);
    assert.ok(stored.log_file);
    assert.match(readFileSync(stored.log_file, "utf8"), /simulated runner failure/);
  } finally {
    if (original == null) {
      delete process.env["COPILOT_CMD"];
    } else {
      process.env["COPILOT_CMD"] = original;
    }
    rmSync(workDir, { recursive: true, force: true });
    db.close();
  }
});
