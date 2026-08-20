import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * US6 (#157, FR-013, SC-006): no shipped command template or agent/prompt
 * persona may point an agent at the stale built-path `migration/dist/...`.
 * The registry CLI is built to `migration/registry/dist/cli.js` (and the
 * guildctl CLI to `migration/guildctl/dist/cli.js`); there is no
 * `migration/dist/` tree. Any `migration/dist/` literal left in a prompt is a
 * guaranteed ENOENT the first time an agent runs the suggested command — the
 * exact class of bug #148/PR #149's `doc-consistency` test established a
 * regression-grep precedent for.
 *
 * The sweep surface is the one pinned by spec acceptance scenario 3 and
 * quickstart.md's US6 grep: `migration/guildctl/commands`, `package/agents`,
 * `package/prompts`.
 */

const repoRoot = path.resolve(__dirname, "..", "..");

const SWEEP_ROOTS = [
  "migration/guildctl/commands",
  "package/agents",
  "package/prompts",
] as const;

const SWEEP_EXTENSIONS = new Set([".ts", ".md"]);

/** Recursively collect the sweep files under `relDir` (relative to repoRoot). */
function collectFiles(relDir: string): string[] {
  const abs = path.join(repoRoot, relDir);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(relDir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectFiles(rel));
    } else if (SWEEP_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(rel);
    }
  }
  return out;
}

test("US6: no stale `migration/dist/` literal in any shipped command or prompt template (FR-013)", () => {
  const offenders: Array<{ file: string; line: number; text: string }> = [];
  for (const root of SWEEP_ROOTS) {
    for (const rel of collectFiles(root)) {
      const text = fs.readFileSync(path.join(repoRoot, rel), "utf8");
      text.split("\n").forEach((line, i) => {
        if (line.includes("migration/dist/")) {
          offenders.push({ file: rel, line: i + 1, text: line.trim() });
        }
      });
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "stale `migration/dist/` path(s) found (use `migration/registry/dist/cli.js` for the registry CLI):\n" +
      offenders.map((o) => `  ${o.file}:${o.line}: ${o.text}`).join("\n"),
  );
});

test("US6: the sweep surface is non-empty (guard against a silently-moved tree)", () => {
  const total = SWEEP_ROOTS.reduce((n, root) => n + collectFiles(root).length, 0);
  assert.ok(total > 0, "expected to find swept command/prompt files — did the tree move?");
});
