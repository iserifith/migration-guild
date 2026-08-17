# Tasks: Spec 010 — Fix Provider/Harness Resolution

Format: `- [ ] [T###] [P?] [US#?] description (repo file path)`

Scope: kit runtime fixes across `migration/guildctl/` (env/harness/preflight/doctor/runner/commands) + five regression tests in `migration/test/`. No fixture or workspace change (FR scope). MVP = US1+US2+US3+US4 (P1) + their tests + verify; INCREMENTAL = US5 (P2) harness-stderr surfacing + HARNESS.md/GETTING-STARTED.md docs pass (FR-013).

## Phase 0 — Setup & Test Scaffolding (Prerequisites)

**Purpose**: install deps if needed and scaffold the new test file; no story code yet.

- [ ] [T001] [P1] [US5] Ensure `migration/` deps present (`npm install` in migration/ if node_modules absent) so `node:test` suites run (migration/)
- [ ] [T002] [P1] [US5] Scaffold new test file `migration/test/harness-stderr.test.ts` with imports/fixtures (injected harness spawn via temp stub CLI script, mirroring `runtime-resolution.test.ts` lines 306–343) — empty cases, will fail until US5 impl lands (migration/test/harness-stderr.test.ts)
- [ ] [T003] [P1] [US1] Confirm shared test fixtures reusable: `makeTempDir`, `cliFixture`, `DEFAULT_GUILD_CONFIG`, `truthful-run-state-fixtures`, in-memory `Database` + `applySchema` helpers (migration/test/)

## Phase 1 — US1: Empty `.env` value must not discard working ambient credential (P1, MVP)

**Goal**: `loadGuildEnvironment()` prefers a working ambient credential over an empty `.env` value (Fail-Closed, constitution VI) and surfaces the empty-but-defined case in divergences.

**Independent Test**: with `process.env.NINE_ROUTER_API_KEY=<working>` and a workspace `.env` containing `NINE_ROUTER_API_KEY=` (empty), `loadGuildEnvironment()` resolves the ambient value OR emits a named warning; `preflight` never reports HTTP 401.

### Tests for US1 (write FIRST, must FAIL before impl) ⚠️

- [ ] [T010] [P1] [US1] Add regression case to `migration/test/env-precedence.test.ts`: ambient `NINE_ROUTER_API_KEY=<working>` + empty `.env` `NINE_ROUTER_API_KEY=` → resolved value is the working ambient value AND `envDivergences()` has entry `variable==="NINE_ROUTER_API_KEY"` with `emptyButDefined===true` (migration/test/env-precedence.test.ts)
- [ ] [T011] [P1] [US1] Add regression case to `migration/test/env-precedence.test.ts`: an UNSET key (absent from `.env`) vs an EMPTY key (present, blank) produce distinct divergence shapes — `emptyButDefined` true only for the empty case (migration/test/env-precedence.test.ts)

### Implementation for US1

- [ ] [T012] [P1] [US1] In `migration/guildctl/env.ts` `loadGuildEnvironment()` (lines 192–203) add `isEmpty()` helper and precedence so an empty project value with a non-empty ambient value prefers the ambient value (`target[key]=ambientValue; origin[key]="ambient"`) — FR-001/FR-002 (migration/guildctl/env.ts)
- [ ] [T013] [P1] [US1] Extend `EnvDivergence` type (env.ts lines 39–47) with `emptyButDefined?: boolean`; in divergence reporting (lines 174–187) flag empty-but-defined distinctly from unset with a named message (FR-003) (migration/guildctl/env.ts)
- [ ] [T014] [P1] [US1] Verify T010/T011 now pass by running `migration/test/env-precedence.test.ts` with `node --test` — done when both new cases are green and no existing case in that file is broken (migration/test/env-precedence.test.ts)

**Checkpoint**: US1 independently functional — empty `.env` value no longer discards a working ambient credential, divergence warns, no silent 401.

## Phase 2 — US2: `GUILDCTL_HARNESS` env var must switch the harness (P1, MVP)

