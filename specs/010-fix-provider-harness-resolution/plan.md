# Implementation Plan: Fix Provider/Harness Resolution (Onboarding Hardening, Wave 3)

**Branch**: `010-fix-provider-harness-resolution` | **Date**: 2026-08-17 | **Spec**: `specs/010-fix-provider-harness-resolution/spec.md` | **Tracking**: issue #132

**Input**: Feature specification from `/specs/010-fix-provider-harness-resolution/spec.md` (US1–US5, FR-001..FR-014, SC-001..SC-007, Assumptions).

**Note**: This plan is non-implementation. It edits no app source, runs no build, and commits nothing. Its sole deliverable is this `plan.md`; `tasks.md` (the checkbox-phase decomposition) is produced later by `$speckit-tasks`.

## Summary

The feature hardens the kit's run-time resolution path so a fresh installer can tell whether their setup reaches a model. Five sub-issues each map to one user story and one or more exact code locations:

- **US1 / #119** — `loadGuildEnvironment()` in `migration/guildctl/env.ts` (lines 193–203) lets an empty `.env` value overwrite a working ambient value, and divergence reporting (lines 174–187) never flags "empty-but-defined". Fix: distinguish empty from unset, prefer the working ambient value (Fail-Closed, constitution VI) or emit a named warning, and surface the empty-but-defined case in divergences.
- **US2 / #125** — `resolveHarness()` in `migration/guildctl/harness.ts` (lines 19–38) reads `config.harness || "opencode"` and never reads `GUILDCTL_HARNESS`. Fix: precedence `GUILDCTL_HARNESS > config.harness > "opencode"`, with the env-sourced harness reported as a `source: "environment"` divergence in `resolveAgentLaunch()` (mirroring the existing `AGENT_CMD` pattern, lines 142–145), and an unknown value throwing the existing named error (line 37).
- **US3 / #126** — `checkHarness()` (`harness.ts` lines 166–180) exists and is used by preflight's resolution stage but never by `doctor` or at phase launch. Fix: `runPipelineStateChecks()` in `doctor.ts` invokes `checkHarness` for the resolved harness as a blocking (non-green) finding; the launch path consults the same result before starting an LLM-backed phase.
- **US4 / #120** — `runPreflight()` (`preflight.ts` lines 273–284, `completionText` lines 116–120) does a single `JSON.parse` and on failure returns `"provider returned a malformed response body"` with no raw-body capture. Fix: response-shape tolerance (extra/unknown fields and minor non-streamed shape differences still pass) plus a redacted, length-capped raw-body excerpt on parse failure, distinguishing "response shape unexpected" from the existing "provider unreachable" connection path.
- **US5 / #121** — the harness spawn in `commands/auto.ts` (lines 395–440) and the runner's spawn path capture stdout/stderr but the failure message is bare (`${phase} worker exited with code ${outcome.exitCode ?? 1}`, line 440). Fix: surface captured stdout+stderr verbatim (plus harness name + exit code), with no provider/harness-specific branching (constitution VII).

## Technical Context

**Language/Version**: TypeScript (Node 18+), compiled via the existing `migration/` tsx/tsc toolchain; tests run on the built-in `node:test` runner.

**Primary Dependencies**: `child_process` (spawn/spawnSync), `dotenv` (parse), `better-sqlite3` (doctor registry reads). All already present in `migration/`.

**Storage**: SQLite registry (`better-sqlite3`) — read-only by `doctor.ts`; no schema change for this feature.

**Testing**: `node:test` (assert/strict) under `migration/test/`, run via `npm test` in `migration/`. Existing fixtures (`makeTempDir`, `cliFixture`, `DEFAULT_GUILD_CONFIG`, `truthful-run-state-fixtures`) are reused.

**Target Platform**: Linux/macOS/Windows CLI (`guildctl`), Node process.

**Project Type**: CLI runtime library (`migration/guildctl/`) + its regression suite (`migration/test/`).

