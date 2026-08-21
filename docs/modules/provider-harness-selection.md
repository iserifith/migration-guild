# Provider & Harness Selection

How Migration Guild decides *which* program runs a worker (the **harness**) and
*which* LLM endpoint/model it talks to (the **provider**), how those decisions
are validated before a run, and what happens when they go wrong.

This document covers the selection and diagnostics layer. The wire protocol of
the OpenAI-compatible HTTP client itself is documented in
[openai-compatible-adapter.md](./openai-compatible-adapter.md) and is not
duplicated here.

---

## Overview

Migration Guild never talks to an LLM directly during a phase run. Instead,
`guildctl` spawns a **harness adapter** — a thin Node `.mjs` shim that
translates the runner's CLI contract (`--agent`, `--model`, `--yolo`,
`-p "<prompt>"`) into a specific agent CLI's invocation format
(`package/harness/HARNESS.md` documents the contract). Four bundled harnesses
ship with adapters: `opencode`, `goose`, `codex`, and `copilot` (via
`agent-shim.mjs`). Anything else is a **custom harness** supplied by the
operator through the `AGENT_CMD` environment variable.

Two orthogonal selections happen per launch:

1. **Harness selection** — which adapter/CLI executes the agent.
2. **Provider/model selection** — which OpenAI-compatible base URL, model, and
   credential variable the run uses, resolved through provider *routes* that
   map logical route names (`default`, `review`, …) to ordered model fallback
   lists.

The design invariant, enforced by spec 001 ("truthful run state", FR-011), is
that there is exactly **one** resolution function shared by the runner,
preflight, doctor, and the run-start report line:
`migration/guildctl/harness.ts:resolveAgentLaunch`. Preflight cannot report a
runtime a run would not use, because both call the same code.

---

## Selection / Resolution Flow

### 1. Environment loading precedes everything

Before any resolution, `migration/guildctl/env.ts:loadGuildEnvironment`
establishes which environment values are in force. A workspace `.env`
**describes** the checkout and wins over ambient shell values in the default
"project" precedence mode (opt out via `--ambient-env` or
`GUILD_ENV_PRECEDENCE=ambient`). Two safety properties matter for providers:

- **Fail-Closed empty-value rule**: an empty project `.env` value (e.g.
  `NINE_ROUTER_API_KEY=`) must not discard a working ambient credential; the
  ambient value is kept and an `emptyButDefined` divergence is flagged
  (`env.ts:loadGuildEnvironment`, the `fileWins` computation).
- **Origin tracking**: every variable a file defined gets an entry in the
  returned `origin` map (`"project-file"` or `"ambient"`). This map is later
  threaded into harness resolution so divergence reports can name *which file
  or shell* to edit.

### 2. Config resolution

`migration/guildctl/config.ts:resolveGuildConfig` deep-merges, in order:

1. `DEFAULT_GUILD_CONFIG` (`config.ts:DEFAULT_GUILD_CONFIG`) — an
   OpenAI-compatible default: `model.model = "gpt-4o-mini"`,
   `base_url = "https://api.openai.com/v1"`, `api_key_env = "OPENAI_API_KEY"`,
   plus seeded provider routes and profiles.
2. `.guild/config.yaml` (parsed by the hand-rolled
   `config.ts:parseSimpleYaml`; JSON also accepted).
3. The selected **profile** from `profiles.*` merged into `model` — e.g. the
   shipped `local` profile points at `http://localhost:1234/v1`.
4. Explicit CLI overrides.

Note the config layering is deliberately *not* environment-aware: env vars
override at the harness-resolution layer (next step), not by mutating config.

### 3. Harness selection

`migration/guildctl/harness.ts:resolveHarness` applies a strict precedence:

1. **`AGENT_CMD`** (environment) → a custom harness, `name: "custom"`,
   `source: "environment"`. Highest priority; this is the constitution's
   pluggability escape hatch (no provider-specific behavior hardcoded).
2. **`GUILDCTL_HARNESS`** (environment, trimmed; empty string treated as
   unset) → pins one of the bundled harness names for a single run without
   editing config.
3. **`config.harness`**, defaulting to `"opencode"`.

Bundled names are resolved by `harness.ts:resolveBundledHarness` to adapter
paths under `package/harness/` (via `bundledFile`, which falls back to a
`package/`-prefixed path for installed layouts). An unknown name **throws**
with the supported list — fail-closed rather than launching something that
does not exist. Each bundled resolution carries a `targetCommand` (the real
CLI binary the adapter shells out to, e.g. `goose`) used later for
reachability probing.

### 4. Model & provider resolution

- **Routes**: `config.ts:resolveProviderRoute` looks up
  `provider.routes[route]`, falling back to `routes["default"]`, then to
  `model.model`. Values may be arrays or comma-separated strings.