**Goal**: `resolveHarness()` honors `GUILDCTL_HARNESS` with precedence `env > config > default`, reports it as a `source:"environment"` divergence, and throws the named unknown-harness error.

**Independent Test**: `resolveHarness(config_without_harness, root, { GUILDCTL_HARNESS: "goose" })` returns `name==="goose"`, `source==="environment"`; `doctor`/`runtime-report` lists it as a harness divergence.

### Tests for US2 (write FIRST, must FAIL before impl) ⚠️

- [ ] [T020] [P1] [US2] Add regression cases to `migration/test/runtime-resolution.test.ts`: `resolveHarness(DEFAULT_GUILD_CONFIG, root, { GUILDCTL_HARNESS: "goose" })` → `name==="goose"`, `source==="environment"`; `resolveHarness({...config, harness:"codex"}, root, { GUILDCTL_HARNESS:"opencode" })` → env wins (migration/test/runtime-resolution.test.ts)
- [ ] [T021] [P1] [US2] Add regression case to `migration/test/runtime-resolution.test.ts`: `resolveAgentLaunch({ config, root, env:{ GUILDCTL_HARNESS:"goose" } }).divergences` contains a `harness` entry with `source==="environment"` (mirrors existing AGENT_CMD divergence test lines 103–119) (migration/test/runtime-resolution.test.ts)
- [ ] [T022] [P1] [US2] Add regression case to `migration/test/runtime-resolution.test.ts`: `resolveHarness(config, root, { GUILDCTL_HARNESS:"bogus" })` throws `/Unknown harness/` (extends existing throw test line 293) (migration/test/runtime-resolution.test.ts)

### Implementation for US2

- [ ] [T023] [P1] [US2] In `migration/guildctl/harness.ts` `resolveHarness()` (lines 19–24) insert `GUILDCTL_HARNESS` branch: `const name = env.GUILDCTL_HARNESS || config.harness || "opencode"` (AGENT_CMD branch unchanged) — FR-004 (migration/guildctl/harness.ts)
- [ ] [T024] [P1] [US2] In `migration/guildctl/harness.ts` `resolveAgentLaunch()` (lines 142–145) key the harness divergence on `env.GUILDCTL_HARNESS` via the existing `originOf()`/`envOrigin` path (do NOT widen `ConfigDivergenceSource` = `"ambient" | "project-file" | "config"`, harness.ts line 45); set `declaredValue`/`resolvedValue`; MUST NOT flip the existing passing assertion `divergence.source === "project-file"` at `runtime-resolution.test.ts:409` (which supplies `origin: { AGENT_CMD: "project-file" }`) — FR-005 (migration/guildctl/harness.ts)
- [ ] [T025] [P1] [US2] Confirm unknown-value path reuses existing named throw (line 37) listing goose/opencode/codex/copilot — FR-006 (no new branch) (migration/guildctl/harness.ts)
- [ ] [T026] [P1] [US2] Verify T020/T021/T022 now pass by running `migration/test/runtime-resolution.test.ts`; done when all three new cases green and existing AGENT_CMD/default assertions unaffected (migration/test/runtime-resolution.test.ts)

**Checkpoint**: US2 independently functional — `GUILDCTL_HARNESS` switches the harness and is reported as an environment divergence.

## Phase 3 — US3: Missing harness CLI caught early, not mid-run (P1, MVP)

**Goal**: `guildctl doctor` invokes `checkHarness()` for the resolved harness as a non-green blocking finding, and the phase-launch path consults the same result before spawning.

**Independent Test**: `checkHarness(resolveHarness(...))` / `guildctl doctor` against a config whose harness CLI is absent → `{ ok:false }` naming the missing command; doctor exits non-zero / reports blocking finding.

### Tests for US3 (write FIRST, must FAIL before impl) ⚠️

- [ ] [T030] [P1] [US3] Add regression case to `migration/test/doctor-pipeline-state.test.ts`: workspace resolving `harness: opencode` with `opencode` absent from PATH (missing adapter/file) → `runPipelineStateChecks` yields `CheckResult` with `status==="fail"` and message matching `/active harness: opencode.*missing or unreachable/` (migration/test/doctor-pipeline-state.test.ts)
- [ ] [T031] [P1] [US3] Add inverse regression case to `migration/test/doctor-pipeline-state.test.ts`: harness CLI present → `status==="pass"` (migration/test/doctor-pipeline-state.test.ts)