**Performance Goals**: No new per-artifact spawning of harness `--version` probes; `doctor` and phase launch reuse a single `checkHarness` result (Assumption edge case in spec §Edge Cases: "checkHarness is already called in preflight's resolution stage; doctor reuses the same function").

**Constraints**: Per spec Assumption — kit runtime changes only; MUST NOT modify `package/mock/` or any migration workspace. Per constitution VII, no provider/harness-specific branching beyond the bundled-adapter set (goose/opencode/codex/copilot). Per constitution VI, Fail-Closed: never silently discard a working credential, secrets redacted via existing `redactCredential`/`isSensitiveEnvName`.

**Scale/Scope**: Five targeted fixes across four modules (`env.ts`, `harness.ts`, `preflight.ts`, `doctor.ts`) and the `commands/auto.ts` runner path, plus five regression test files. No new schemas, no new fixtures.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after design.*

| Principle | Status | Evidence in plan |
|-----------|--------|------------------|
| I — Evidence Over Assertion | PASS | Every change cites exact `file:function` and line ranges; tests assert real resolver output (resolved credential value, divergence entries, preflight `reason`), not developer claims. |
| V — Tests Before Production Code | PASS | All five fixes gated by new/extended `migration/test/*` cases using injected `fetchImpl` and harness spawn — no live provider required (Assumption: "the unit/injected tests in `migration/test/` are the primary gate"). |
| VI — Fail-Closed Automation | PASS | US1 prefers working ambient over empty `.env` (or named warning, never silent 401); US3 missing harness is a blocking finding; US4/US5 surface root cause rather than swallow it. |
| VII — Pluggable Stacks, Neutral Providers | PASS | US2 precedence mirrors existing `AGENT_CMD > config`; US5 passes harness stderr verbatim with no 9router/codex-specific branch; `GUILDCTL_HARNESS` joins `AGENT_CMD` as a neutral selection escape hatch. |
| (no new violations) | — | No added projects, no new external services, no new redaction path (reuses `redactCredential`). |

## Project Structure

### Documentation (this feature)

```text
specs/010-fix-provider-harness-resolution/
├── plan.md              # This file ($speckit-plan command output)
├── research.md          # Phase 0 output ($speckit-plan command)
├── data-model.md        # Phase 1 output ($speckit-plan command)
├── quickstart.md        # Phase 1 output ($speckit-plan command)
├── contracts/           # Phase 1 output ($speckit-plan command)
└── tasks.md             # Phase 2 output ($speckit-tasks command - NOT created by $speckit-plan)
```

### Source Code (repository root)

```text
migration/guildctl/
├── env.ts               # US1: loadGuildEnvironment() lines 174–203
├── harness.ts           # US2/US3: resolveHarness() 19–38, resolveAgentLaunch() 142–145, checkHarness() 166–180
├── preflight.ts         # US4: runPreflight() 273–284, completionText() 116–120, redactCredential() 84
├── doctor.ts            # US3: runPipelineStateChecks() 56–247
├── runner.ts            # US5: spawnAgent() failure propagation
└── commands/auto.ts     # US5: harness spawn + failure throw, lines 395–440

migration/test/
├── env-precedence.test.ts          # EXTEND (US1: empty-vs-unset, FR-001..FR-003)
├── runtime-resolution.test.ts      # EXTEND (US2: GUILDCTL_HARNESS divergence, FR-004..FR-006)
├── preflight-resolved-path.test.ts # EXTEND (US4: shape tolerance + raw-body log, FR-009..FR-010)
├── doctor-pipeline-state.test.ts   # EXTEND (US3: blocking missing-harness finding, FR-007)
└── harness-stderr.test.ts          # NEW (US5: captured stdout+stderr surfaced, FR-011..FR-012)
```

**Structure Decision**: No new directories; all changes land in the existing `migration/guildctl/` modules that already own resolution, live-check, doctor, and runner concerns. Test files follow the established `migration/test/*.test.ts` flat layout; four are extended, one (`harness-stderr.test.ts`) is new.

## Technical Approach Per User Story

### US1 — Empty `.env` value must not discard a working ambient credential (#119, FR-001..FR-003)

