import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * US5 (#148, FR-010..FR-016, SC-005): the shipped docs and package/ artifacts
 * tell one consistent story. These greps encode that bar as tests: no DashScope
 * as the shipped default, no stale guildctl.config.json references outside
 * "what is NOT read" negations, --legacy-path documented, one pipeline command
 * form, and no dead guildctl.config.json file left on disk.
 */

const repoRoot = path.resolve(__dirname, "..", "..");

function read(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), "utf8");
}

/** Lines of `text` containing `needle` (case-insensitive). */
function grepLines(text: string, needle: string): string[] {
  return text.split("\n").filter((line) => line.toLowerCase().includes(needle.toLowerCase()));
}

// The single allowlisted DashScope mention permitted by FR-015's optional
// commented-alternative allowance (T026 may ship `# DASHSCOPE_API_KEY=`).
const ALLOWED_DASHSCOPE_LINE = "# DASHSCOPE_API_KEY=";

test("US5: no shipped doc or package artifact names DashScope as the default provider (FR-015)", () => {
  const files = [".env.example", "package/.env.example", "README.md", "GETTING-STARTED.md"];
  for (const rel of files) {
    const hits = grepLines(read(rel), "dashscope").filter(
      (line) => !(line.trim() === ALLOWED_DASHSCOPE_LINE.trim()),
    );
    assert.deepEqual(
      hits,
      [],
      `${rel} must not present DashScope as the shipped default (allowed: the exact commented "${ALLOWED_DASHSCOPE_LINE.trim()}" alternative line)`,
    );
  }
});

test("US5: no stale guildctl.config.json references in shipped docs (FR-010/FR-016, SC-005)", () => {
  const files = [".env.example", "package/.env.example", "README.md", "GETTING-STARTED.md", "AGENTS.md"];
  for (const rel of files) {
    const hits = grepLines(read(rel), "guildctl.config.json").filter((line) => {
      // Negation context documents what is NOT read (e.g. GETTING-STARTED.md's
      // "**not** from `guildctl.config.json`") — that is the fix, not a bug.
      const withoutMarkdown = line.replace(/[*_`]/g, "");
      return !/\bnot\b/i.test(withoutMarkdown);
    });
    assert.deepEqual(hits, [], `${rel} must not reference the deleted guildctl.config.json outside a "what is NOT read" negation`);
  }
});

test("US5: GETTING-STARTED.md documents --legacy-path in the Setup block (FR-011)", () => {
  const text = read("GETTING-STARTED.md");
  const start = text.indexOf("## Setup");
  assert.ok(start >= 0, "GETTING-STARTED.md must have a Setup section");
  const end = text.indexOf("\n## ", start + 1);
  const setup = text.slice(start, end === -1 ? undefined : end);
  assert.match(setup, /--legacy-path/, "the Setup block must document --legacy-path");
});

test("US5: README and GETTING-STARTED use the `guildctl run <phase>` form for pipeline phases (FR-012)", () => {
  // README's "Pipeline at a glance" table rows: `guildctl <phase>` vs
  // `guildctl run <phase>`. A bare `guildctl inventory` in the Command column
  // is the inconsistency; `guildctl status`/`watch`/`auto-run` rows are out of
  // scope for phase-form unification (the task pins only phase invocations).
  const readme = read("README.md");
  const tableStart = readme.indexOf("## Pipeline at a glance");
  assert.ok(tableStart >= 0, "README.md must have a 'Pipeline at a glance' section");
  const tableEnd = readme.indexOf("\n## ", tableStart + 1);
  const table = readme.slice(tableStart, tableEnd === -1 ? undefined : tableEnd);
  const barePhaseRows = table
    .split("\n")
    .filter((line) => /^\|/.test(line.trim()))
    .filter((line) => /`guildctl (inventory|plan|bootstrap|migrate|review)`/.test(line));
  assert.deepEqual(
    barePhaseRows,
    [],
    "README's pipeline table must use `guildctl run <phase>`, not the bare `guildctl <phase>` form",
  );

  // GETTING-STARTED's "Run the pipeline" block already uses the run form; it
  // must not regress to the bare form either.
  const gs = read("GETTING-STARTED.md");
  const gsStart = gs.indexOf("## Run the pipeline");
  assert.ok(gsStart >= 0, "GETTING-STARTED.md must have a 'Run the pipeline' section");
  const gsEnd = gs.indexOf("\n## ", gsStart + 1);
  const block = gs.slice(gsStart, gsEnd === -1 ? undefined : gsEnd);
  const bareGs = block.split("\n").filter((line) => /guildctl (inventory|plan|bootstrap|migrate|review)\b/.test(line) && !/guildctl run/.test(line));
  assert.deepEqual(bareGs, [], "GETTING-STARTED's pipeline block must keep the `guildctl run <phase>` form");
});

test("US5: agent-shim.mjs carries no DashScope identifiers (FR-015)", () => {
  const text = read("package/agent-shim.mjs");
  assert.deepEqual(grepLines(text, "DASHSCOPE_API_KEY"), [], "package/agent-shim.mjs must not reference DASHSCOPE_API_KEY");
  assert.deepEqual(grepLines(text, "dashscope-intl"), [], "package/agent-shim.mjs must not reference the dashscope-intl endpoint");
});

test("US5: neither guildctl.config.json copy exists on disk (FR-014/FR-016)", () => {
  assert.equal(fs.existsSync(path.join(repoRoot, "guildctl.config.json")), false, "root guildctl.config.json must be deleted");
  assert.equal(fs.existsSync(path.join(repoRoot, "package", "guildctl.config.json")), false, "package/guildctl.config.json must be deleted");
});
