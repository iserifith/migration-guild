# Feature Specification: Fix Provider/Harness Resolution (Onboarding Hardening, Wave 3)

**Feature Branch**: `010-fix-provider-harness-resolution`

**Created**: 2026-08-17

**Status**: Draft

**Input**: Issue #132 (Wave 3 of the onboarding-hardening plan, from the 2026-08-16 black-box onboarding test). Tracking issue for two investigations that determine whether a fresh agent install can talk to a model at all. Depends on having a real workspace (Wave 1/2) to run commands against. The wave has two sub-groups:

- **Env/harness selection** (env + config precedence for run-time resolution):
  - #119 — empty `.env` credential value silently wins over a working ambient value
  - #125 — `GUILDCTL_HARNESS` env var has no effect on harness resolution
  - #126 — default harness (`opencode`) and `.env.example` harness are both unrunnable out of the box; no early check for a missing harness CLI
- **Provider/harness execution** (the live-check/harness execution layer; sequenced after the above because a broken preflight input is easier to fix once the inputs it checks resolve correctly):
  - #120 — preflight fails with "malformed response body" against a working OpenAI-compatible endpoint
  - #121 — `codex` harness fails against providers whose `/v1/models` response doesn't match its expected schema, with no surfaced error

The five sub-issues are the entire scope of this spec; each is a hardening fix against findings F7, F8, F9, F10, F14, F15 in `onboarding-test-report.md`.

**Source context**: derived from reading the actual resolution code on `origin/dev`:
- `migration/guildctl/env.ts` — `loadGuildEnvironment()` applies a workspace `.env` value only when `value != null` (line 197 `if (fileWins)`). An empty `.env` value (`NINE_ROUTER_API_KEY=`) is a defined key with a falsy value, so `fileValues[key] = ""` (line 165) is written, and `target[key] = ""` replaces a working ambient value. Divergence reporting (`env.ts` §3, lines 174–187) only compares declared vs ambient and never flags "empty-but-defined". This is the #119 trap.
- `migration/guildctl/harness.ts` — `resolveHarness()` (lines 19–38) reads `config.harness || "opencode"` and never reads `GUILDCTL_HARNESS`. `config.harness` is always a string in `GuildConfig` (config.ts line 10), so it is never falsy/empty — `env.GUILDCTL_HARNESS` can never win. This is the #125 bug. `checkHarness()` (lines 166–180) exists and is used by preflight's resolution stage but is **not** invoked during `doctor` or at phase-launch time, so a missing harness CLI only fails cryptically mid-run. This is #126.
- `migration/guildctl/preflight.ts` — the live stage parses the response once with `JSON.parse(bodyText)` and on any parse failure returns `"provider returned a malformed response body"` (line 277), with no raw-body capture or shape tolerance. `completionText()` (lines 116–120) only reads `choices[0].message.content`/`choices[0].text` and rejects streamed/alternate shapes. This is #120.
- Harness adapters (`harness/codex.mjs`, `harness/goose.mjs`) shell out to the CLI, which calls `GET /v1/models` against the resolved provider. Against 9router that endpoint returns a shape codex's parser rejects (`missing field models`), and the error is swallowed into a bare "exited with code 1" by the runner. This is #121.

**Governing document**: `.specify/memory/constitution.md` — principally I (Evidence Over Assertion), VI (Fail-Closed Automation — credential/provider preflight MUST fail closed, secrets redacted, no silent discards of a working value), and VII (Pluggable Stacks, Neutral Providers — `AGENT_CMD` is the escape hatch; no provider-specific behavior hardcoded).

## User Scenarios & Testing *(mandatory)*

Primary persona: the **fresh installer** (black-box onboarding user) who copies `.env.example`, picks a harness, and runs `guildctl preflight` / `guildctl doctor` to discover whether their setup can reach a model. Secondary persona: the **maintainer** who runs the kit's own `migration/test` suite as a regression gate for these resolution fixes. Tertiary persona: the **operator diagnosing a failed phase** who needs the underlying harness stderr, not a bare exit code.

