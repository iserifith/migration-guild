import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_GUILD_CONFIG,
  preflightProviderCredential,
  redactConfigForDisplay,
  resolveProviderRoute,
} from "../guildctl/config";

test("default config carries safe Rootsys routing without a persisted key", () => {
  assert.equal(DEFAULT_GUILD_CONFIG.model.api_key_env, "ROOTSYS_API_KEY");
  assert.equal(JSON.stringify(DEFAULT_GUILD_CONFIG).includes("sk-"), false);
  assert.deepEqual(resolveProviderRoute(DEFAULT_GUILD_CONFIG, "default"), [
    "fiq/hy3-tencent",
    "fiq/deepseek-v4-pro",
    "fiq/grok-4.5",
  ]);
  assert.deepEqual(resolveProviderRoute(DEFAULT_GUILD_CONFIG, "census"), [
    "fiq/deepseek-v4-flash",
    "fiq/minimax-m3",
  ]);
  assert.deepEqual(resolveProviderRoute(DEFAULT_GUILD_CONFIG, "review"), [
    "fiq/gpt-5.5-review",
    "fiq/glm-5.2",
  ]);
});

test("credential preflight fails closed and redacts secret values", () => {
  assert.throws(
    () => preflightProviderCredential(DEFAULT_GUILD_CONFIG, {}),
    /ROOTSYS_API_KEY is missing/,
  );
  const env = { ROOTSYS_API_KEY: "secret-value-never-print" };
  assert.equal(preflightProviderCredential(DEFAULT_GUILD_CONFIG, env).ok, true);
  const redacted = JSON.stringify(redactConfigForDisplay(DEFAULT_GUILD_CONFIG, env));
  assert.match(redacted, /ROOTSYS_API_KEY/);
  assert.doesNotMatch(redacted, /secret-value-never-print/);
});
