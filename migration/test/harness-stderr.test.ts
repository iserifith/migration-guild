import assert from "node:assert/strict";
import { mkdtempSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { spawnAgent, summarizeRunFailures, HARNESS_OUTPUT_CAP } from "../guildctl/runner";
import type { AgentRunResult } from "../guildctl/runner";
import { runInventory } from "../guildctl/commands/inventory";
import { applySchema } from "../registry/db/schema";
import { registerArtifact } from "../registry/commands/artifacts";

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

// The remaining #121 residual: the `guildctl run inventory` classify path used to
// print a bare `✗ <batch> attempt <N> exited with code <code>` and never read
// result.capturedOutput — so a codex /v1/models schema failure was invisible.
// The path must surface the captured harness output excerpt, labeled with the
// harness name and exit code, on every failed attempt (initial + retries).
test("run inventory classify failure surfaces the captured harness stderr", async () => {
  const db = createDb();
  const repoRoot = path.resolve(__dirname, "..", "..");
  const root = mkdtempSync(path.join(tmpdir(), "guildctl-inventory-stderr-"));
  const stderrText = "codex error: unexpected response schema from GET /v1/models";
  const auditSummary = {
    artifact_count: 1,
    jvm: { critical: 0, warnings: 0 },
    dependencies: { total: 0, unresolved: 0 },
    tools: [],
  };
  let stderrChunks = "";
  const originalWrite = process.stderr.write;
  cpSync(path.join(repoRoot, "stacks"), path.join(root, "stacks"), { recursive: true });
  mkdirSync(path.join(root, ".guild"), { recursive: true });
  writeFileSync(path.join(root, ".guild", "config.yaml"), `version: 1
stack: java-spring
inventory:
  classificationBatchSize: 100
  maxBatchRetries: 2
`);
  registerArtifact(db, {
    id: "legacy-source:com.acme:Widget",
    kind: "legacy-source",
    tier: "first-class",
    path: "legacy/src/main/java/com/acme/Widget.java",
  });

  try {
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrChunks += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      return true;
    }) as typeof process.stderr.write;
    await assert.rejects(() =>
      runInventory(db, root, {
        scanAndRegister: () => 0,
        startPolling: () => () => undefined,
        refreshCompatibilityAudits: () => auditSummary,
        spawnAgent: async ({ agent, prompt }): Promise<AgentRunResult> => ({
          runId: `${agent}-run`,
          agent,
          model: "m",
          prompt,
          logFile: "/tmp/x",
          exitCode: 1,
          capturedOutput: `${stderrText}\n`,
          harness: "codex",
        }),
      }),
    );

    // 1 initial attempt + 2 retries = 3 failed classify calls, each surfacing
    // the captured output excerpt — not just a bare exit code.
    assert.match(stderrChunks, /exited with code 1/);
    assert.match(stderrChunks, /failed after 2 retry\(ies\)/);
    assert.match(stderrChunks, new RegExp(`codex \\(exit 1\\) output:`));
    assert.match(stderrChunks, new RegExp(stderrText));
    const excerpts = stderrChunks.split("codex (exit 1) output:").length - 1;
    assert.equal(excerpts, 3, "every failed attempt (1 initial + 2 retries) surfaces the excerpt");
  } finally {
    process.stderr.write = originalWrite;
    rmSync(root, { recursive: true, force: true });
    db.close();
  }
});