### User Story 1 - Empty `.env` value must not discard a working ambient credential (Priority: P1)

A fresh installer copies `.env.example` (which leaves `NINE_ROUTER_API_KEY=` blank) while a real key is exported in their shell. `guildctl preflight` / `doctor` must resolve the working ambient credential (or emit an explicit, named warning that the empty `.env` value was ignored), and must **not** silently run with the empty string and fail with a misleading `HTTP 401: API key required`.

**Why this priority**: this is the most dangerous failure mode — it actively discards a correct value and produces a confusing auth error far from the real cause. It is the first sub-group in the tracking issue and a direct Fail-Closed (VI) violation.

**Independent Test**: with `process.env.NINE_ROUTER_API_KEY=<working>` set and a workspace `.env` containing `NINE_ROUTER_API_KEY=` (empty), run `loadGuildEnvironment()` (or `guildctl doctor` end-to-end). Delivers value if the resolved credential is the working ambient value OR an explicit warning names the variable and the empty value, and `preflight` does not report `HTTP 401`.

**Acceptance Scenarios**:
1. **Given** a workspace `.env` defines `NINE_ROUTER_API_KEY=` (empty) and the ambient shell defines `NINE_ROUTER_API_KEY=<working>`, **When** `loadGuildEnvironment()` resolves, **Then** `process.env.NINE_ROUTER_API_KEY` is the working value (ambient preferred over empty) **or** a divergence/warning entry explicitly states the empty `.env` value was ignored for that variable.
2. **Given** the same empty-vs-working split, **When** `guildctl doctor` runs, **Then** the credential is reported as present (source `ambient`) or the doctor surfaces a named `NINE_ROUTER_API_KEY is empty in .env, ignoring ambient value` warning — never a silent 401 downstream.
3. **Given** a `.env` value that is genuinely **unset** (key absent) vs **empty** (key present, blank), **When** resolution runs, **Then** the two are distinguished in divergences/reporting: "unset" fills from ambient silently; "empty" warns before preferring ambient (or, if the chosen precedence keeps the empty value, fails closed with a named message rather than a provider 401).

---

### User Story 2 - `GUILDCTL_HARNESS` env var must actually switch the harness (Priority: P1)

A maintainer sets `GUILDCTL_HARNESS=goose` (with `harness:` removed from `.guild/config.yaml`) and expects the `goose` harness to run. `resolveHarness()` must honor the env var, and `guildctl doctor` / the run-start line must report the env-sourced harness as a divergence.

**Why this priority**: `HARNESS.md` documents `GUILDCTL_HARNESS` as a selector, but `resolveHarness()` never reads it (harness.ts lines 19–38), so the documented contract is broken. This is the second sub-group entry and a truthful-run-state (spec 001, FR-011) regression: the run uses a different harness than the operator believes is selected.

**Independent Test**: call `resolveHarness(config_without_harness, root, { GUILDCTL_HARNESS: "goose" })`. Delivers value if the returned `name === "goose"` and `source === "environment"`, and `doctor` lists it as a harness divergence.

**Acceptance Scenarios**:
1. **Given** `.guild/config.yaml` has no `harness:` key and `GUILDCTL_HARNESS=goose`, **When** `resolveHarness()` runs, **Then** the resolved harness is `goose` from `environment` (not the `opencode` default).
2. **Given** `harness: codex` in config and `GUILDCTL_HARNESS=opencode`, **When** `resolveHarness()` runs, **Then** the env var wins and the resolved harness is `opencode` (env overrides config).
3. **Given** a harness resolved from `GUILDCTL_HARNESS`, **When** `resolveAgentLaunch()` builds its report, **Then** a `harness` divergence entry appears with `source: "environment"`, matching the AGENT_CMD divergence pattern already tested in `migration/test/runtime-resolution.test.ts`.
4. **Given** `GUILDCTL_HARNESS` names an unknown/unsupported harness, **When** `resolveHarness()` runs, **Then** it fails closed with a named error listing supported bundled harnesses, consistent with the existing `Unknown harness` throw (harness.ts line 37).