**Module**: `migration/guildctl/env.ts`, `loadGuildEnvironment()`.

**Current behavior**: Step 4 (lines 192–203) iterates `fileValues` and, for `fileWins` (ambient unset OR project mode + key in project), writes `target[key] = value` — where `value` may be `""`. Step 3 divergence reporting (lines 174–187) only compares `projectValue !== ambientValue` and treats an empty project value as a normal (non-empty-flagged) divergence. So `NINE_ROUTER_API_KEY=` in `.env` overwrites a working shell value, and nothing warns about the empty-but-defined case.

**Change A — distinguish empty from unset (lines 192–203)**: Introduce an `isEmpty(value)` helper (`value === ""` for string values; the loader only deals with string dotenv values). In the precedence loop, when `fileWins` AND `value === ""` AND a non-empty `ambientValue` exists:
  - **Option chosen (Fail-Closed, Assumption)**: prefer the ambient value — `target[key] = ambientValue; origin[key] = "ambient"` — AND record an `emptyButDefined` flag on the divergence so it is surfaced. This never produces a silent 401.
  - The alternative (keep empty, fail closed with a named message) is acceptable per Assumption only if it still never yields a silent 401; the plan pins the ambient-preferred option as primary because it is strictly safer and matches the tracking issue's preferred option.

**Change B — divergence reporting (lines 174–187)**: Extend `EnvDivergence` (env.ts lines 39–47) with a boolean `emptyButDefined?: boolean`. When iterating `project`, if `projectValue === ""` and `ambientValue` is a defined non-empty string, push a divergence with `winner: "ambient"` (since change A prefers ambient), `emptyButDefined: true`, and a `message`/`variable` the report can render as `<VAR> is empty in .env, ignoring ambient value`. This is reported regardless of winner (as today), so `doctor`/`runtime-report` can show it.

**Behavior change**: An empty `.env` credential no longer overwrites a working shell credential; if the value is kept (non-preferred path), a named warning makes the discard visible. Either way, no silent `HTTP 401`.

### US2 — `GUILDCTL_HARNESS` env var must switch the harness (#125, FR-004..FR-006)

**Module**: `migration/guildctl/harness.ts`, `resolveHarness()` (lines 19–38) and `resolveAgentLaunch()` (lines 142–145).

**Current behavior**: `resolveHarness` checks `env.AGENT_CMD` first (line 20), then `const name = config.harness || "opencode"` (line 24). `config.harness` is always a string (config.ts), so the `|| "opencode"` never falls through and `env.GUILDCTL_HARNESS` is never consulted.

**Change — precedence `GUILDCTL_HARNESS > config.harness > "opencode"` (lines 19–24)**: Insert a `GUILDCTL_HARNESS` branch between the `AGENT_CMD` check (line 22) and the `config.harness` read. The resolved `name` becomes:
  ```
  if (env.AGENT_CMD) → custom (unchanged, lines 20–22)
  else const name = env.GUILDCTL_HARNESS || config.harness || "opencode";
  ```
  The existing `if (name === "opencode") … else if name === "goose" … else if name === "codex" … else if name === "copilot" … else throw` chain (lines 25–37) is unchanged — the unknown-value named throw (line 37) already lists goose/opencode/codex/copilot and satisfies FR-006.

**Change — environment divergence (lines 142–145)**: `resolveAgentLaunch()` already pushes a `harness` divergence when `harness.name !== declaredHarness` (line 143), reading `source: originOf("AGENT_CMD")` — but `originOf` only keys `AGENT_PROVIDER_BASE_URL`/`AGENT_CMD`. When the env source is `GUILDCTL_HARNESS`, set the divergence `source` to `"environment"` and, if `env.GUILDCTL_HARNESS` is set, the `declaredValue` is `config.harness || "opencode"` and `resolvedValue` is `harness.name`. This mirrors the existing `AGENT_CMD` divergence test in `runtime-resolution.test.ts` (lines 103–119). `HarnessResolution.source` already admits `"environment"` (harness.ts line 10).

