import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_GUILD_CONFIG,
  preflightProviderCredential,
  redactConfigForDisplay,
  resolveProviderRoute,
} from "../guildctl/config";

test("default config carries safe Rootsys routing without a persisted key", () => {
  assert.equal(DEFAULT_GUILD_CONFIG.model.api_key_env, "EXAMPLE_PRIVATE_API_KEY");
  assert.equal(JSON.stringify(DEFAULT_GUILD_CONFIG).includes("sk-"), false);
  assert.deepEqual(resolveProviderRoute(DEFAULT_GUILD_CONFIG, "default"), [
    "pvt/hy3-tencent",
    "pvt/deepseek-v4-pro",
    "pvt/grok-4.5",
  ]);
  assert.deepEqual(resolveProviderRoute(DEFAULT_GUILD_CONFIG, "census"), [
    "pvt/deepseek-v4-flash",
    "pvt/minimax-m3",
  ]);
  assert.deepEqual(resolveProviderRoute(DEFAULT_GUILD_CONFIG, "review"), [
    "pvt/gpt-5.5-review",
    "pvt/glm-5.2",
  ]);
});

test("credential preflight fails closed and redacts secret values", () => {
  assert.throws(
    () => preflightProviderCredential(DEFAULT_GUILD_CONFIG, {}),
    /EXAMPLE_PRIVATE_API_KEY is missing/,
  );
  const env = { EXAMPLE_PRIVATE_API_KEY: "secret-value-never-print" };
  assert.equal(preflightProviderCredential(DEFAULT_GUILD_CONFIG, env).ok, true);
  const redacted = JSON.stringify(redactConfigForDisplay(DEFAULT_GUILD_CONFIG, env));
  assert.match(redacted, /EXAMPLE_PRIVATE_API_KEY/);
  assert.doesNotMatch(redacted, /secret-value-never-print/);
});