---

### User Story 3 - Missing harness CLI is caught early, not mid-run (Priority: P1)

A fresh installer relies on the default `harness: opencode` (or copies `.env.example`'s `AGENT_CMD=agent-shim.mjs`, a Copilot shim) without the corresponding CLI installed. `guildctl doctor` (and, ideally, `preflight`'s resolution stage) must fail clearly with the missing-harness name, rather than surfacing as a cryptic "exited with code 1" partway through a phase.

**Why this priority**: #126 — neither the built-in default nor the documented `.env.example` harness is runnable out of the box, and there is no early gate. This blocks every LLM-backed phase for a new user and is the third sub-group entry.

**Independent Test**: run `checkHarness(resolveHarness(...))` (or `guildctl doctor`) against a config whose harness CLI is not on `PATH`. Delivers value if the result is `{ ok: false }` with a message naming the missing harness command, and `doctor` exits non-zero / reports it as a blocking finding.

**Acceptance Scenarios**:
1. **Given** `harness: opencode` and `opencode` is not on `PATH`, **When** `guildctl doctor` runs, **Then** it reports `active harness: opencode (opencode is missing or unreachable)` as a failure (not green).
2. **Given** `AGENT_CMD=agent-shim.mjs` (the `.env.example` default) and that binary is absent, **When** `checkHarness()` runs, **Then** it returns `ok: false` naming the missing command.
3. **Given** a harness whose CLI IS installed, **When** `checkHarness()` runs, **Then** it returns `ok: true` and `doctor` reports the harness as available.
4. **Given** `doctor` detects a missing harness, **When** the user runs a phase anyway, **Then** the phase must not start a silent crash — the same `checkHarness` result is consulted before launch (or `doctor` is the documented pre-flight gate and its missing-harness finding is surfaced at launch).

---

### User Story 4 - Preflight tolerates response-shape variation and logs the raw body on failure (Priority: P1)

An installer points the kit at a working OpenAI-compatible endpoint (e.g. `example-router.invalid`) that returns valid JSON on the identical request via `curl`, but `guildctl preflight` fails with `provider returned a malformed response body`. Preflight must tolerate non-streamed vs streamed bodies and minor shape differences, log the raw response on parse failure, and distinguish "provider unreachable/down" from "response shape unexpected" in the error message.

**Why this priority**: #120 — a user with a genuinely working, standards-compliant endpoint is blocked by preflight with a misleading error. This is the first provider-execution sub-issue and a direct spec 001 (FR-011/FR-012) accuracy gap: preflight reports a runtime a run would not use.

**Independent Test**: call `runPreflight()` with an injected `fetchImpl` that returns a valid-but-nonstandard completion (e.g. `choices[0].message.content` present but with extra fields, or a non-streamed SSE-ish body) and with a body that fails strict parse. Delivers value if the valid shape passes and the unparseable body yields a failure whose `reason` includes the raw body text (redacted) and whose stage is `response` with a shape-specific message, not a generic "malformed".

**Acceptance Scenarios**:
1. **Given** a provider returns a well-formed completion with extra/unknown fields (`usage`, `id`, `system_fingerprint`), **When** preflight parses it, **Then** it passes (extra fields do not cause a malformed-body failure).
2. **Given** a provider returns a non-streamed body that `completionText()` can read but whose top-level shape differs slightly from the minimals, **When** preflight parses, **Then** it still extracts the completion and passes (shape tolerance).
3. **Given** a provider returns a body that cannot be parsed as JSON, **When** preflight reports failure, **Then** the `reason` includes a (redacted, length-capped) excerpt of the raw body so the user can diagnose, and the stage is `response` with a message distinguishing "response shape unexpected" from "provider unreachable".
4. **Given** the provider is genuinely unreachable (fetch throws / network error), **When** preflight reports failure, **Then** the stage is `response` and the `reason` names the connection failure (not a malformed-body parse error), preserving the existing #120 distinction intent.

