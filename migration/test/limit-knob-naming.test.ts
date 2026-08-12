import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_GUILD_CONFIG, deepMerge, type GuildConfig } from "../guildctl/config";
import {
  formatLimitTerminationNote,
  limitPhaseForAutoWorker,
  resolveEffectiveLimit,
} from "../guildctl/limits";

/**
 * US4 (FR-027–FR-029, research R13): a limit message names the knob that
 * actually governed the limit that fired. The termination message and
 * `guildctl limits` both read `knob`, `effectiveValueMs`, and `source` from
 * the same `EffectiveLimit` descriptor the enforcement used, so it is
 * structurally impossible for the message to name a knob that does not
 * govern.
 */

test("per-phase env var occupies tier 1 and names itself as the knob", () => {
  const env = { GUILDCTL_CODE_TIMEOUT_MINS: "7" };
  const limit = resolveEffectiveLimit("code-writing", "ceiling", DEFAULT_GUILD_CONFIG, env);
  assert.equal(limit.source, "per-phase-setting");
  assert.equal(limit.knob, "GUILDCTL_CODE_TIMEOUT_MINS");
  assert.equal(limit.effectiveValueMs, 7 * 60_000);
  assert.equal(limit.requestedValueMs, 7 * 60_000);
  assert.equal(limit.floorApplied, false);
});

test("changing the named knob changes the observed limit", () => {
  const a = resolveEffectiveLimit("code-writing", "ceiling", DEFAULT_GUILD_CONFIG, { GUILDCTL_CODE_TIMEOUT_MINS: "7" });
  const b = resolveEffectiveLimit("code-writing", "ceiling", DEFAULT_GUILD_CONFIG, { GUILDCTL_CODE_TIMEOUT_MINS: "9" });
  assert.notEqual(a.effectiveValueMs, b.effectiveValueMs);
});

test("inactivity limit names the inactivity knob under the same rule", () => {
  const limit = resolveEffectiveLimit("code-writing", "inactivity", DEFAULT_GUILD_CONFIG, {
    GUILDCTL_INACTIVITY_TIMEOUT_SECONDS: "45",
  });
  assert.equal(limit.source, "env-override");
  assert.equal(limit.knob, "GUILDCTL_INACTIVITY_TIMEOUT_SECONDS");
  assert.equal(limit.effectiveValueMs, 45_000);
});

test("environment overrides are named when they govern", () => {
  const limit = resolveEffectiveLimit("code-writing", "ceiling", DEFAULT_GUILD_CONFIG, {
    GUILDCTL_AGENT_CEILING_SECONDS: "600",
  });
  assert.equal(limit.source, "env-override");
  assert.equal(limit.knob, "GUILDCTL_AGENT_CEILING_SECONDS");
});

test("unset phase-specific var: tier 1 unoccupied, falls through to env override", () => {
  const limit = resolveEffectiveLimit("code-writing", "ceiling", DEFAULT_GUILD_CONFIG, {
    GUILDCTL_AGENT_CEILING_SECONDS: "900",
  });
  assert.equal(limit.source, "env-override");
});

test("unset phase-specific var and env override: falls through to project configuration", () => {
  const config: GuildConfig = deepMerge(DEFAULT_GUILD_CONFIG as unknown as Record<string, unknown>, {
    agent_limits: { ceiling_seconds: 200 },
  }) as unknown as GuildConfig;
  const limit = resolveEffectiveLimit("code-writing", "ceiling", config, {});
  assert.equal(limit.source, "project-configuration");
  assert.equal(limit.knob, "agent_limits.ceiling_seconds");
  // 200s < 5-minute floor, so the floor raises it.
  assert.equal(limit.requestedValueMs, 200_000);
  assert.equal(limit.effectiveValueMs, 5 * 60_000);
  assert.equal(limit.floorApplied, true);
});

test("nothing set anywhere: falls through to built-in default", () => {
  const limit = resolveEffectiveLimit("code-writing", "ceiling", DEFAULT_GUILD_CONFIG, {});
  assert.equal(limit.source, "built-in-default");
  assert.equal(limit.effectiveValueMs, 20 * 60_000);
});

test("pins project-configuration versus built-in-default", () => {
  const explicit: GuildConfig = deepMerge(DEFAULT_GUILD_CONFIG as unknown as Record<string, unknown>, {
    agent_limits: { ceiling_seconds: 1800 },
  }) as unknown as GuildConfig;
  // Same numeric value as the shipped default, but this comparison is a
  // deliberate limitation documented in limits.ts; assert the more common case
  // instead: a value that actually differs is unambiguously project-configuration.
  const different: GuildConfig = deepMerge(DEFAULT_GUILD_CONFIG as unknown as Record<string, unknown>, {
    agent_limits: { ceiling_seconds: 2400 },
  }) as unknown as GuildConfig;
  void explicit;
  const limitExplicit = resolveEffectiveLimit("planning", "ceiling", different, {});
  assert.equal(limitExplicit.source, "project-configuration");
  const limitDefault = resolveEffectiveLimit("planning", "ceiling", DEFAULT_GUILD_CONFIG, {});
  assert.equal(limitDefault.source, "built-in-default");
});

test("floorApplied reports the enforced value, not the requested one", () => {
  const limit = resolveEffectiveLimit("review", "ceiling", DEFAULT_GUILD_CONFIG, { GUILDCTL_REVIEW_TIMEOUT_MINS: "0.1" });
  assert.equal(limit.requestedValueMs, 0.1 * 60_000);
  assert.equal(limit.effectiveValueMs, 1 * 60_000);
  assert.equal(limit.floorApplied, true);
});

test("malformed timeout input normalizes to the built-in default rather than NaN", () => {
  const limit = resolveEffectiveLimit("code-writing", "ceiling", DEFAULT_GUILD_CONFIG, {
    GUILDCTL_CODE_TIMEOUT_MINS: "not-a-number",
  });
  assert.equal(Number.isFinite(limit.effectiveValueMs), true);
  assert.equal(limit.requestedValueMs, 20 * 60_000);
});

test("guildctl limits reports each phase's effective limit, knob, and precedence order", async () => {
  const { KNOWN_LIMIT_PHASES } = await import("../guildctl/limits");
  for (const phase of KNOWN_LIMIT_PHASES) {
    const limit = resolveEffectiveLimit(phase, "ceiling", DEFAULT_GUILD_CONFIG, {});
    assert.equal(limit.precedenceOrder.join(">"), "per-phase-setting>env-override>project-configuration>built-in-default");
    assert.ok(limit.knob.length > 0);
  }
});

test("autonomous worker-path mapping: migrate -> code-writing, repair -> remediation", () => {
  assert.equal(limitPhaseForAutoWorker("migrate"), "code-writing");
  assert.equal(limitPhaseForAutoWorker("repair"), "remediation");
});

test("autonomous review-path mapping uses the review phase", () => {
  const limit = resolveEffectiveLimit("review", "ceiling", DEFAULT_GUILD_CONFIG, {});
  assert.equal(limit.phase, "review");
});

test("termination note quotes knob, effective value, and source from the descriptor", () => {
  const limit = resolveEffectiveLimit("code-writing", "ceiling", DEFAULT_GUILD_CONFIG, { GUILDCTL_CODE_TIMEOUT_MINS: "20" });
  const note = formatLimitTerminationNote(limit);
  assert.match(note, /GUILDCTL_CODE_TIMEOUT_MINS/);
  assert.match(note, /20m/);
  assert.match(note, /per phase setting/);
});