**Behavior change**: `GUILDCTL_HARNESS=goose` (no `harness:` in config) resolves to `goose` from `environment`; `GUILDCTL_HARNESS=opencode` overrides `harness: codex`; an unknown value throws the existing named error. `doctor`/run-start list it as a harness divergence.

### US3 — Missing harness CLI is caught early (#126, FR-007..FR-008)

**Module**: `migration/guildctl/doctor.ts` `runPipelineStateChecks()` (lines 56–247) and the launch path in `runner.ts`/`commands/auto.ts` (auto.ts lines 395–440).

**Current behavior**: `checkHarness()` (harness.ts lines 166–180) is invoked only in preflight's resolution stage (preflight.ts lines 180–183 via `opts.checkAdapter ?? checkHarness`). `doctor` never calls it; the phase launch path (auto.ts line 395 spawn, line 440 throw) does not consult any harness-availability result.

**Change A — doctor invokes `checkHarness` (doctor.ts, after line 76 or as a new early check)**: Import `resolveAgentLaunch` (or `resolveHarness`) and `checkHarness` from `./harness`. At the top of `runPipelineStateChecks`, resolve the harness for the configured workspace (`resolveAgentLaunch({ config: resolveGuildConfig({ cwd: workspaceRoot }), root: workspaceRoot })`), then call `checkHarness(resolution.harness)`. Push a `CheckResult`:
  - `status: "fail"` with message `active harness: <name> (<command> is missing or unreachable)` when `!probe.ok` (reusing `checkHarness`'s own message, which already names the missing command/adapter — lines 168, 177).
  - `status: "pass"` with `probe.message` when `probe.ok`.
  This is a blocking finding (non-green) because `CheckStatus` `"fail"` is rendered as a non-green failure by the doctor command (evidence: `doctor-pipeline-state.test.ts` line 248 `doctor command exits non-zero when pipeline-state checks fail`).
  Note: `checkHarness` spawns `<command> --version` (lines 170–178); doctor already runs other filesystem/sqlite checks, so one extra probe is within its existing cost profile. To avoid double-probing at phase launch, doctor computes the result once and the launch path reuses the same resolution (see Change B).

**Change B — launch path consults the result (runner.ts / commands/auto.ts)**: `spawnAgent` (runner.ts line 390) already resolves `launch = opts.resolution ?? resolveAgentLaunch(...)`. Before spawning (around runner.ts line 391 / auto.ts line 395), consult `checkHarness(launch.harness)` once. If `!ok`, throw a clear `active harness: <name> (<command> missing or unreachable)` error at the boundary instead of spawning and later failing with a cryptic exit code. This reuses the same function preflight uses (constitution I: single source of truth), so the boundary check and the doctor check cannot disagree. The phase-launch path should not spawn a new `--version` probe per artifact — it uses the already-resolved `launch.harness` and a single `checkHarness` call.

**Behavior change**: `doctor` with `harness: opencode` (CLI absent) reports a blocking missing-harness failure; a phase launch against the same config throws the named error at the boundary, not mid-run.

### US4 — Preflight tolerates response-shape variation and logs raw body (#120, FR-009..FR-010)

**Module**: `migration/guildctl/preflight.ts`, `runPreflight()` (lines 273–284), `completionText()` (lines 116–120), `redactCredential()` (line 84, must wrap any body excerpt — FR-019).

**Current behavior**: Line 274–278 — single `JSON.parse(bodyText)`; on throw, returns `liveFailure("response", "provider returned a malformed response body")` with no body capture. `completionText` (lines 116–120) reads `choices[0].message.content ?? choices[0].text` and rejects any other shape. Connection errors are handled separately (lines 252–255, "provider request failed"), so the parse-failure branch is strictly the "shape unexpected" path.

**Change A — shape tolerance (completionText, lines 116–120; parse, lines 273–284)**:
  - `completionText`: after the existing `choices[0].message.content ?? choices[0].text`, add tolerant fallbacks that still pass for valid-but-variant shapes: e.g. `choices[0].delta?.content` (non-streamed-ish delta), `choices[0].message?.content` already covered, and a guard that treats a parseable object whose only top-level fields are `id`/`object`/`created`/`model`/`usage`/`system_fingerprint` + `choices` as valid. Extra/unknown top-level fields MUST NOT cause a malformed failure (FR-009). Return `""` only when no completion text can be extracted.
  - `runPreflight` parse branch (lines 273–278): keep `JSON.parse` but on `catch`, do NOT return the generic "malformed" string. Instead compute a redacted, length-capped raw-body excerpt (e.g. `redactCredential(bodyText.slice(0, 512), credentialValue)`) and call `liveFailure("response", redactCredential("provider returned a response shape that could not be parsed: <excerpt>", credentialValue))`. Stage stays `"response"`; the message now distinguishes "response shape unexpected" from the connection-error branch (lines 252–255, "provider request failed: …"), preserving the existing #120 distinction intent.

**Change B — raw-body capture on shape failure (line 277 → replaced)**: Same excerpt as Change A. `redactCredential` (line 84) already redacts credential-bearing substrings, satisfying FR-019 / Assumption (secrets never enter the excerpt unredacted).

**Behavior change**: A working OpenAI-compatible endpoint returning a valid completion with extra fields (`usage`, `id`, `system_fingerprint`) or a minor non-streamed shape passes; an unparseable body yields a `reason` containing the redacted, length-capped raw body and a shape-specific message — never a bare "malformed".

### US5 — Underlying harness stderr is surfaced, not a bare exit code (#121, FR-011..FR-012)

**Module**: `migration/guildctl/commands/auto.ts` harness spawn (lines 395–440) and `runner.ts` `spawnAgent` failure propagation.

**Current behavior**: auto.ts lines 395–425 spawn the harness with `stdio: ["ignore","pipe","pipe"]` and pipe stdout/stderr live to the operator's terminal (lines 424–425) — but the captured text is discarded; on non-zero exit it throws `${phase} worker exited with code ${outcome.exitCode ?? 1}` (line 440). The runner's `spawnAgent` similarly propagates only the exit code. The harness adapter's own error (e.g. codex: `failed to decode models response: missing field models`) is written to stderr, which is piped to the terminal but never captured into the thrown error.

**Change — capture and surface (auto.ts lines 395–440)**: Instead of piping harness stdout/stderr straight to the operator terminal, buffer them (the existing `outcome` from `enforceSpawnLimits` already observes activity; add explicit capture of the streams). On `outcome.exitCode !== 0` (line 439), throw:
  ```
  `${phase} worker (${harness.name}) exited with code ${exitCode}: ${stdoutStderr}`
  ```
  where `harness.name` is read from the resolved `launch.harness.name` (already available in scope at auto.ts line 395) and `stdoutStderr` is the verbatim captured stdout+stderr, trimmed and length-capped for readability but preserving the root-cause substring (e.g. `failed to decode models response: missing field models`). The same captured text is threaded through `runner.ts` `spawnAgent`'s result/error so `summarizeRunFailures` (runner.ts lines 360–376) can include it.

**Constitution VII guard (FR-012)**: The surfaced text is the harness's OWN stderr, passed through verbatim. No `if (provider === "9router")` or `if (harness === "codex")` branch is introduced — the captured bytes are provider/harness-agnostic. This is a pure error-propagation change, matching the Assumption that #121 is documentation + error-surfacing, not a protocol change.

**Behavior change**: A `codex` harness failing on `/v1/models` surfaces `failed to decode models response: missing field models` (plus harness name + exit code) in the kit's failure message, not `exited with code 1`. Working providers are unaffected.

## Testing Strategy (Constitution V)

All tests use the existing `node:test` runner and fixtures (`makeTempDir`, `cliFixture`, `DEFAULT_GUILD_CONFIG`, `truthful-run-state-fixtures`). Injected `fetchImpl` and controllable harness spawn mean **no live provider is required** — the unit/injected suite is the primary gate (Assumption).

### `migration/test/env-precedence.test.ts` (EXTEND — US1, FR-001..FR-003)
- New case: with `ambient = { NINE_ROUTER_API_KEY: "<working>" }` and a workspace `.env` containing `NINE_ROUTER_API_KEY=` (empty), `loadGuildEnvironment({ ambient, cwd })` resolves `target.NINE_ROUTER_API_KEY` to the working value (ambient preferred) **and** `envDivergences()` contains an entry with `variable === "NINE_ROUTER_API_KEY"` and `emptyButDefined === true`.
- New case: an **unset** key (key absent from `.env`) vs an **empty** key (key present, blank) produce distinct divergence shapes — `emptyButDefined` is `true` only for the empty case.
- Reuse existing `divergenceFor()` helper (env-precedence.test.ts line 65) and the `loadGuildEnvironment` call pattern (lines 115–135).

### `migration/test/runtime-resolution.test.ts` (EXTEND — US2, FR-004..FR-006)
- New case: `resolveHarness(DEFAULT_GUILD_CONFIG, root, { GUILDCTL_HARNESS: "goose" })` returns `name === "goose"`, `source === "environment"`.
- New case: `resolveHarness({ ...config, harness: "codex" }, root, { GUILDCTL_HARNESS: "opencode" })` → `name === "openai"`-equivalent "opencode" (env wins).
- New case: `resolveAgentLaunch({ config: DEFAULT_GUILD_CONFIG, root, env: { GUILDCTL_HARNESS: "goose" } }).divergences` contains a `harness` entry with `source === "environment"`, mirroring the existing `AGENT_CMD` divergence test (lines 103–119).
- New case: `resolveHarness(config({ harness: "nope" }), root, { GUILDCTL_HARNESS: "bogus" })` throws `/Unknown harness/` (extends the existing throw test at line 293).
- Reuses `DEFAULT_GUILD_CONFIG`, `config()`, and the `resolveHarness`/`resolveAgentLaunch` imports already present (lines 7, 285, 293).

### `migration/test/preflight-resolved-path.test.ts` (EXTEND — US4, FR-009..FR-010)
- New case: injected `fetchImpl` returns `200` with body `{ id, object, created, model, choices: [{ message: { content: "ok" } }], usage: {...}, system_fingerprint: "x" }` (extra fields) → `runPreflight` verdict `"pass"`.
- New case: injected `fetchImpl` returns `200` with a minor non-standard but parseable shape `completionText` can read (e.g. `delta.content` style or single-text shape) → still passes.
- New case: injected `fetchImpl` returns `200` with a non-JSON body → `verdict === "fail"`, `failedStage === "response"`, and `reason` contains a redacted, length-capped excerpt of the body AND a "shape" / "could not be parsed" phrase (distinct from the connection-error "provider request failed" message). Assert `reason` does NOT contain the old literal `"provider returned a malformed response body"`.
- Existing `fetchImpl` stub pattern (line 66) and the offline/budget cases (lines 256–315) are reused; no live fetch.

### `migration/test/doctor-pipeline-state.test.ts` (EXTEND — US3, FR-007)
- New case: build a workspace whose `resolveGuildConfig` yields `harness: opencode` and where `opencode --version` is not on PATH (use a harness command pointing at a missing file, mirroring the `checkHarness` test in `harness-selection.test.ts` lines 28–32, or a temp root with no bundled adapter). Call `runPipelineStateChecks` (with a seeded in-memory db) and assert a `CheckResult` with `status === "fail"` and a message matching `/active harness: opencode.*missing or unreachable/`.
- New case (inverse): a harness whose CLI is present → `status === "pass"`.
- Reuses `runPipelineStateChecks` import (line 8), `fixtureRoot` (line 23), the in-memory `Database` + `applySchema` pattern already in the file.

### `migration/test/harness-stderr.test.ts` (NEW — US5, FR-011..FR-012)
- Spawn a harness command via the runner/auto spawn path directed at a stub CLI script that exits non-zero after writing a known error to stderr (e.g. `failed to decode models response: missing field models`). Assert the captured `AgentRunResult`/thrown error includes: the harness `name`, the non-zero `exitCode`, and the verbatim stderr substring.
- A second case asserts that a working stub (exit 0, empty stderr) produces no error and proceeds — proving the fix only improves surfacing, not working codex/OpenAI providers.
- Uses injected spawn (no real harness binary), mirroring `runtime-resolution.test.ts` lines 306–343 where `AGENT_CMD` is pointed at a temp script. Confirms **no** provider/harness-specific branch in the surfaced text (FR-012).

**Regression guard (SC-006)**: existing cases in `runtime-resolution.test.ts`, `env-precedence.test.ts`, `preflight-resolved-path.test.ts`, and `doctor-pipeline-state.test.ts` must stay green; the precedence/divergence/error-surfacing changes are additive (new divergence field, new precedence branch, new failure-message content) and do not alter the existing `opencode default` / `AGENT_CMD` / `pass-on-valid-body` assertions.

## Risks & Open Questions

**Risks**
- **Double `--version` probe cost**: doctor + preflight + launch each could call `checkHarness`. Mitigation: preflight already calls it (lines 180–183); doctor adds one at startup; launch reuses the same `launch.harness` and a single call (US3 Change B). No per-artifact re-probe.
- **Empty-value override surprise**: an operator who *intended* to blank a credential via an empty `.env` line will now get the ambient value instead. Mitigation: the `emptyButDefined` divergence is reported (named warning), and `GUILD_ENV_PRECEDENCE`/`--ambient-env` already exist for explicit ambient opt-in (env.ts lines 33–36, 106–112).
- **`redactCredential` coverage on raw body**: if a provider echoes the API key in its error body, the excerpt must be redacted. Mitigation: the excerpt is wrapped in `redactCredential(bodyText.slice(0,512), credentialValue)` reusing the existing path (FR-019).
- **Windows harness spawn**: `resolveAgentSpawn`/`checkHarness` already handle `.mjs` via Node and shell on win32; the US5 capture change only adds buffering, no platform branch.

**Open Questions**
- Exact precedence for US1 when the operator *wants* the empty value to win (Fail-Closed default prefers ambient; the alternative keeps empty + named failure is allowed by Assumption but not the pinned option). Confirmed pinned: ambient-preferred + named warning.
- Does `doctor` need `resolveGuildConfig` imported into `doctor.ts`, or should the resolved harness be passed in by the doctor command? Plan assumes importing `resolveAgentLaunch`/`resolveGuildConfig` (both already used elsewhere in `guildctl/`).
- Length cap for captured stderr / raw-body excerpt: plan proposes 512 chars for the body (mirrors existing `truncate` usage, preflight.ts lines 101–105) and a similar cap for harness stderr; exact constant to be finalized in `tasks.md`.

## MVP vs Incremental Boundaries

**MVP (the two P1 env/harness-selection fixes + preflight shape tolerance + early missing-CLI check)**
- US1 (#119): empty-vs-unset distinction + ambient-preferred + `emptyButDefined` divergence.
- US2 (#125): `GUILDCTL_HARNESS` precedence + environment divergence + unknown-value throw.
- US3 (#126, partial): `doctor` invokes `checkHarness` as a blocking finding; launch-path boundary check.
- US4 (#120): shape tolerance + redacted raw-body excerpt on parse failure.
- Regression tests: `env-precedence.test.ts`, `runtime-resolution.test.ts`, `preflight-resolved-path.test.ts`, `doctor-pipeline-state.test.ts` extended.
- SC-001..SC-004, SC-006.

**Incremental (sequenced after MVP)**
- US5 (#121) full harness-stderr surfacing in `commands/auto.ts`/`runner.ts` — NEW `harness-stderr.test.ts`. (P2; SC-005.)
- Deeper codex/goose no-model-refresh mode — explicitly OUT of scope per Assumption ("does not add an offline/no-model-refresh mode to codex/goose"); deferred.
- Docs pass: `HARNESS.md` + `GETTING-STARTED.md` updates (FR-013, SC-007) documenting corrected `GUILDCTL_HARNESS` precedence, empty-vs-unset credential behavior, and installed-harness-CLI requirement.
- Maintainer read-through verification (SC-007).