### Implementation for US3

- [ ] [T032] [P1] [US3] In `migration/guildctl/doctor.ts` `runPipelineStateChecks()` (lines 56–247) import `resolveAgentLaunch`/`checkHarness` and `PipelineCheckContext` (doctor.ts lines 18–22; ensure `cli.ts:226` passes `config` into the context). Invoke `checkHarness(resolution.harness)` at the **top of the function, BEFORE the `tableExists` early-return (lines 73–76)** so a fresh workspace (no registry db) is still covered; push a `fail`/`pass` `CheckResult` reusing `checkHarness`'s message — FR-007. Scope to the custom/AGENT_CMD harness case (the config-sourced case is already covered by the preflight delegation in `doctor`); do not duplicate that path (migration/guildctl/doctor.ts, migration/guildctl/cli.ts)
- [ ] [T033] [P1] [US3] In launch path `migration/guildctl/commands/auto.ts` (lines 395–440) and `migration/guildctl/runner.ts` (`spawnAgent`) consult `checkHarness(launch.harness)` once before spawning; if `!ok`, throw named `active harness: <name> (<command> missing or unreachable)` at the boundary instead of mid-run exit 1 — FR-008 (migration/guildctl/commands/auto.ts, migration/guildctl/runner.ts)
- [ ] [T034] [P1] [US3] Verify T030/T031 now pass; done when doctor-pipeline-state missing-harness finding is non-green and no existing check in that file is broken (migration/test/doctor-pipeline-state.test.ts)

**Checkpoint**: US3 independently functional — missing harness CLI fails clearly at doctor and at phase-launch boundary.

## Phase 4 — US4: Preflight tolerates response-shape variation and logs raw body (P1, MVP)

**Goal**: `runPreflight()` passes valid-but-variant completions and, on a non-parseable body, fails with a redacted, length-capped raw-body excerpt and a shape-specific message distinct from "provider unreachable".

**Independent Test**: `runPreflight()` with injected `fetchImpl` returning extra-field completion → verdict `pass`; unparseable body → `failedStage==="response"` with redacted excerpt + shape phrase; never the old literal "provider returned a malformed response body".

### Tests for US4 (write FIRST, must FAIL before impl) ⚠️

- [ ] [T040] [P1] [US4] Add regression case to `migration/test/preflight-resolved-path.test.ts`: injected `fetchImpl` returns `200` with extra top-level fields (`usage`, `id`, `system_fingerprint`) + valid `choices[0].message.content` → `verdict==="pass"` (migration/test/preflight-resolved-path.test.ts)
- [ ] [T041] [P1] [US4] Add regression case to `migration/test/preflight-resolved-path.test.ts`: injected `fetchImpl` returns `200` with minor non-standard but parseable shape (e.g. `delta.content` style) → still `verdict==="pass"` (migration/test/preflight-resolved-path.test.ts)
- [ ] [T042] [P1] [US4] Add regression case to `migration/test/preflight-resolved-path.test.ts`: injected `fetchImpl` returns `200` non-JSON body → `verdict==="fail"`, `failedStage==="response"`, `reason` contains redacted length-capped excerpt AND a "shape"/"could not be parsed" phrase, and does NOT contain `"provider returned a malformed response body"` (migration/test/preflight-resolved-path.test.ts)

### Implementation for US4