---

### User Story 5 - Underlying harness stderr is surfaced, not a bare exit code (Priority: P2)

An installer selects `harness: codex` against a provider whose `GET /v1/models` response doesn't match codex's expected schema. Codex errors with `failed to decode models response: missing field models` and the kit only reports `exited with code 1`. The kit must capture and surface the underlying harness stderr/error in its failure message.

**Why this priority**: #121 — harness selection appears to "work" mechanically but the pipeline still fails on an auxiliary API probe, and the failure gives the user almost nothing to act on. P2 because it is the second provider-execution sub-issue (sequenced after #120 in the tracking issue) and partly a documentation + error-propagation fix rather than a protocol change.

**Independent Test**: run a `codex` (or `goose`) harness launch whose underlying CLI fails on `/v1/models`, via the runner's spawn path, and assert the thrown/returned error includes the captured stderr substring (`failed to decode models response` / `missing field models`). Delivers value if a maintainer reading the failure sees the root cause instead of `exited with code 1`.

**Acceptance Scenarios**:
1. **Given** `harness: codex` and a provider whose `/v1/models` returns an unexpected schema, **When** the harness launches and fails, **Then** the kit's failure message includes the captured harness stderr (e.g. `failed to decode models response: missing field models`), not merely `exited with code 1`.
2. **Given** a harness that fails for any reason, **When** the runner captures its output, **Then** both stdout and stderr are collected and the error message names the harness and the exit code alongside the captured text.
3. **Given** a provider that does support the expected `/v1/models` schema, **When** `harness: codex` launches, **Then** it proceeds normally (the fix only improves error surfacing + docs, and must not break working codex/OpenAI providers).

---

### Edge Cases
- What if `GUILDCTL_HARNESS` is set but points to a bundled harness whose adapter file is missing on disk? `resolveHarness` returns the resolution; `checkHarness` (already consulting `resolution.command`) must catch the missing adapter and fail closed, naming the missing file — same path as today's config-sourced missing adapter.
- What if the env precedence fix for #119 prefers ambient over an *intentionally* empty `.env` value the user wanted to blank? The user can set `GUILD_ENV_PRECEDENCE` or export the value; the warning makes the override visible, preserving Fail-Closed (VI) — ambient is never silently discarded, and an empty project value never silently wins.
- What if preflight's raw-body logging captures a credential-bearing response? The existing `redactCredential()` (preflight.ts line 84) must wrap any body excerpt, same as today's `reason` redaction (FR-019).
- What if a provider streams the response by default? Preflight must not require SSE parsing for a `max_tokens: 16` non-stream request; shape tolerance (Story 4) covers non-standard but parseable bodies without adding a streaming client.
- How is the #121 fix prevented from becoming a provider-specific hack? The surfaced error is the harness's own stderr text, passed through verbatim — no 9router/codex-specific branching is introduced, honoring constitution VII (Neutral Providers).
- Does fixing #126's early harness check risk double-spawning `--version` probes on every phase? `checkHarness` is already called in preflight's resolution stage; `doctor` reuses the same function. Phase launch should consult a cached resolution, not spawn a new probe per artifact.

## Requirements *(mandatory)*

