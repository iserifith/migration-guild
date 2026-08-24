import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * #215/#219: package/agents/*.agent.md are versioned prompt contracts, but
 * nothing previously asserted that a load-bearing rule survives an edit —
 * the exact gap the SwarmForge analysis flagged (docs/swarmforge-gap-analysis.md,
 * §1 and §5). This locks in the whole-card-discipline rule added by #219:
 * an artifact-claiming agent must not hand off partial work (test/production
 * code written, registry updated) before claiming the next one.
 */

const repoRoot = path.resolve(__dirname, "..", "..");
const agentsDir = path.join(repoRoot, "package", "agents");

function read(name: string): string {
  return fs.readFileSync(path.join(agentsDir, name), "utf8");
}

const WHOLE_CARD_MARKER = "Do not hand off partial work";

// Agents that claim an artifact and drive it through one or more registry
// status transitions — these are the agents #219 targeted.
const CLAIM_DRIVING_AGENTS = [
  "migration-agent.agent.md",
  "test-writer-agent.agent.md",
  "codegen-agent.agent.md",
] as const;

test("each claim-driving agent states the whole-card-discipline rule under Rules (#219)", () => {
  for (const file of CLAIM_DRIVING_AGENTS) {
    const text = read(file);
    const rulesStart = text.indexOf("## Rules");
    assert.ok(rulesStart >= 0, `${file} must have a Rules section`);
    const rulesEnd = text.indexOf("\n## ", rulesStart + 1);
    const rules = text.slice(rulesStart, rulesEnd === -1 ? undefined : rulesEnd);
    assert.match(
      rules,
      new RegExp(WHOLE_CARD_MARKER),
      `${file}'s Rules section must retain the whole-card-discipline rule ("${WHOLE_CARD_MARKER}...")`,
    );
  }
});

test("every package/agents/*.agent.md with a Rules section has at least one rule bullet", () => {
  const files = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".agent.md"));
  assert.ok(files.length > 0, "expected to find agent prompt files — did the tree move?");

  for (const file of files) {
    const text = read(file);
    const rulesStart = text.indexOf("## Rules");
    if (rulesStart === -1) continue; // not every agent has a Rules section
    const rulesEnd = text.indexOf("\n## ", rulesStart + 1);
    const rules = text.slice(rulesStart, rulesEnd === -1 ? undefined : rulesEnd);
    const bullets = rules.split("\n").filter((line) => /^-\s+\S/.test(line.trim()));
    assert.ok(bullets.length > 0, `${file} has a Rules heading with no rule bullets`);
  }
});