- [ ] [T043] [P1] [US4] In `migration/guildctl/preflight.ts` `completionText()` (lines 116–120) add tolerant fallbacks (e.g. `choices[0].delta?.content`) so extra/unknown fields and minor shapes still extract completion — FR-009 (migration/guildctl/preflight.ts)
- [ ] [T044] [P1] [US4] In `migration/guildctl/preflight.ts` `runPreflight()` parse branch (lines 273–284) on `JSON.parse` catch, wrap `bodyText.slice(0,512)` in `redactCredential()` (line 84) and call `liveFailure("response", "provider returned a response shape that could not be parsed: <excerpt>")` — FR-010/FR-019 (migration/guildctl/preflight.ts)
- [ ] [T045] [P1] [US4] Verify T040/T041/T042 now pass; done when shape-tolerant pass + raw-body excerpt cases are green and connection-error "provider request failed" path is distinct (migration/test/preflight-resolved-path.test.ts)

**Checkpoint**: US4 independently functional — preflight tolerates shape variation, logs raw body on parse failure, distinguishes shape vs unreachable.

## Phase 5 — US5: Underlying harness stderr surfaced, not bare exit code (P2, INCREMENTAL)

**Goal**: harness launch/runner spawn captures stdout+stderr and includes it (plus harness name + exit code) in the failure message; no provider/harness-specific branching (constitution VII).

**Independent Test**: a `codex`/`goose` harness launch whose CLI fails on `/v1/models` (via injected spawn of a stub script) surfaces captured stderr substring `failed to decode models response: missing field models` in the kit's failure message, not `exited with code 1`.

### Tests for US5 (write FIRST, must FAIL before impl) ⚠️

- [ ] [T050] [P2] [US5] In `migration/test/harness-stderr.test.ts` (scaffolded T002) add case: spawn harness via runner/auto path directed at a stub CLI that exits non-zero after writing `failed to decode models response: missing field models` to stderr → captured result/thrown error includes harness `name`, non-zero `exitCode`, and verbatim stderr substring (migration/test/harness-stderr.test.ts)
- [ ] [T051] [P2] [US5] In `migration/test/harness-stderr.test.ts` add inverse case: stub exits 0 with empty stderr → no error, proceeds normally (fix only improves surfacing) (migration/test/harness-stderr.test.ts)

### Implementation for US5

- [ ] [T052] [P2] [US5] In `migration/guildctl/commands/auto.ts` harness spawn (lines 395–440) buffer stdout/stderr instead of piping only to terminal; cap the surface at `stdoutStderr.slice(0,512)` (matches the 512-char raw-body cap in preflight.ts lines 101–105) and on `exitCode !== 0` throw `${phase} worker (${harness.name}) exited with code ${exitCode}: ${stdoutStderr}` with verbatim captured text — FR-011 (migration/guildctl/commands/auto.ts)
- [ ] [T053] [P2] [US5] In `migration/guildctl/runner.ts` `spawnAgent` thread captured stdout+stderr through result/error so `summarizeRunFailures` (runner.ts lines 360–376) can include it; no provider/harness branch — FR-012 (migration/guildctl/runner.ts)
- [ ] [T054] [P2] [US5] Verify T050/T051 now pass; done when harness stdout+stderr surfaces verbatim and working-provider case is unaffected (migration/test/harness-stderr.test.ts)

**Checkpoint**: US5 independently functional — underlying harness stderr is surfaced with harness name + exit code, no bare exit code.

## Phase 6 — Documentation (INCREMENTAL, FR-013 — MUST in spec, delivered as SHOULD-for-MVP)

**Purpose**: document corrected precedence/behavior so onboarding matches runtime.

- [ ] [T060] [P1] [US1] Update `HARNESS.md` to document corrected `GUILDCTL_HARNESS` precedence (`env > config > default`), empty-vs-unset `.env` credential behavior, and the installed-harness-CLI requirement (or `doctor` fails closed) — FR-013 (HARNESS.md)
- [ ] [T061] [P1] [US2] Update `GETTING-STARTED.md` mirroring the same precedence/empty-credential/installed-CLI guidance for fresh installers — FR-013 (GETTING-STARTED.md)
- [ ] [T062] [P1] [US3] Maintainer read-through of `HARNESS.md` + `GETTING-STARTED.md` confirming SC-007 accuracy (HARNESS.md, GETTING-STARTED.md)

## Phase 7 — Verify & Regression Gate (MVP verify + full suite)

**Purpose**: confirm all stories green, no regression in shared test files, SC-001..SC-007.

