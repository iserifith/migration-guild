# Analysis: Spec 010 — Fix Provider/Harness Resolution (Onboarding Hardening, Wave 3)

## Summary

Cross-checked `spec.md`, `plan.md`, and `tasks.md` against each other and against the actual
source on this branch (`migration/guildctl/{env,harness,preflight,doctor,runner,commands/auto}.ts`,
`migration/guildctl/cli.ts`, `migration/guildctl/config.ts`, and the four cited `migration/test/*`
suites plus `harness-selection.test.ts`). Most line/function citations are accurate — the plan is
unusually well-grounded in real code. Two BLOCKERs survive verification, both with concrete
regression-breaking or non-compiling consequences if implemented exactly as written; four ISSUEs
and four NITs round out the rest. The env/#119 precedence choice and the #125 precedence order are
internally consistent across all three artifacts (no contradiction found there). Tests-first
structure (US1–US5 each write failing tests before implementation) is followed correctly in
`tasks.md` and satisfies constitution V.

## Findings

### B1 — BLOCKER: US2's `source: "environment"` divergence is impossible with the current type, and the natural implementation breaks an existing passing test (SC-006 violation)

**Artifacts**: `spec.md` FR-005; `plan.md` "US2" section + Risks; `tasks.md` T024.

FR-005 requires: *"A harness resolved from `GUILDCTL_HARNESS` MUST be reported as a `source:
"environment"` divergence in `resolveAgentLaunch()`."* Plan.md says to "mirror the existing
`AGENT_CMD` divergence pattern" and set `source` to `"environment"`.

This is not implementable as described, for two independent reasons, both verified against
`migration/guildctl/harness.ts`:

1. **Type mismatch.** `ConfigDivergence.source` is typed as `ConfigDivergenceSource = "ambient" |
   "project-file" | "config"` (harness.ts:45). It does **not** include `"environment"`. Plan.md's
   justification — *"`HarnessResolution.source` already admits `"environment"` (harness.ts line
   10)"* — cites the wrong type. `HarnessResolution.source` (harness.ts:6-11) is a different field
   describing *where the harness choice came from* (AGENT_CMD vs config); `ConfigDivergence.source`
   describes *where an env variable's resolved value came from* (ambient shell vs `.env` file vs
   static config), via `originOf()` (harness.ts:140), which reads `EnvOriginMap` — itself typed
   `Record<string, "ambient" | "project-file">` (env.ts, no `"environment"` member either).
   Assigning `source: "environment"` at harness.ts:144 will not type-check without first widening
   `ConfigDivergenceSource`, which no artifact mentions doing.

2. **Existing-test regression.** `HarnessResolution.source === "environment"` is true for **both**
   the existing `AGENT_CMD` path and the new `GUILDCTL_HARNESS` path (harness.ts:20-22 sets
   `source: "environment"` for `AGENT_CMD` too). The most natural reading of the plan's "insert a
   branch... set the divergence source to environment" is to key off `harness.source ===
   "environment"` — but doing so also flips the **existing, currently-passing** assertion in
   `migration/test/runtime-resolution.test.ts:409`:
   ```
   assert.equal(divergence.source, "project-file");
   ```
   (from the `AGENT_CMD` case in `"the run-start line and the launch handed to spawnAgent come from
   one resolution"`, where `origin: { AGENT_CMD: "project-file" }` is supplied). SC-006 explicitly
   requires *"no existing test in `runtime-resolution.test.ts`... is broken by the
   precedence/divergence/error-surfacing changes"* — implementing FR-005 as written breaks exactly
   this test unless the implementation disambiguates "AGENT_CMD-sourced" from
   "GUILDCTL_HARNESS-sourced" `environment` resolutions before choosing the divergence `source`,
   which no artifact calls out.

**Fix location**: `plan.md` US2 section (add a `ConfigDivergenceSource` widening step to Change B)
and `tasks.md` T024 (make explicit that the "environment" source applies only when
`env.GUILDCTL_HARNESS` — not `env.AGENT_CMD` — drove the resolution, and that
`ConfigDivergenceSource` must gain an `"environment"` member).

### B2 — BLOCKER: US3/#126's premise that "doctor never calls `checkHarness`" is factually wrong for the default (config-sourced) case; T032 is underspecified and would duplicate an existing check

**Artifacts**: `spec.md` "Source context" line re: harness.ts + US3 problem statement; `plan.md`
"US3 / #126" summary + Change A + Risks; `tasks.md` T032.

`spec.md` states: *"`checkHarness()` exists and is used by preflight's resolution stage but is
**not** invoked during `doctor`... This is #126."* `plan.md` repeats this as the premise for US3.
Reading `migration/guildctl/cli.ts:211-221` (the actual `doctor` command) shows this is only true
for the AGENT_CMD/custom-harness case:

