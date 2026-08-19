import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkHarness } from "../guildctl/harness";

/**
 * US4 (#148, FR-008): `checkHarness` reports *why* a present-but-failing
 * harness fails. When the adapter file exists but the `--version` probe exits
 * non-zero or fails to spawn, the failure message must carry the adapter's own
 * stderr/stdout excerpt (trimmed, length-capped) instead of the generic
 * "(<command> is missing or unreachable)" wording — a user whose Copilot CLI
 * isn't installed then sees the real cause instead of hunting for an
 * agent-shim.mjs file that is fine.
 *
 * Mirrors harness-stderr.test.ts's fake-agent.sh fixture pattern; every case is
 * hermetic (fixture scripts in a temp dir, no installed agent CLI needed).
 */

const DISTINCTIVE_STDERR = "COPILOT_NOT_INSTALLED: cannot find module '@github/copilot'";

function writeFixtureScript(name: string, body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guild-harness-excerpt-"));
  const script = path.join(dir, name);
  fs.writeFileSync(script, body, { mode: 0o755 });
  return script;
}

test("US4: a present adapter whose probe exits non-zero surfaces its stderr excerpt (FR-008 S1)", () => {
  const script = writeFixtureScript(
    "failing-agent.sh",
    `#!/bin/sh\necho "${DISTINCTIVE_STDERR}" >&2\nexit 3\n`,
  );
  try {
    const resolution = { name: "custom", command: script, targetCommand: script, source: "config" as const };
    const result = checkHarness(resolution);
    assert.equal(result.ok, false);
    assert.match(result.message, /active harness: custom/);
    assert.match(result.message, new RegExp(DISTINCTIVE_STDERR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    // The generic wording is gone — the excerpt replaces it, not decorates it.
    assert.doesNotMatch(result.message, /is missing or unreachable/);
    // The exit code is named so "exited N" is distinguishable from a spawn error.
    assert.match(result.message, /exited 3/);
  } finally {
    fs.rmSync(path.dirname(script), { recursive: true, force: true });
  }
});

test("US4: a nonexistent config adapter keeps the unchanged missing-adapter message (FR-008 S2)", () => {
  const missing = path.join(os.tmpdir(), `no-such-adapter-${Date.now()}.mjs`);
  const resolution = { name: "opencode", command: missing, targetCommand: "opencode", source: "config" as const };
  const result = checkHarness(resolution);
  assert.equal(result.ok, false);
  assert.equal(result.message, `active harness: opencode (missing adapter: ${missing})`);
});

test("US4: a resolution that cannot be spawned at all is 'failed to start', not 'exited N' (FR-008 S3)", () => {
  const missingCommand = path.join(os.tmpdir(), `missing-harness-command-${Date.now()}`);
  const resolution = { name: "custom", command: missingCommand, targetCommand: missingCommand, source: "environment" as const };
  const result = checkHarness(resolution);
  assert.equal(result.ok, false);
  assert.match(result.message, /active harness: custom/);
  assert.match(result.message, /failed to start/);
  assert.doesNotMatch(result.message, /exited \d+/);
  assert.doesNotMatch(result.message, /is missing or unreachable/);
});

test("US4: a healthy harness keeps the unchanged ok message (FR-008 S4)", () => {
  const resolution = { name: "custom", command: process.execPath, targetCommand: process.execPath, source: "environment" as const };
  const result = checkHarness(resolution);
  assert.equal(result.ok, true);
  assert.equal(result.message, `active harness: custom (AGENT_CMD override)`);
});

test("US4: a very long stderr excerpt is truncated by the cap (FR-008)", () => {
  const marker = "CAP_TAIL_MARKER_XYZ";
  const script = writeFixtureScript(
    "noisy-agent.sh",
    `#!/bin/sh\nprintf '%s\\n' "${"y".repeat(2000)}${marker}" >&2\nexit 4\n`,
  );
  try {
    const resolution = { name: "custom", command: script, targetCommand: script, source: "config" as const };
    const result = checkHarness(resolution);
    assert.equal(result.ok, false);
    // The tail past the cap is dropped ...
    assert.doesNotMatch(result.message, /CAP_TAIL_MARKER_XYZ/);
    // ... while the capped head is present.
    assert.match(result.message, /y{32}/);
    assert.match(result.message, /exited 4/);
  } finally {
    fs.rmSync(path.dirname(script), { recursive: true, force: true });
  }
});

test("US4: stdout is used when the adapter writes nothing to stderr (FR-008)", () => {
  const script = writeFixtureScript(
    "stdout-only-agent.sh",
    `#!/bin/sh\necho "only-wrote-to-stdout"\nexit 5\n`,
  );
  try {
    const resolution = { name: "custom", command: script, targetCommand: script, source: "config" as const };
    const result = checkHarness(resolution);
    assert.equal(result.ok, false);
    assert.match(result.message, /only-wrote-to-stdout/);
    assert.match(result.message, /exited 5/);
  } finally {
    fs.rmSync(path.dirname(script), { recursive: true, force: true });
  }
});

test("US4: the excerpt is trimmed of surrounding whitespace (FR-008)", () => {
  const script = writeFixtureScript(
    "padded-agent.sh",
    `#!/bin/sh\nprintf '\\n\\n   padded-message   \\n\\n' >&2\nexit 6\n`,
  );
  try {
    const resolution = { name: "custom", command: script, targetCommand: script, source: "config" as const };
    const result = checkHarness(resolution);
    assert.equal(result.ok, false);
    assert.match(result.message, /padded-message/);
    assert.doesNotMatch(result.message, /\s{4}padded-message/);
  } finally {
    fs.rmSync(path.dirname(script), { recursive: true, force: true });
  }
});
