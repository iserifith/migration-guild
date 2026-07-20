import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const personaFiles = [
  "analyze-agent.agent.md",
  "test-writer-agent.agent.md",
  "code-writer-agent.agent.md",
];

for (const file of personaFiles) {
  test(`${file} honors runner preclaims`, () => {
    const text = readFileSync(new URL(`../../package/agents/${file}`, import.meta.url), "utf8");
    assert.match(text, /GUILDCTL_ARTIFACT_ID/);
    assert.match(text, /GUILDCTL_CLAIM_ID/);
    assert.match(text, /GUILDCTL_CLAIM_TOKEN/);
    assert.match(text, /skip the claim command|do not run `claim`/i);
  });
}
