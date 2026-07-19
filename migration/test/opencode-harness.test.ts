import assert from "node:assert/strict";
import test from "node:test";
import * as opencodeHarness from "../../package/harness/opencode.mjs";

const harness = opencodeHarness as any;

function event(part: Record<string, unknown>, sessionID = "main") {
  return JSON.stringify({ type: "step_finish", sessionID, part });
}

test("opencode harness aggregates step-finish token usage across sessions", () => {
  const totals = harness.createTokenTotals();
  harness.consumeOpenCodeJsonEvent(event({ type: "step-finish", tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 7, write: 3 } } }), totals);
  harness.consumeOpenCodeJsonEvent(event({ type: "step-finish", tokens: { input: 4, output: 1, reasoning: 0, cache: { read: 2, write: 1 } } }, "child-session"), totals);
  assert.equal(totals.input, 14);
  assert.equal(totals.output, 6);
  assert.equal(totals.reasoning, 2);
  assert.equal(totals.cacheRead, 9);
  assert.equal(totals.cacheWrite, 4);
  assert.equal(totals.total, 35);
  assert.equal(totals.fresh, 22);
  assert.equal(totals.events, 2);
  assert.deepEqual(totals.sessions, new Set(["main", "child-session"]));
});

test("opencode harness accepts AI SDK usage field aliases", () => {
  const totals = harness.createTokenTotals();
  harness.consumeOpenCodeJsonEvent(JSON.stringify({ type: "step_finish", sessionID: "main", part: { type: "step-finish", usage: { nonCachedInputTokens: 11, visibleOutputTokens: 6, reasoningTokens: 3, cacheReadInputTokens: 4, cacheWriteInputTokens: 2, totalTokens: 26 } } }), totals);
  assert.equal(totals.input, 11);
  assert.equal(totals.output, 6);
  assert.equal(totals.reasoning, 3);
  assert.equal(totals.cacheRead, 4);
  assert.equal(totals.cacheWrite, 2);
  assert.equal(totals.total, 26);
  assert.equal(totals.fresh, 20);
});

test("opencode harness ignores malformed JSON and events without usage", () => {
  const totals = harness.createTokenTotals();
  assert.equal(harness.consumeOpenCodeJsonEvent("not json", totals), false);
  assert.equal(harness.consumeOpenCodeJsonEvent(JSON.stringify({ type: "text", part: { type: "text", text: "hello" } }), totals), false);
  assert.equal(totals.events, 0);
  assert.equal(totals.total, 0);
});

test("opencode harness renders readable output from JSON events", () => {
  assert.equal(harness.renderReadableEvent(JSON.stringify({ type: "text", part: { type: "text", text: "done\n" } })), "done\n");
  assert.match(harness.renderReadableEvent(JSON.stringify({ type: "tool_use", part: { type: "tool", tool: "bash", state: { status: "completed" } } })), /bash completed/);
});

test("opencode harness invokes supported OpenCode flags with isolated full permissions", () => {
  const invocation = harness.buildOpencodeInvocation(["--model", "gpt-test", "--prompt", "hello"], { cwd: process.cwd(), env: { ...process.env, OPENAI_API_KEY: "test" } });
  assert.deepEqual(invocation.args.slice(0, 5), ["run", "--pure", "--auto", "--format", "json"]);
  assert.ok(invocation.args.includes("guild/gpt-test"));
  const config = JSON.parse(invocation.env.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(config.plugin, []);
  assert.deepEqual(config.instructions, []);
  assert.equal(config.permission, "allow");
  assert.deepEqual(config.enabled_providers, ["guild"]);
});

test("opencode harness read-only review mode denies edits in runtime config", () => {
  const invocation = harness.buildOpencodeInvocation(["--model", "gpt-test", "--read-only", "--prompt", "hello"], { cwd: process.cwd(), env: { ...process.env, OPENAI_API_KEY: "test" } });
  assert.deepEqual(invocation.args.slice(0, 5), ["run", "--pure", "--auto", "--format", "json"]);
  const config = JSON.parse(invocation.env.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(config.permission, { "*": "allow", edit: "deny" });
  assert.equal(invocation.parsed.readOnly, true);
});

test("opencode harness honors an explicit CLI binary override", () => {
  const expected = process.platform === "win32" ? "C:\\tools\\opencode.exe" : "/tools/opencode";
  const invocation = harness.buildOpencodeInvocation(["--prompt", "hello"], {
    cwd: process.cwd(),
    env: { ...process.env, OPENAI_API_KEY: "test", OPENCODE_CLI_PATH: expected },
  });
  assert.equal(invocation.command, expected);
});

test("opencode harness embeds runner preclaims for tool environments that scrub variables", () => {
  const invocation = harness.buildOpencodeInvocation(["--agent", "analyze-agent", "--prompt", "analyze"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OPENAI_API_KEY: "test",
      GUILDCTL_ARTIFACT_ID: "legacy-source:Example",
      GUILDCTL_CLAIM_ID: "claim-123",
      GUILDCTL_CLAIM_TOKEN: "token-456",
      GUILDCTL_RUN_ID: "run-789",
      GUILDCTL_AGENT_NAME: "analyze-agent:owner",
    },
  });
  assert.match(invocation.fullPrompt, /Runner claim handoff \(authoritative\)/);
  assert.match(invocation.fullPrompt, /Do not run the `claim` command/);
  assert.match(invocation.fullPrompt, /"artifact_id": "legacy-source:Example"/);
  assert.match(invocation.fullPrompt, /"claim_id": "claim-123"/);
  assert.match(invocation.fullPrompt, /"claim_token": "token-456"/);
  assert.match(invocation.fullPrompt, /"run_id": "run-789"/);
});
