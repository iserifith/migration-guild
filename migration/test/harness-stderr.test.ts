import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { spawnAgent, summarizeRunFailures, HARNESS_OUTPUT_CAP } from "../guildctl/runner";
import { applySchema } from "../registry/db/schema";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

// US5 (#121): a harness CLI that writes to stderr and exits non-zero must have
// its captured output surfaced verbatim (capped) in the failure message, along
// with the harness name and exit code — no provider/harness-specific branching.
test("spawnAgent surfaces the harness stderr verbatim in the failure summary", async () => {
  const db = createDb();
  const workDir = mkdtempSync(path.join(tmpdir(), "guildctl-harness-stderr-"));
  const stubPath = path.join(workDir, "fake-agent.sh");
  const original = process.env["AGENT_CMD"];
  const stderrText = "openai.NotFoundError: The model 'gpt-zzz' does not exist";

  try {
    writeFileSync(stubPath, `#!/bin/sh
echo "${stderrText}" >&2
exit 7
`, { mode: 0o755 });
    process.env["AGENT_CMD"] = stubPath;

    const result = await spawnAgent({
      agent: "code-writer-agent",
      model: "test-model",
      prompt: "small task",
      db,
      logDir: workDir,
    });

    assert.equal(result.exitCode, 7);
    assert.ok(result.capturedOutput, "stderr should be captured");
    assert.match(result.capturedOutput!, new RegExp(stderrText));
    assert.ok(result.harness, "harness name should be recorded");

    const summary = summarizeRunFailures([result]);
    assert.ok(summary, "summary should be non-null for a failed run");
    assert.match(summary!, new RegExp(stderrText));
    assert.match(summary!, new RegExp(result.harness!));
    assert.match(summary!, /exit=7/);
    // The captured block must include the harness name + exit code inline.
    assert.match(summary!, new RegExp(`${result.harness} \\(exit 7\\)`));
  } finally {
    if (original == null) delete process.env["AGENT_CMD"];
    else process.env["AGENT_CMD"] = original;
    rmSync(workDir, { recursive: true, force: true });
    db.close();
  }
});

// The cap protects the message from an unbounded/blanket stderr flood.
test("captured harness output is capped at HARNESS_OUTPUT_CAP in the summary", async () => {
  const db = createDb();
  const workDir = mkdtempSync(path.join(tmpdir(), "guildctl-harness-stderr-cap-"));
  const stubPath = path.join(workDir, "fake-agent.sh");
  const original = process.env["AGENT_CMD"];

  try {
    const longLine = "x".repeat(HARNESS_OUTPUT_CAP) + "UNIQUE_TAIL_MARKER_12345";
    writeFileSync(stubPath, `#!/bin/sh
echo "${longLine}" >&2
exit 3
`, { mode: 0o755 });
    process.env["AGENT_CMD"] = stubPath;

    const result = await spawnAgent({
      agent: "code-writer-agent",
      model: "test-model",
      prompt: "small task",
      db,
      logDir: workDir,
    });

    assert.equal(result.exitCode, 3);
    // The raw capture is uncapped, but summarizeRunFailures surfaces only the
    // first HARNESS_OUTPUT_CAP characters (verbatim, unchanged).
    assert.ok(result.capturedOutput!.length >= HARNESS_OUTPUT_CAP);
    const summary = summarizeRunFailures([result]);
    assert.ok(summary);
    const surfaced = result.capturedOutput!.slice(0, HARNESS_OUTPUT_CAP);
    assert.match(summary!, new RegExp(surfaced.slice(0, 64)));
    // The tail beyond the cap must NOT appear in the summary.
    const tail = result.capturedOutput!.slice(HARNESS_OUTPUT_CAP);
    assert.ok(tail.includes("UNIQUE_TAIL_MARKER_12345"));
    assert.doesNotMatch(summary!, /UNIQUE_TAIL_MARKER_12345/);
  } finally {
    if (original == null) delete process.env["AGENT_CMD"];
    else process.env["AGENT_CMD"] = original;
    rmSync(workDir, { recursive: true, force: true });
    db.close();
  }
});

// A working harness (exit 0, empty stderr) must be left untouched.
test("a clean exit-0 harness yields no captured output and no failure summary", async () => {
  const db = createDb();
  const workDir = mkdtempSync(path.join(tmpdir(), "guildctl-harness-clean-"));
  const stubPath = path.join(workDir, "fake-agent.sh");
  const original = process.env["AGENT_CMD"];

  try {
    writeFileSync(stubPath, `#!/bin/sh
exit 0
`, { mode: 0o755 });
    process.env["AGENT_CMD"] = stubPath;

    const result = await spawnAgent({
      agent: "code-writer-agent",
      model: "test-model",
      prompt: "small task",
      db,
      logDir: workDir,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.capturedOutput ?? "", "");
    assert.equal(summarizeRunFailures([result]), null);
  } finally {
    if (original == null) delete process.env["AGENT_CMD"];
    else process.env["AGENT_CMD"] = original;
    rmSync(workDir, { recursive: true, force: true });
    db.close();
  }
});
