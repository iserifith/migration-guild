import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { DEFAULT_GUILD_CONFIG, type GuildConfig } from "../guildctl/config";
import { runPreflight, PREFLIGHT_PROBE_MAX_TOKENS } from "../guildctl/preflight";
import {
  completionBody,
  createStubFetch,
  emptyCompletionBody,
  makeTempDir,
} from "./truthful-run-state-fixtures";

/**
 * US7 (#158, FR-014, SC-008): preflight does not false-fail a healthy
 * reasoning-model provider. The probe's token budget is raised (256) so a
 * reasoning model has room to produce visible output after chain-of-thought;
 * when an empty completion is nonetheless the reasoning-token-exhaustion shape
 * at that raised budget, the failure is reported distinctly ("needs a larger
 * token budget") instead of the generic "empty completion"; and a genuinely
 * broken provider still fails with its unchanged message.
 */

const CREDENTIAL_ENV = "OPENAI_API_KEY";
const CREDENTIAL_VALUE = "«redacted:sk-…»";

function config(overrides: Partial<GuildConfig> = {}): GuildConfig {
  return { ...structuredClone(DEFAULT_GUILD_CONFIG), ...overrides } as GuildConfig;
}

const reachableAdapter = () => ({ ok: true, message: "adapter reachable" });

async function preflight(responses: Parameters<typeof createStubFetch>[0]) {
  const root = makeTempDir("guild-preflight-reasoning-");
  const stub = createStubFetch(responses);
  try {
    const result = await runPreflight({
      config: config(),
      root,
      env: { [CREDENTIAL_ENV]: CREDENTIAL_VALUE },
      fetchImpl: stub.fetch,
      checkAdapter: reachableAdapter,
    });
    return { result, calls: stub.calls };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** The #158 response shape: empty visible text, but reasoning tokens burned and finish_reason=length. */
function reasoningExhaustionBody(): unknown {
  return {
    choices: [{ finish_reason: "length", message: { role: "assistant", content: "" } }],
    usage: { completion_tokens_details: { reasoning_tokens: 256 } },
  };
}

test("US7: a healthy provider that answers within the raised budget is reported healthy", async () => {
  const { result, calls } = await preflight([{ body: completionBody("pong") }]);
  assert.equal(result.verdict, "pass", JSON.stringify(result));
  assert.equal(calls.length, 1);
  const body = calls[0].body as { max_tokens?: number };
  assert.equal(body.max_tokens, PREFLIGHT_PROBE_MAX_TOKENS);
  assert.ok(body.max_tokens! >= 256, `probe budget must be raised (got ${body.max_tokens})`);
});

test("US7: empty completion with nonzero reasoning tokens is reported distinctly (larger token budget)", async () => {
  const { result } = await preflight([{ body: reasoningExhaustionBody() }]);
  assert.equal(result.verdict, "fail", JSON.stringify(result));
  assert.equal(result.failedStage, "response");
  assert.match(result.reason ?? "", /larger token budget/i);
  assert.match(result.reason ?? "", /reasoning tokens/i);
  // Distinct from the generic message — not the bare "empty completion" line.
  assert.notEqual(result.reason, "provider returned an empty completion");
});

test("US7: a genuinely-empty completion (no reasoning tokens) keeps the unchanged generic message", async () => {
  const { result } = await preflight([{ body: emptyCompletionBody() }]);
  assert.equal(result.verdict, "fail", JSON.stringify(result));
  assert.equal(result.failedStage, "response");
  assert.equal(result.reason, "provider returned an empty completion");
});

test("US7: a genuinely broken/unreachable provider still correctly reports failure", async () => {
  const { result } = await preflight([{ networkError: "ECONNREFUSED api.openai.com:443" }]);
  assert.equal(result.verdict, "fail", JSON.stringify(result));
  assert.equal(result.failedStage, "response");
  assert.match(result.reason ?? "", /unreachable|ECONNREFUSED/i);

  const rejected = await preflight([{ status: 401, body: { error: { message: "inactive credential" } } }]);
  assert.equal(rejected.result.verdict, "fail", JSON.stringify(rejected.result));
  assert.equal(rejected.result.failedStage, "authorization");
});