- **Route walking**: `harness.ts:selectRouteModel(config, route, attempt)`
  indexes into the route's model list, clamping at the last entry so a long
  retry chain keeps using the final fallback model instead of falling off the
  end.
- **Per-phase models**: `config.ts:resolvePhaseModel` maps phases to agent
  personas (`inventory`→`cheap`, `review`→`reviewer`, …) and reads each
  persona's `agents.<key>.model`.
- **Base URL override**: `AGENT_PROVIDER_BASE_URL` in the environment beats
  `model.base_url` (`harness.ts:resolveAgentLaunch`).

### 5. The single launch resolver

`harness.ts:resolveAgentLaunch` composes all of the above into one
`ResolvedRuntimeConfig`: the harness resolution, effective model, provider
base URL, credential variable *name*, the private `agentEnv` the child
process receives (including `AGENT_PROVIDER_BASE_URL` and
`AGENT_PROVIDER_API_KEY_ENV`), and a list of **divergences** — places where
the resolved runtime differs from what config declares, each tagged with its
source (`ambient`, `project-file`, or `config`) via the env-origin map. The
runner consumes this at `migration/guildctl/runner.ts:406` (and again at line
553 with run-scoped extras); preflight and doctor consume the same function.

Secret hygiene is structural: `agentEnv` may contain credentials, so reporting
code must call `harness.ts:toResolvedRuntimeReport`, which strips it and keeps
only the variable *name* (`credentialEnv`).

---

## Adapter vs. Custom Harness: Two Different Trust Models

| | Bundled adapter (`source: "config"`) | Custom (`AGENT_CMD`, `source: "environment"`) |
|---|---|---|
| Ships an adapter file | Yes (`package/harness/*.mjs`) | No — the command *is* the program |
| Reachability probe | Adapter file existence + `<target> --version` spawn | Spawn the command itself with `--version` |
| Probed by preflight | Yes | No (deliberately) |
| Probed by doctor | No (preflight already covered it) | **Yes** |

The bundled path is checked in two steps inside
`harness.ts:checkHarness`: first the adapter file must exist on disk, then the
*harness CLI binary* (`targetCommand`, or the command itself for custom) is
spawned with `--version` — through Node when the command ends in
`.mjs/.cjs/.js`. Failure messages distinguish three scenarios explicitly:
spawn-impossible (ENOENT/EACCES), adapter-ran-but-exited-nonzero (with a
capped ~200-char stderr excerpt surfaced verbatim), and success.

The asymmetry in who probes what is intentional and documented inline:

- `migration/guildctl/preflight.ts:runPreflight` (resolution stage): *"A
  custom AGENT_CMD program is the operator's own; the live provider request is
  what proves the resolved path works."* So the adapter probe only fires when
  `resolution.harness.source === "config"`.
- `migration/guildctl/doctor.ts:runPipelineStateChecks` (first check, US3):
  *"doctor must not green-light a harness whose program is missing or
  unreachable"* — so when the resolved harness came from the environment,
  doctor calls `checkHarness` itself. This closes the gap preflight leaves
  open, and runs before the registry-table early-return so a fresh installer
  still learns their harness is broken.

---

## Failure Modes & Diagnostics

### Preflight: two stages, one budget

`preflight.ts:runPreflight` proves the runtime under a shared wall-clock
budget (CLI override → `preflight.budget_seconds` → 30s):

1. **Resolution stage** — calls `resolveAgentLaunch` (identical to the
   runner), then fails fast on: no model resolved, no base URL, missing
   credential value, or a failed adapter probe (bundled harnesses only).
2. **Live stage** — exactly one minimal `POST {base_url}/chat/completions`
   against the *resolved provider directly*, not through the adapter
   (FR-012: proving an adapter starts is not proof a model answers). Empty
   completions are never a pass; no second request is ever billed.

Failures are classified into named stages by
`preflight.ts:failureStageFor`: 401/403/429 or quota-pattern bodies →
`authorization`; 404 or model-not-found patterns → `model-availability`;
everything else → `response`. Provider-supplied reasons are extracted from
JSON error envelopes (`preflight.ts:providerReason`), truncated to 300 chars,
and always passed through `redactCredential` so the credential value can never
survive into a report (FR-019).

Notable diagnostic refinements:

- **Unparseable body ≠ unreachable provider**: a reachable endpoint returning
  a non-JSON body yields `"provider response shape unexpected; body excerpt:
  …"` with a redacted 512-char excerpt — the fix for the old bare
  "malformed response body" failure (#120).
- **Reasoning-model exhaustion**: if the answer is empty but usage reports
  reasoning tokens with `finish_reason: "length"`
  (`preflight.ts:isReasoningTokenExhaustion`), the message says the model
  needs a larger token budget rather than blaming the provider. The probe
  budget was raised to `PREFLIGHT_PROBE_MAX_TOKENS = 256` for exactly this.
- **Offline mode** labels the live stage `unvalidated` — never `pass` (FR-018).

### Doctor: the custom-harness complement

As described above, `doctor.ts:runPipelineStateChecks` probes
environment-sourced harnesses via `checkHarness`, surfacing the real stderr
excerpt (e.g. an uninstalled Copilot CLI's own error) instead of sending the
user hunting for a shim that is fine. Resolution failures here are swallowed —
preflight already reports them under "Runtime path:".

### Runner: launch-time capture

When a phase actually launches, `runner.ts` captures the harness CLI's raw
stdout+stderr uncapped and surfaces a capped excerpt (512 chars) in failure
messages with no sanitization or provider/harness branching — the operator
sees the underlying tool's own words (US5 #121).

---

## Gotchas

- **`AGENT_CMD` beats everything**, including `GUILDCTL_HARNESS`. If a stale
  `AGENT_CMD` lingers in your shell or `.env`, your pinned harness silently
  doesn't apply — check the divergence report, which will show
  `harness: declared opencode → resolved custom`.
- **Empty-string env vars count as unset** for `GUILDCTL_HARNESS`
  (`harness.ts:resolveHarness` trims and treats empty as absent), but
  `AGENT_CMD=""`… also falls through to the next branch since `if (env.AGENT_CMD)`
  is falsy. Consistent, but worth knowing when debugging `.env` files.
- **Unknown harness names throw at resolution time**, not at launch — you'll
  see it in preflight's `resolution` stage failure, listing the four supported
  bundled names and pointing at `AGENT_CMD`.
- **Preflight does not validate custom harness executables.** A typo'd
  `AGENT_CMD` passes preflight's resolution stage (the live provider request
  succeeds independently) and only fails when doctor runs or the phase
  actually launches. Run `guildctl doctor` after changing `AGENT_CMD`.
- **The live preflight bypasses the adapter entirely.** A green preflight
  proves the provider+model+credential work over plain HTTP; it does *not*
  prove the harness adapter can drive them (historically the codex `/v1/models`
  schema mismatch, #121). Conversely, a broken adapter with a healthy provider
  fails preflight only via the bundled-harness `--version` probe.
- **Route models clamp, not cycle**: attempt indices beyond the route length
  stick on the last model (`harness.ts:selectRouteModel`).
- **Profiles merge into `model` wholesale** (`config.ts:resolveGuildConfig`),
  so a profile can change base URL, model, *and* credential variable at once;
  an unknown non-default profile name throws with the available list.
- **Install-relative `.env` candidates** (found relative to the built CLI)
  participate in loading but never override ambient values and never enter
  the workspace divergence set (`env.ts:defaultInstallCandidates`) — a subtle
  source of "where did this value come from?" confusion.

---

## Extension Points

### Adding a bundled harness

1. Write `package/harness/<name>.mjs` implementing the adapter contract in
   `package/harness/HARNESS.md` (accept `--agent/--model/--yolo|--read-only/-p`,
   write token usage to `GUILD_OPENCODE_USAGE_FILE`).
2. Add a branch in `harness.ts:resolveBundledHarness` mapping the name to the
   adapter path and the real CLI as `targetCommand`.
3. Update the error string in the same function's `throw` — it is the
   discoverable list operators rely on.
4. Add coverage alongside `migration/test/harness-selection.test.ts` and
   `migration/test/codex-harness.test.ts` / `opencode-harness.test.ts`.

No changes are needed in preflight or doctor: both consume `checkHarness`
through the shared resolution, so a new bundled harness is probed
automatically.

### Adding a provider

Providers are just OpenAI-compatible base URLs — no code change required:

1. Point `model.base_url` at the endpoint (or add a `profiles.<name>` entry
   with `base_url`/`model`/`api_key_env` and select it).
2. Export the credential under the variable named by `model.api_key_env`.
3. Optionally reshape `provider.routes` so retry chains fall back across that
   provider's models.
4. Run `guildctl preflight` — the live stage validates reachability, auth,
   model availability, and response shape against the new endpoint, with
   stage-named failures telling you which of the four broke.

For a provider needing a *non*-OpenAI-compatible protocol, the escape hatch is
a custom `AGENT_CMD` harness wrapping whatever client speaks that protocol;
the guild core stays provider-neutral by design (constitution VII).

### Relevant tests

`migration/test/provider-routing.test.ts` (route resolution),
`migration/test/default-provider-profile.test.ts` (shipped defaults),
`migration/test/runtime-resolution.test.ts` (launch resolver + divergences),
`migration/test/harness-selection.test.ts` (precedence),
`migration/test/preflight-resolved-path.test.ts` and
`migration/test/preflight-reasoning-model-budget.test.ts` (live stage),
`migration/test/doctor-pipeline-state.test.ts` (custom-harness probe),
`migration/test/env-precedence.test.ts` (`.env` vs ambient).