- [ ] [T070] [P1] [US1] Run `npm test` in `migration/`; confirm `env-precedence.test.ts` green (SC-001) (migration/test/)
- [ ] [T071] [P1] [US2] Run `npm test`; confirm `runtime-resolution.test.ts` green + env divergence reported (SC-002) (migration/test/)
- [ ] [T072] [P1] [US3] Run `npm test`; confirm `doctor-pipeline-state.test.ts` green + boundary check (SC-003) (migration/test/)
- [ ] [T073] [P1] [US4] Run `npm test`; confirm `preflight-resolved-path.test.ts` green (SC-004) (migration/test/)
- [ ] [T074] [P2] [US5] Run `npm test`; confirm `harness-stderr.test.ts` green (SC-005) (migration/test/)
- [ ] [T075] [P1] [US1] Regression guard (SC-006): assert existing cases in `runtime-resolution.test.ts`, `env-precedence.test.ts`, `preflight-resolved-path.test.ts`, `doctor-pipeline-state.test.ts`, and `harness-selection.test.ts` (which directly tests `resolveHarness()`/`checkHarness()`, incl. the AGENT_CMD divergence `source === "project-file"` at line 409 and the "doctor harness check flags a missing selected command" case) remain green after precedence/divergence/error-surfacing changes (migration/test/)
- [ ] [T076] [P1] [US1] Full `npm test` in `migration/` passes end-to-end with all five new/extended suites; report any broken pre-existing case (migration/)

## Dependencies & Execution Order

### Phase Dependencies
- **Phase 0 (Setup/Scaffold)**: no deps; T002 scaffolds `harness-stderr.test.ts` used by Phase 5.
- **Phase 1–4 (US1–US4, MVP)**: each depends on Phase 0; may proceed sequentially in priority order (all P1). Touch independent files (`env.ts`, `harness.ts`, `preflight.ts`, `doctor.ts`/`runner.ts`/`auto.ts`) — US2 and US3 both edit `harness.ts`/`auto.ts`/`runner.ts` so sequence US2→US3 avoids re-entrancy; US4 (`preflight.ts`) is fully independent and could run in parallel with US1/US2/US3.
- **Phase 5 (US5, INCREMENTAL)**: depends on Phase 0; edits `commands/auto.ts`/`runner.ts` (same files as US3 T033) — run after US3 to avoid same-file conflict.
- **Phase 6 (Docs, INCREMENTAL)**: depends on US1/US2/US3 landing so docs match behavior (FR-013).
- **Phase 7 (Verify)**: depends on all desired phases; MVP = Phases 0–4 + 7 minus US5; full = all phases.

### Within Each User Story
- Tests (T010/T011, T020–T022, T030/T031, T040–T042, T050/T051) MUST be written and FAIL before implementation tasks.
- Implementation follows; verification task (T014/T026/T034/T045/T054) proves the story's independent test is green.

### Parallel Opportunities
- US4 (`preflight.ts`) is file-independent from US1 (`env.ts`) and can run in parallel with Phase 1.
- US3 and US2 share `harness.ts`/`auto.ts`/`runner.ts` — sequence US2 then US3 (no parallel same-file edit).
- Phase 6 docs are independent of Phase 5 implementation and can run alongside it once US1/US2/US3 behavior is settled.

### MVP vs Incremental Boundaries
- **MVP** = Phase 0 + Phase 1 (US1) + Phase 2 (US2) + Phase 3 (US3) + Phase 4 (US4) + Phase 7 verify (T070–T073, T075–T076). Satisfies SC-001..SC-004, SC-006. Approvable on its own. (FR-013 docs is a MUST in the spec but intentionally delivered in the Incremental/docs step — SHOULD-for-MVP milestone; SC-007 is verified by maintainer read-through, no automated gate.)
- **INCREMENTAL** = Phase 5 (US5, P2) harness-stderr surfacing (SC-005) + Phase 6 docs (FR-013, SC-007) + T074. Sequenced after MVP; deeper no-model-refresh mode is OUT of scope.
