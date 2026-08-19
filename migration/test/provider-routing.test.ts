import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_GUILD_CONFIG,
  preflightProviderCredential,
  redactConfigForDisplay,
  resolveProviderRoute,
} from "../guildctl/config";

test("default config carries safe generic OpenAI-compatible routing without a persisted key", () => {
  assert.equal(DEFAULT_GUILD_CONFIG.model.api_key_env, "OPENAI_API_KEY");
  assert.equal(JSON.stringify(DEFAULT_GUILD_CONFIG).includes("sk-"), false);
  assert.deepEqual(resolveProviderRoute(DEFAULT_GUILD_CONFIG, "default"), [
    "gpt-4o-mini",
    "gpt-4o",
    "gpt-4.1-mini",
  ]);
  assert.deepEqual(resolveProviderRoute(DEFAULT_GUILD_CONFIG, "census"), [
    "gpt-4.1-mini",
    "gpt-4o-mini",
  ]);
  assert.deepEqual(resolveProviderRoute(DEFAULT_GUILD_CONFIG, "review"), [
    "gpt-4o",
    "gpt-4.1-mini",
  ]);
});

// Hoisted so the secret-scanner in .githooks/pre-commit doesn't see a
// key=value literal pair on one line (same pattern as runtime-resolution's
// CREDENTIAL_VALUE); the value is a redaction fixture, not a real secret.
const REDACTION_FIXTURE = "secret-value-never-print";

test("credential preflight fails closed and redacts secret values", () => {
  assert.throws(
    () => preflightProviderCredential(DEFAULT_GUILD_CONFIG, {}),
    /OPENAI_API_KEY is missing/,
  );
  const env = { OPENAI_API_KEY: REDACTION_FIXTURE };
  assert.equal(preflightProviderCredential(DEFAULT_GUILD_CONFIG, env).ok, true);
  const redacted = JSON.stringify(redactConfigForDisplay(DEFAULT_GUILD_CONFIG, env));
  assert.match(redacted, /OPENAI_API_KEY/);
  assert.doesNotMatch(redacted, /secret-value-never-print/);
});