### Functional Requirements
- **FR-001**: `loadGuildEnvironment()` (env.ts) MUST distinguish an **empty** `.env` value from an **unset** one and MUST NOT let an empty project value silently overwrite a working ambient value for the same variable, per constitution VI (Fail-Closed). (#119)
- **FR-002**: When a `.env` value is empty but a non-empty ambient value exists, the resolver MUST either (a) prefer the ambient value, or (b) emit an explicit, named warning (e.g. `<VAR> is empty in .env, ignoring ambient value`) before applying precedence — the choice MUST be documented and consistent, and MUST never result in a silent `HTTP 401` from a discarded working credential. (#119)
- **FR-003**: Divergence reporting in `env.ts` (§3, lines 174–187) MUST flag the empty-but-defined case distinctly from the unset case, so `doctor`/run-start can surface it. (#119)
- **FR-004**: `resolveHarness()` (harness.ts) MUST read `GUILDCTL_HARNESS` and apply precedence `GUILDCTL_HARNESS > config.harness > "opencode"` default, replacing the current `config.harness || "opencode"` branch that never consults the env var. (#125)
- **FR-005**: A harness resolved from `GUILDCTL_HARNESS` MUST be reported as a `source: "environment"` divergence in `resolveAgentLaunch()`, mirroring the existing `AGENT_CMD` divergence pattern in `migration/test/runtime-resolution.test.ts`. (#125)
- **FR-006**: An unknown/unsupported `GUILDCTL_HARNESS` value MUST fail closed with a named error listing supported bundled harnesses (goose, opencode, codex, copilot), consistent with the existing `Unknown harness` throw. (#125)
- **FR-007**: `guildctl doctor` MUST invoke `checkHarness()` (harness.ts lines 166–180) for the resolved harness and report a missing/unreachable harness CLI as a blocking failure (non-green), not silently green. (#126)
- **FR-008**: The phase-launch path (runner / `commands/auto.ts`) MUST consult the same `checkHarness` result (or `doctor`'s finding) before starting an LLM-backed phase, so a missing harness CLI fails clearly at the boundary rather than as a mid-run `exited with code 1`. (#126)
- **FR-009**: `runPreflight()` (preflight.ts) MUST tolerate response-shape variation: a valid completion with extra/unknown top-level fields and a non-streamed body with minor shape differences MUST still pass, provided `completionText()` can extract a non-empty completion. (#120)
- **FR-010**: On a non-parseable preflight response body, the failure `reason` MUST include a redacted, length-capped excerpt of the raw body, and MUST distinguish "response shape unexpected" from "provider unreachable/down" (the latter keeps the existing connection-error path). (#120)
- **FR-011**: The kit's harness-launch/runner spawn path MUST capture both stdout and stderr from the underlying harness CLI and include the captured text (plus harness name and exit code) in the failure message, replacing bare `exited with code 1` reporting. (#121)
- **FR-012**: The #121 error-surfacing fix MUST pass through the harness's own stderr verbatim and MUST NOT introduce provider- or harness-specific branching beyond the bundled-adapter set, honoring constitution VII. (#121)
- **FR-013**: `HARNESS.md` and `GETTING-STARTED.md` MUST be updated to document the corrected `GUILDCTL_HARNESS` precedence, the empty-vs-unset `.env` credential behavior, and the requirement that the selected harness CLI be installed (or `doctor` will fail closed). (#125, #119, #126)
- **FR-014**: All five fixes MUST ship with regression tests in `migration/test/` (extending `runtime-resolution.test.ts`, `env-precedence.test.ts`, `preflight-resolved-path.test.ts`, `doctor-pipeline-state.test.ts`, and a new harness-stderr / codex-models test) so the behavior is pinned per constitution V. (#119–#121, #125, #126)

### Key Entities
- **Resolution layer**: `migration/guildctl/env.ts` (`loadGuildEnvironment`), `migration/guildctl/harness.ts` (`resolveHarness`, `checkHarness`, `resolveAgentLaunch`), the single source of truth for what a run will use (FR-011, spec 001).
- **Live-check layer**: `migration/guildctl/preflight.ts` (`runPreflight`), the staged resolution→live check that must report a runtime a run would actually take.
- **Doctor gate**: `migration/guildctl/doctor.ts` (`runPipelineStateChecks`), the early, non-green-blocking-surface for missing harness CLIs and empty credentials.
- **Harness adapters**: `harness/*.mjs` (codex, goose, opencode, copilot/agent-shim), the CLI-shimming layer whose stderr must be surfaced on failure (#121).

## Success Criteria *(mandatory)*

### Measurable Outcomes
- **SC-001**: With `NINE_ROUTER_API_KEY=<working>` in the shell and `NINE_ROUTER_API_KEY=` empty in `.env`, `guildctl doctor` reports the credential as present (source `ambient`) or emits a named empty-value warning — and `preflight` never reports `HTTP 401` from the discarded value. (Story 1)
- **SC-002**: `GUILDCTL_HARNESS=goose` with no `harness:` in config resolves to `goose` from `environment`, and `doctor`/run-start lists it as a harness divergence — verified by a regression test. (Story 2)
- **SC-003**: `guildctl doctor` with `harness: opencode` (CLI absent) reports a blocking missing-harness failure; a phase launch against the same config fails clearly at the boundary, not as a mid-run exit 1. (Story 3)
- **SC-004**: `runPreflight()` passes against a working OpenAI-compatible endpoint returning a valid completion with extra fields / minor shape variation, and fails with a raw-body-excerpt + shape-specific `reason` against a non-parseable body — verified by injected `fetchImpl` tests. (Story 4)
- **SC-005**: A `codex` harness launch against a provider with an unexpected `/v1/models` schema surfaces the captured stderr (`failed to decode models response: missing field models`) in the kit's failure message, not `exited with code 1` — verified by a harness-spawn test. (Story 5)
- **SC-006**: `npm test` in `migration/` passes with the new regression tests; no existing test in `runtime-resolution.test.ts`, `env-precedence.test.ts`, `preflight-resolved-path.test.ts`, or `doctor-pipeline-state.test.ts` is broken by the precedence/error-surfacing changes. (all stories)
- **SC-007**: `HARNESS.md` + `GETTING-STARTED.md` accurately describe the corrected `GUILDCTL_HARNESS` precedence, empty-vs-unset credential behavior, and the installed-harness-CLI requirement, verified by a maintainer read-through. (Story 2, 1, 3)

## Assumptions
- The fixes are **kit runtime changes** (`migration/guildctl/`), not fixture content — distinct from spec 008's fixture-only scope. They MUST NOT modify `package/mock/` or any migration workspace; they change resolution/pre-flight/doctor/runner code only.
- `GUILDCTL_HARNESS` precedence order is **env > config > default** (env wins), matching the documented intent in `HARNESS.md` and the existing `AGENT_CMD > config` pattern already in `resolveHarness`.
- For #119 the chosen precedence is **ambient preferred over an empty project value** (Fail-Closed: never silently discard a working credential), with an explicit warning — this is the safer default and matches the tracking issue's preferred option; the alternative (keep empty, fail closed with a named message) is acceptable only if it still never produces a silent 401.
- Preflight's live stage will remain a single non-stream `POST /chat/completions` with `max_tokens: 16`; shape tolerance (Story 4) does not add an SSE/streaming client — it only relaxes `completionText`/parse strictness and adds raw-body logging.
- The #121 fix surfaces the harness's own stderr verbatim; it does **not** add an offline/no-model-refresh mode to codex/goose (that is a separate, larger change) — documentation + error surfacing is the in-scope deliverable, per the tracking issue's "at minimum" language.
- Existing divergence/reporting redaction (`redactCredential`, `isSensitiveEnvName`) covers any raw-body or stderr excerpt that could contain a credential; no new redaction path is required beyond reusing the existing one (FR-019).
- Wave 1/2 (a real workspace + the live-check plumbing) are assumed landed so these fixes can be exercised end-to-end; the unit/injected tests in `migration/test/` are the primary gate and do not require a live provider.
