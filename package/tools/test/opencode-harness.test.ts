import assert from "node:assert/strict";
import test from "node:test";
import * as opencodeHarness from "../../harness/opencode.mjs";

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

test("opencode harness invokes opencode run with JSON format", () => {
  const invocation = harness.buildOpencodeInvocation(["--model", "gpt-test", "--prompt", "hello"], { cwd: process.cwd(), env: { ...process.env, OPENAI_API_KEY: "test" } });
  assert.deepEqual(invocation.args.slice(0, 4), ["run", "--dangerously-skip-permissions", "--format", "json"]);
  assert.ok(invocation.args.includes("guild/gpt-test"));
});