```
// cli.ts:212-214
// The former model / harness / credential ticks are one delegated preflight,
// so a green doctor means a validated runtime path — and an offline doctor
// reports `unvalidated` instead of a tick it has not earned.
process.stdout.write("\nRuntime path:\n");
const preflight = await runPreflight({ config: cfg, root: cfg.guildRoot, offline: preflightOffline(opts.offline) });
```

`runPreflight`'s resolution stage (preflight.ts:180-183) already calls `checkHarness()` whenever
`resolution.harness.source === "config"` — i.e. exactly the default `harness: opencode` scenario in
US3 Acceptance Scenario 1 — and this check fires **before** the `offline` branch (preflight.ts:187
vs :199), so it runs even under `guildctl doctor --offline`. On failure, `doctor` already prints
`reason: active harness: opencode (opencode is missing or unreachable)` under "Runtime path:" and
exits non-zero (cli.ts:237). So SC-003/Acceptance Scenario 1 for the *default bundled harness* case
is close to already satisfied by shipped code — the genuine remaining gap is narrower than described:
the AGENT_CMD/custom-harness case, which preflight's resolution stage deliberately skips
(`if (resolution.harness.source === "config")` excludes it), plus the phase-launch boundary
(FR-008, which is a real, unaddressed gap).

Two concrete consequences for `tasks.md` T032 ("At the top of `runPipelineStateChecks`... invoke
`checkHarness(resolution.harness)`..."):

1. **Underspecified config threading.** `resolveAgentLaunch({config, root, ...})` requires a
   `GuildConfig`. `PipelineCheckContext` (doctor.ts:18-22) has no `config` field, and its only
   caller, `cli.ts:226` (`runPipelineStateChecks({ db: db(), workspaceRoot: workspaceRoot() })`),
   does not pass one. T032's file list (`migration/guildctl/doctor.ts` only) never mentions
   extending `PipelineCheckContext` or updating the `cli.ts:226` call site, both of which are
   required for the task as written to compile.
2. **Redundant/confusing double-report for the already-covered case.** For `harness: opencode`
   (source: config), T032 as written would print the *same* "active harness: ... missing or
   unreachable" failure twice — once under "Runtime path:" (existing preflight delegation) and
   again under "Pipeline state:" (new check). `plan.md`'s Risks section acknowledges the extra probe
   cost ("doctor adds one at startup") but not the duplicate user-facing message, and never notes
   that the check is already partially redundant with shipped behavior.
3. **Self-contradictory placement guidance** (plan.md only): *"At the top of
   `runPipelineStateChecks`... (doctor.ts, after line 76 or as a new early check)"*. `doctor.ts:76`
   is the closing brace of the early-return for an uninitialized registry (`if
   (!tableExists(db, "artifacts")) { ...; return checks; }`, doctor.ts:73-76) — exactly the state of
   a genuinely fresh workspace that has not yet run inventory, i.e. the primary "fresh installer"
   persona this spec targets. Placing the check "after line 76" would skip it for that case. "At the
   top" and "after line 76" are different, contradictory locations with different behavior for the
   spec's own primary scenario.

**Fix location**: `plan.md` US3 "Change A" (correct the premise to scope the doctor-side gap to the
AGENT_CMD/custom-harness case and the phase-launch boundary; resolve the placement contradiction;
add config-threading steps) and `tasks.md` T032 (add `PipelineCheckContext.config` +
`cli.ts:226` update to the task's file list; pin insertion point above doctor.ts:60, before the
`tableExists` early return).

## Issues

### I1 — ISSUE: FR-013 is a MUST but is placed entirely in the "Incremental" (post-MVP) phase

**Artifacts**: `spec.md` FR-013 ("`HARNESS.md` and `GETTING-STARTED.md` **MUST** be updated...");
`plan.md` "MVP vs Incremental Boundaries" (docs listed under Incremental); `tasks.md` Phase 6 +
"MVP vs Incremental Boundaries" (T060-T062 excluded from the MVP task set, SC-007 excluded from the
MVP's satisfied-SC list).

A requirement stated with MUST-strength in the mandatory Requirements section is explicitly
deferred out of the approvable MVP in both `plan.md` and `tasks.md`. This is a direct boundary
contradiction: the MVP is described as "Approvable on its own" (tasks.md, "MVP vs Incremental
Boundaries") while knowingly not satisfying FR-013/SC-007. Either FR-013 should be downgraded to
SHOULD for the MVP milestone, or Phase 6 should move into the MVP set. **Fix location**: `spec.md`
FR-013 wording, or `plan.md`/`tasks.md` MVP boundary sections — pick one and align both.

### I2 — ISSUE: harness stderr length cap is an open question in `plan.md` that `tasks.md` never resolves

**Artifacts**: `plan.md` "Open Questions" ("Length cap for captured stderr... exact constant to be
finalized in `tasks.md`"); `tasks.md` T052.

The raw-body excerpt for US4 gets a concrete constant (`bodyText.slice(0,512)`, plan.md Change A,
carried into T044). The harness-stderr cap for US5 does not: T052 only says "trimmed and
length-capped for readability" with no number. `tasks.md` was supposed to be where this open
question closes (per plan.md's own text) but it doesn't. Without a pinned value, T050/T054's
regression assertions on captured-stderr content have no boundary to test against precisely.
**Fix location**: `tasks.md` T052 — add an explicit cap (e.g. mirror the 512-char body cap, or state
a different constant and reference it from T050).

### I3 — ISSUE: `harness-selection.test.ts` directly exercises the two functions this spec modifies but is absent from every regression list

**Artifacts**: `plan.md` Testing Strategy / SC-006; `tasks.md` T075 (regression guard).

`migration/test/harness-selection.test.ts` tests `resolveHarness()` (US2's target function,
including the exact "opencode is the default... AGENT_CMD overrides it" and "Unknown harness"
throw paths) and `checkHarness()` (US3's target function, including a "doctor harness check flags a
missing selected command" test whose intent nearly duplicates the new US3 doctor test). Neither
`plan.md`'s Project Structure/Testing Strategy sections nor `tasks.md` T075 ("assert existing cases
in `runtime-resolution.test.ts`, `env-precedence.test.ts`, `preflight-resolved-path.test.ts`,
`doctor-pipeline-state.test.ts` remain green") name this file. SC-006 makes the same omission. This
is a real regression-coverage gap on a file that is trivially likely to be affected by the
`resolveHarness()` precedence change (B1/US2) and the `checkHarness()` call-site changes (B2/US3).
**Fix location**: `tasks.md` T075 and `spec.md` SC-006 — add `harness-selection.test.ts` to the
regression-guard file list.

### I4 — ISSUE: two inaccurate line citations in `spec.md`'s "Source context" narrative for #119

**Artifact**: `spec.md` lines 21-22 (Source context, `env.ts` bullet).

- *"`fileValues[key] = ""` (line 165)"* — env.ts:165 is inside the **install-candidate** loop
  (`for (const [key, value] of Object.entries(parseCandidate(candidate)))`, env.ts:165-168), which
  explicitly skips keys already present (`if (key in fileValues) continue;`, env.ts:166) — it cannot
  be where an empty *workspace* `.env` value enters `fileValues`. The actual mechanism is the spread
  `const fileValues: Record<string, string> = { ...project };` at env.ts:157, where `project` was
  parsed at env.ts:154.
- *"target[key] = "" replaces a working ambient value (line 197 `if (fileWins)`)"* — the actual
  `if (fileWins)` is at env.ts:196, not 197 (line 197 is `target[key] = value;`, one line inside the
  block).

Neither error affects the correct fix location the plan/tasks actually cite (env.ts:192-203 and
:174-187 are both accurate), so this doesn't block implementation, but it's worth correcting since
the constitution's Principle I (Evidence Over Assertion) is the explicit governing rationale for
this spec's own "Source context" section. **Fix location**: `spec.md` lines 21-22.

## Nits

### N1 — NIT: garbled expected-value phrasing in `plan.md`'s US2 test description

`plan.md` Testing Strategy: *"`resolveHarness({ ...config, harness: "codex" }, root, {
GUILDCTL_HARNESS: "opencode" })` → `name === "openai"`-equivalent `"opencode"` (env wins)."* The
`"openai"`-equivalent aside is confusing/likely a leftover edit; the assertion is simply `name ===
"opencode"`. Tasks.md T020 states it correctly without the stray phrase. **Fix location**: `plan.md`
US2 Testing Strategy bullet.

### N2 — NIT: SC-007 is verified by human read-through, not by an automated test

`spec.md` SC-007: *"verified by a maintainer read-through."* Unlike SC-001..SC-006 (all backed by
`migration/test/*` assertions), SC-007 has no automatable check — reasonable for prose-accuracy
criteria, but worth flagging since it's the one Success Criterion in this spec that isn't pinned by
a regression test, slightly at odds with the Assumption that "the unit/injected tests... are the
primary gate." Not a defect; a documentation note would suffice.

### N3 — NIT: `plan.md`'s US3 Change B cites a launch-path insertion point ~150 lines from the actual `spawn()` call

`plan.md`: *"Before spawning (around runner.ts line 391...)"*. `runner.ts:391` is
`const agentCommand = launch.harness.command;`, immediately after `launch` resolution (runner.ts:390)
— a defensible fail-fast location — but the real `spawn(...)` call is at `runner.ts:541`, ~150 lines
later. The citation could mislead a reader into expecting the spawn call itself to be nearby.
**Fix location**: `plan.md` US3 Change B — clarify "runner.ts:390-391, well before the spawn call at
:541" rather than implying proximity.

### N4 — NIT: `resolveAgentLaunch() 142–145` citation in `spec.md`/`plan.md` refers to a sub-block, not the function

The function itself spans harness.ts:124-164; lines 142-145 are only the pre-existing harness-
divergence `if` block inside it. The content described at that range is accurate, but "`
resolveAgentLaunch() (lines 142–145)`" reads as if it were the whole function signature/body.
**Fix location**: `spec.md` line 23, `plan.md` line 14 — reword to "the harness-divergence block in
`resolveAgentLaunch()` (lines 142-145)".

## Verified-Accurate Citations (no issue — spot-checked for the report)

- `env.ts`: `loadGuildEnvironment()` precedence loop (192-203) ✓, divergence computation (174-187) ✓,
  `EnvDivergence` interface (39-47) ✓.
- `harness.ts`: `resolveHarness()` (19-38) ✓, `config.harness` read (24) ✓, `Unknown harness` throw
  (37) ✓, `checkHarness()` (166-180) ✓, `GuildConfig.harness: string` in config.ts (10) ✓.
- `preflight.ts`: `completionText()` (116-120) ✓, `redactCredential()` (84) ✓, malformed-body return
  (277) ✓, parse block (273-284) ✓, connection-error branch (252-255) ✓.
- `doctor.ts`: `runPipelineStateChecks()` (56-247) ✓.
- `commands/auto.ts`: spawn + bare exit-code throw (395-440) ✓, exact throw text match at 440 ✓.
- `runner.ts`: `summarizeRunFailures()` (360-376) ✓, `spawnAgent()` launch resolution (390) ✓.
- `migration/test/doctor-pipeline-state.test.ts`: `runPipelineStateChecks` import (8) ✓,
  `fixtureRoot` (23) ✓, "doctor command exits non-zero..." test (248) ✓.
- `migration/test/harness-selection.test.ts`: "doctor harness check flags a missing selected
  command" test (28-32/33) ✓ — see I3 for why this file's *absence from the plan's scope* is still a
  finding.
- #119/#125 precedence choices (ambient-preferred-with-warning; env > config > default) are
  consistent across `spec.md` Assumptions, `plan.md`, and `tasks.md` — no contradiction found.
- Tests-first ordering (tests before implementation, per user story) is followed correctly in every
  phase of `tasks.md`.
- No scope creep found beyond the five tracked sub-issues (#119, #125, #126, #120, #121); all FRs
  and tasks trace to one of them or to FR-013/FR-014 (docs/regression umbrella requirements).

## Coverage Summary

| Requirement | Task(s) | Notes |
|---|---|---|
| FR-001..FR-003 (#119) | T010-T014 | Covered; tests-first |
| FR-004..FR-006 (#125) | T020-T026 | Covered, but see B1 (FR-005 not implementable as specified) |
| FR-007..FR-008 (#126) | T030-T034 | Covered, but see B2 (premise/placement/config-threading gaps) |
| FR-009..FR-010 (#120) | T040-T045 | Covered; tests-first |
| FR-011..FR-012 (#121) | T050-T054 | Covered; see I2 (stderr cap unresolved) |
| FR-013 (docs) | T060-T062 | Covered, but see I1 (MUST deferred to Incremental) |
| FR-014 (regression tests) | all Txxx test tasks | Covered; see I3 (harness-selection.test.ts omitted from the guard list) |
| SC-001..SC-005 | T070-T074 | Covered |
| SC-006 (regression guard) | T075-T076 | Gap: harness-selection.test.ts not listed (I3); B1's fix, if naive, would itself break SC-006 |
| SC-007 (docs accuracy) | T062 | Covered but manual-only (N2) |

**Metrics**: 14 FRs, 7 SCs, 24 numbered tasks (+ checkpoints/verify tasks) — 100% have at least one
mapped task. 2 BLOCKER, 4 ISSUE, 4 NIT findings.

## Next Actions

- **Resolve B1 and B2 before `/speckit-implement`** on US2 and US3 — both are compile/regression-
  breaking as currently specified, not just wording problems.
- I1-I4 should be fixed but don't block starting US1/US4 (which have no BLOCKER findings) or Phase 0
  scaffolding.
- Suggested commands: edit `plan.md` US2/US3 sections and `tasks.md` T024/T032/T052/T075 directly (no
  regeneration needed — the changes are localized); re-run `/speckit-analyze` after edits to confirm
  B1/B2 clear.

Would you like concrete remediation edits drafted for B1 and B2 (the two blockers)?
