# Feature Specification: Onboarding Wave 6 — Kit Build/Packaging Integrity and First-Run Guidance

**Feature Branch**: `012-onboarding-wave6-kit-packaging`

**Created**: 2026-08-19

**Status**: Draft

**Input**: User description: "Black-box onboarding re-test (2026-08-19, against `origin/dev` @ `7db91e9`) confirms the six regressions from the previous onboarding-hardening waves (#119, #122, #123, #124, #125, #126) all hold under a fresh run — but the test surfaced a new, more serious problem outside the original watchlist: the shipped kit build is broken out of the box. Full test report: `onboarding-test-report.md` (available on request; not committed to this repo)." (Issue #148)

**Source context**: Issue #148, verified against `origin/dev` @ `7db91e9` during this spec's research. Five concrete verified defects: (1) `scripts/build-dist.mjs:188-191` copies `migration/registry/dist`, `migration/guildctl/dist`, `migration/ui-dist`, and `stacks/` into the tarball but never copies `migration/package.json`, `migration/package-lock.json`, or `migration/registry_schema.sql` — so GETTING-STARTED.md's documented `cd migration && npm install` fails with ENOENT and every subsequent `guildctl` command crashes with `Error: Cannot find module 'dotenv'` (the tsup config at `migration/tsup.config.ts` does not bundle `dotenv`/`better-sqlite3`/`commander`/`yaml`; `migration/registry/db/schema.ts:5-19` walks up from the compiled `__dirname` expecting `registry_schema.sql` to exist somewhere above it, and the fallback resolves to a path that does not exist in the tarball). (2) `scripts/build-dist.mjs:216` runs `npx tsup` with `cwd: migration/` — which requires `migration/node_modules` to exist, yet DEVELOPMENT.md's "Build the repo" section (lines 131-138) only documents the root `npm install`. (3) `migration/guildctl/config.ts:53-58,81` seeds `DEFAULT_GUILD_CONFIG.model` with `base_url: https://rootsys.cloud/v1`, `api_key_env: ROOTSYS_API_KEY`, and `profiles.default` identically, while root `.env.example` and `package/.env.example` (verified byte-identical) document only `DASHSCOPE_API_KEY` as "the default for Migration Guild" — a user following the docs literally ends up with a `doctor` failure on a credential nobody was told to set. (4) `migration/guildctl/harness.ts:190-204` (`checkHarness`) reports the generic `(${command} is missing or unreachable)` for *any* non-zero exit or spawn error — including when the adapter file exists and runs fine but the underlying CLI it wraps (Copilot CLI) is not installed, which is the actual onboarding path failure reported in #148. (5) Root `.env.example` line 3 carries the stale comment "Base URL is set per-profile in `guildctl.config.json`" though `guildctl.config.json` is no longer read (confirmed: `migration/guildctl/commands/benchmark.ts:92` lists it only as a legacy artifact for migration warning purposes; `config.ts` reads `.guild/config.yaml` exclusively).

Additional Low-severity documentation gaps verified in the same pass: `--legacy-path` (a fully working `setup.ts` flag, `setup.ts:46,173-183,290-313`) is absent from GETTING-STARTED.md's Setup code block (only `--legacy-url` is shown); README.md's "Pipeline at a glance" table (lines 71-83) uses bare command form (`guildctl inventory`) while GETTING-STARTED.md's "Run the pipeline" (lines 105-117) uses `guildctl run inventory` — both work, but a first-time user cannot tell that without reading cli.ts; and piped/batched stdin answers to the interactive setup wizard can silently exit early (no files written) because `setup.ts:189-219` closes the readline interface after the prompt loop without handling stdin EOF (a user piping `printf "1\n1\n\n" | node setup.js` gets no diagnostic).

**Governing document**: `.specify/memory/constitution.md` — principally VI (Fail-Closed Automation: missing dependencies or missing harness adapters must be detected and reported as errors *before* work begins — a shipped kit that cannot install its own dependencies, and a doctor that cannot say *why* a harness fails, are both fail-open onboarding paths), VII (Pluggable Stacks, Neutral Providers: provider profiles must remain swap-in swap-out and not be hard-wired to any specific vendor or endpoint — a default model profile pointing at an undocumented personal endpoint violates provider neutrality for every fresh `guildctl init`), and I (Evidence Over Assertion: the kit's claim that "migration/ ships with the kit; this only installs its node_modules" is currently false in the tarball, and the packaging defect must be fixed with a regression test that proves it, not an assertion).

## User Scenarios & Testing *(mandatory)*

Primary persona: the **first-time kit consumer**, who receives `migration-guild-kit.tar.gz` with no access to the source repository and must reach a working workspace with only the tarball + README + GETTING-STARTED.md. Secondary persona: the **kit maintainer**, who runs `npm run build:dist` from a fresh clone to cut a release and must not hit undocumented install requirements. Tertiary persona: the **onboarding tester**, who re-runs black-box wave tests (like #148's author) and needs the previously-passing regressions (#119–#126) to stay passing.

### User Story 1 - Tarball-only consumer reaches a working `guildctl` workspace (Priority: P1)

A first-time user extracts `migration-guild-kit.tar.gz` into a clean directory, follows GETTING-STARTED.md steps 1–6 verbatim (extract, `mkdir` workspace, run `setup.js`, `cd migration && npm install`, `guildctl init`, `cp .env.example .env`), and every command succeeds through the smoke test (`guildctl --help`, `registry list-artifacts` returning `[]`) without a module-not-found crash or a missing-schema crash.

**Why this priority**: This is the Critical path from #148 — "a real first-time user hitting the packaging bugs cold (tarball only, no source access) would plausibly lose 30–60+ minutes with no documented way out — this is the dominant onboarding-time risk right now". The tarball is the *only* distribution artifact; if it cannot install or boot, nothing else in the kit matters.

**Independent Test**: Build the tarball, extract it into a scratch directory outside the repo, run the GETTING-STARTED.md steps verbatim as shell commands, and assert the smoke test passes. This is fully testable without any of the other stories.

**Acceptance Scenarios**:

1. **Given** a freshly built `dist/migration-guild-kit.tar.gz`, **When** its contents are listed, **Then** `migration/package.json`, `migration/package-lock.json`, and `migration/registry_schema.sql` are present alongside `migration/registry/dist/`, `migration/guildctl/dist/`, and `migration/ui-dist/`.
2. **Given** the extracted tarball in a clean directory, **When** `cd migration && npm install` runs (GETTING-STARTED.md step 4), **Then** npm completes with exit code 0 (it has a real `package.json` to install from) and creates `migration/node_modules` containing at minimum `dotenv`, `better-sqlite3`, `commander`, and `yaml`.
3. **Given** the extracted tarball with dependencies installed, **When** `node migration/guildctl/dist/cli.js --help` and `node migration/registry/dist/cli.js list-artifacts` run (GETTING-STARTED.md smoke test), **Then** both succeed — the registry CLI can find `registry_schema.sql` (so `applySchema` at `migration/registry/db/schema.ts:21` never hits the ENOENT fallback) and `dotenv` (so `guildctl` never crashes with `Cannot find module 'dotenv'`).
4. **Given** the extracted tarball with dependencies installed, **When** `node migration/guildctl/dist/cli.js init` runs in the workspace, **Then** it scaffolds `.guild/config.yaml` without a schema-path error.

**Edge Cases**:

- What happens when the build machine's `migration/` has no `node_modules` (fresh clone, root install only)? `build:dist` must not crash mid-build — see User Story 2.
- What happens to the tarball size when `package-lock.json` is included? It is ~63 KB of text; negligible against the dist trees it ships beside.

### User Story 2 - Maintainer builds the dist from a fresh clone using only documented steps (Priority: P2)

A maintainer clones the repo, follows DEVELOPMENT.md's "Build the repo" section (root `npm install`, then `npm run build:dist`), and the build completes without needing to know about the two undocumented nested installs (`migration/` and `migration/ui/`), because the build script itself performs (or checks for and instructs) those installs.

**Why this priority**: #148 lists this as the second half of the Critical finding. It compounds Story 1: not only is the *output* broken, the *build* is broken for anyone following the docs. It is P2 rather than P1 only because maintainers can recover from source (the tarball-only user cannot recover at all).

**Independent Test**: From a fresh clone (or a clone with `migration/node_modules` and `migration/ui/node_modules` removed), run exactly the documented steps and assert the tarball is produced. Fully testable without Story 1's runtime checks.

**Acceptance Scenarios**:

1. **Given** a fresh clone with only the root `npm install` run, **When** `npm run build:dist` executes, **Then** the build does not fail with `tsup: command not found` or an `ENOENT` on `migration/...` — either the build script runs the nested installs itself, or it detects their absence and prints an actionable error naming all three install locations before failing.
2. **Given** a fully installed clone (root + `migration/` + `migration/ui/`), **When** `npm run build:dist` executes, **Then** behavior is unchanged from today: same steps, same outputs, same tarball contents (plus Story 1's additions).
3. **Given** the shipped DEVELOPMENT.md, **When** a reader looks at the "Build the repo" section, **Then** all three install locations (root, `migration/`, `migration/ui/`) are stated up front in that section, not only in the unrelated "test suite" section.

**Edge Cases**:

- Windows: `build-dist.mjs` already resolves `npm`→`npm.cmd` with `shell: true` (lines 18-24, 32-34); any new nested-install step must reuse `resolveCommand`/`run` so it keeps working cross-platform.
- Idempotence: re-running `build:dist` on an already-installed clone must not be slower or destructive — `npm install` in an already-populated `node_modules` is a fast no-op, so wiring installs into the build is safe.

### User Story 3 - Fresh `guildctl init` produces a provider profile consistent with the shipped docs (Priority: P3)

A user completes setup and `guildctl init` in a fresh workspace, opens `.guild/config.yaml`, and finds a default model profile that points at a **generic OpenAI-compatible endpoint** (`https://api.openai.com/v1`, credential env var `OPENAI_API_KEY`) — the same neutral default the shipped `.env.example` and GETTING-STARTED.md document. The current seeded default (`https://rootsys.cloud/v1`, `ROOTSYS_API_KEY`, model `fiq/hy3-tencent`) is an undocumented personal provider that no shipped doc mentions, so a doc-following user's `doctor` fails on a credential nobody told them to set. The maintainers have chosen the OpenAI-compatible direction: seeded defaults become generic OpenAI-compatible, and all DashScope references are removed from shipped artifacts (DashScope remains usable by explicit user configuration, but is no longer referenced as the default anywhere in the kit).

**Why this priority**: #148 rates this Medium. It does not block reaching a running workspace (init succeeds; doctor flags the missing credential), but it guarantees every doc-following user hits a confusing doctor failure immediately after setup — the exact "zero guidance for a first-time user" experience the onboarding waves exist to eliminate.

**Independent Test**: Run `guildctl init` in a scratch workspace, read the generated `.guild/config.yaml` `model:` block, and compare against the provider documented in `.env.example`/GETTING-STARTED.md. No dependency on other stories.

**Acceptance Scenarios**:

1. **Given** a fresh workspace and the shipped `.env.example` (documenting `OPENAI_API_KEY` as the default credential for the OpenAI-compatible runtime), **When** `guildctl init` generates `.guild/config.yaml`, **Then** the seeded default profile's `api_key_env` is `OPENAI_API_KEY` with `base_url` `https://api.openai.com/v1`, and `model` is an OpenAI-compatible model identifier consistent with the seeded `provider.routes` (no rootsys-namespace `fiq/*` identifiers anywhere in the seeded config).
2. **Given** the resolved default profile, **When** `guildctl doctor` runs with the documented credential set (and no other credentials), **Then** the credential check passes without the user needing to know about an env var the docs never mention.
3. **Given** existing tests that assert on `DEFAULT_GUILD_CONFIG`'s current seeded values (e.g. `migration/test/auto-canary.test.ts:637-798` asserting `AGENT_PROVIDER_BASE_URL === "https://rootsys.cloud/v1"` and `ROOTSYS_API_KEY` propagation), **When** the default changes, **Then** those tests are updated in the same change so the suite stays green — config.ts is shared runtime code, and its seeded defaults are behavior under test.
4. **Given** the seeded `profiles` map in `DEFAULT_GUILD_CONFIG` (`migration/guildctl/config.ts:81-86`), **When** this story lands, **Then** no profile references DashScope: the `dashscope` profile and the dashscope-intl-pointing `cheap`/`reviewer`/`qwen` profiles are removed or repointed to OpenAI-compatible defaults, so a fresh init never mentions DashScope in generated config or docs.

**Edge Cases**:

- Direction choice: The issue offered two directions (make init's default match the documented DashScope default, or update the docs to match the rootsys default). The maintainers chose a **third direction on 2026-08-19: generic OpenAI-compatible** — seeded defaults point at `https://api.openai.com/v1` with `OPENAI_API_KEY`, and **DashScope references are removed from shipped artifacts entirely**. This supersedes both issue directions: rootsys was never documented anywhere, and DashScope (a specific named provider) is no longer the shipped default either. Provider-neutrality (constitution VII) is served best by a generic OpenAI-compatible default that the user repoints at their own endpoint by editing one base_url.
- `deepMerge` at `config.ts:337` means any user who already has a `.guild/config.yaml` with an explicit `model:` block keeps their values — the default change only affects fresh inits.
- The default `harness: "opencode"` is untouched by this story.

### User Story 4 - `doctor` reports *why* a present-but-failing harness fails (Priority: P4)

A user whose Copilot CLI is not installed runs `guildctl doctor` after setup (GETTING-STARTED.md instructs exactly this). The harness adapter exists on disk (`agent-shim.mjs` is present and reachable), so doctor's current wording — `agent-shim.mjs is missing or unreachable` — is false and sends the user hunting for a file that is fine. Doctor must report the adapter's actual failure cause (e.g. the spawned adapter's stderr excerpt naming the missing Copilot CLI) when the adapter file exists but exits non-zero.

**Why this priority**: #148 rates this Medium (the partial pass on regression #126). The fail-closed behavior itself already works (doctor fails, does not pass); what is broken is the diagnosis quality. It is P4 only because it comes after the Critical and the guidance defects above it.

**Independent Test**: Point `AGENT_CMD` at an adapter script that exists on disk and exits non-zero with a message on stderr, run doctor (or `checkHarness` directly), and assert the failure message includes the adapter's stderr excerpt rather than the generic wording. Fully testable in `migration/test/doctor-pipeline-state.test.ts` alongside the existing harness tests (lines 311-330).

**Acceptance Scenarios**:

1. **Given** a harness adapter file that exists and is reachable but exits non-zero with stderr `Copilot CLI not found at ...`, **When** `checkHarness` at `migration/guildctl/harness.ts:190-204` probes it, **Then** the returned failure message includes the adapter's actual stderr excerpt (trimmed, length-capped), not the bare `is missing or unreachable` wording.
2. **Given** a harness adapter file that does not exist, **When** `checkHarness` probes it, **Then** the existing `missing adapter: <path>` message (line 192) is unchanged.
3. **Given** a harness adapter that exists but cannot be spawned at all (spawn error, not non-zero exit), **When** `checkHarness` probes it, **Then** the message distinguishes spawn failure from non-zero exit (both keep failing closed; both carry a cause).
4. **Given** an existing passing harness, **When** `checkHarness` probes it, **Then** the ok message is unchanged.
5. **Given** the existing tests asserting `/active harness: custom.*(missing or unreachable)/` (`migration/test/harness-selection.test.ts:32` and `migration/test/doctor-pipeline-state.test.ts:319`), **When** wording changes, **Then** those assertions are updated in the same change so the suite stays green.

**Edge Cases**:

- Stderr excerpts must be trimmed/capped so a verbose adapter doesn't produce a multi-KB doctor line; one to two lines or ~200 chars is plenty.
- Redaction: adapter stderr could theoretically contain credentials; the excerpt is the adapter's own `--version` output, not agent traffic — acceptable risk, but trim aggressively and cap length.
- Existing message contracts elsewhere (e.g. `benchmark.ts:92` warning about `guildctl.config.json` as a legacy artifact) are untouched.

### User Story 5 - Shipped docs tell one consistent story (Priority: P5)

A user reading README.md and GETTING-STARTED.md back-to-back encounters no contradictions: no stale references to `guildctl.config.json` as the active config, `--legacy-path` documented alongside `--legacy-url`, and one canonical pipeline command form used consistently in both files.

**Why this priority**: #148 rates these Low; they are pure documentation edits with no runtime impact, sequenced last deliberately.

**Independent Test**: `grep` the shipped docs for `guildctl.config.json` (expect: zero non-legacy references), check `--legacy-path` appears in GETTING-STARTED.md's setup block, and diff the command forms used in README's pipeline table against GETTING-STARTED's pipeline block.

**Acceptance Scenarios**:

1. **Given** root `.env.example` (copied verbatim into the tarball via `package/.env.example`), **When** its comment block is read, **Then** no comment claims "Base URL is set per-profile in `guildctl.config.json`" — the comment references `.guild/config.yaml` profiles instead (the config file actually read, per GETTING-STARTED.md:141-142).
2. **Given** GETTING-STARTED.md's Setup code block, **When** the non-interactive alternative is shown, **Then** `--legacy-path <dir>` is documented alongside `--legacy-url <url>`.
3. **Given** README.md's "Pipeline at a glance" table and GETTING-STARTED.md's "Run the pipeline" block, **When** their command forms are compared, **Then** both use the `guildctl run <phase>` form (the form GETTING-STARTED.md already uses and the form the smoke-test path exercises).
4. **Given** the interactive setup wizard, **When** stdin reaches EOF (piped/batched answers), **Then** setup exits with a clear non-zero diagnostic naming the prompt it was answering, rather than silently writing no files — OR, as the doc-only MVP, GETTING-STARTED.md states the wizard is interactive-only and piped stdin is unsupported.

**Edge Cases**:

- The piped-stdin fix (Scenario 4) can be satisfied either by a `setup.ts` readline EOF fix or by a docs note; the docs note is the MVP, the readline fix is incremental. Do not let it expand into a general stdin-automation feature (no new flags, no scripted-answer API) — out of scope.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: `scripts/build-dist.mjs` `assembleTarball()` MUST copy `migration/package.json`, `migration/package-lock.json`, and `migration/registry_schema.sql` into the tarball's `migration/` directory, alongside the existing `registry/dist`, `guildctl/dist`, `ui-dist`, and `stacks` copies.
- **FR-002**: The copied `migration/package.json` and `migration/package-lock.json` MUST be the repository files verbatim — `build:dist` MUST NOT rewrite their dependencies or scripts in the tarball. The tarball's `migration/` is a runtime install root, not a source tree for building.
- **FR-003**: A regression test MUST verify the assembled tarball (or its staging directory) contains `migration/package.json`, `migration/package-lock.json`, and `migration/registry_schema.sql` alongside `migration/registry/dist/` and `migration/guildctl/dist/`. The test must fail on the pre-fix code and pass post-fix (constitution V: the packaging fix is proven by a test, not an assertion).
- **FR-004**: `npm run build:dist` MUST NOT fail on a clone where only the root `npm install` has run — either the build script performs the nested `migration/` and `migration/ui/` installs itself before `npx tsup`, or it pre-checks for `migration/node_modules` and `migration/ui/node_modules` and fails with an actionable message naming all three install locations. Performing the installs is the preferred direction (self-sufficient build); the pre-check is the fallback.
- **FR-005**: DEVELOPMENT.md's "Build the repo" section MUST state all three install locations (root, `migration/`, `migration/ui/`) up front in that section, not only in the "Run the repository test suites" section.
- **FR-006**: The default provider profile seeded by `guildctl init` (`DEFAULT_GUILD_CONFIG.model` and `profiles.default` in `migration/guildctl/config.ts`) MUST be **generic OpenAI-compatible**: `base_url` `https://api.openai.com/v1`, `api_key_env` `OPENAI_API_KEY`, and an OpenAI-compatible model identifier — the same neutral default the shipped docs name. The seeded `provider.routes` and the seeded `agents.*.model` references MUST drop rootsys-namespace `fiq/*` identifiers so the seeded config is internally consistent with the OpenAI-compatible default. DashScope references MUST NOT appear in the seeded config: the `dashscope` profile and the dashscope-intl-pointing `cheap`/`reviewer`/`qwen` profiles are removed or repointed to OpenAI-compatible defaults.
- **FR-007**: All existing tests asserting the current rootsys/DashScope defaults MUST be updated in the same change as FR-006, keeping the suite green. The update surface is wider than the issue's citation: `grep -E 'DEFAULT_GUILD_CONFIG|rootsys|ROOTSYS|fiq/|dashscope' migration/test/` matches **11 test files (~103 matches)** — `provider-routing.test.ts:10-37` (asserts `api_key_env === "ROOTSYS_API_KEY"` and exact `fiq/*` route arrays), `auto-canary.test.ts` (~lines 637-798, env-var propagation), `env-precedence.test.ts`, `preflight-resolved-path.test.ts`, `runtime-resolution.test.ts`, `limit-knob-naming.test.ts`, `guild-config-openai-compatible.test.ts`, `auto-queue.test.ts`, `harness-selection.test.ts`, `process-tree-termination.test.ts`, and `cli-run-phase-exit-code.test.ts`. Additionally, tests that pass `DASHSCOPE_API_KEY` as the doctor credential env (e.g. `doctor-pipeline-state.test.ts:282`, `cli-run-phase-exit-code.test.ts:172`) flip to `OPENAI_API_KEY`.
- **FR-008**: `checkHarness` at `migration/guildctl/harness.ts:190-204` MUST, when the adapter file exists but the probe spawn returns non-zero or a spawn error, include the adapter's actual stderr/stdout excerpt (trimmed, length-capped) in the failure message instead of the generic `(command is missing or unreachable)` wording. When the adapter file is absent, the existing `missing adapter: <path>` message is unchanged; when the harness is healthy, the ok message is unchanged.
- **FR-009**: Existing harness/doctor test assertions matching the old generic wording (`migration/test/harness-selection.test.ts:32`, the `missing or unreachable` assertions in `migration/test/doctor-pipeline-state.test.ts:319`) MUST be updated in the same change as FR-008, keeping the suite green.
- **FR-010**: Root `.env.example`'s stale `guildctl.config.json` comment MUST be corrected to reference `.guild/config.yaml` profiles. Root `.env.example` and `package/.env.example` MUST remain byte-identical (an existing invariant this spec formalizes; the build copies it verbatim, so any root edit automatically ships).
- **FR-011**: GETTING-STARTED.md's Setup block MUST document `--legacy-path <dir>` alongside `--legacy-url <url>`.
- **FR-012**: README.md's "Pipeline at a glance" table MUST use the same `guildctl run <phase>` command form as GETTING-STARTED.md's "Run the pipeline" block; both docs use exactly one command form for pipeline phases.
- **FR-013**: The interactive setup wizard MUST NOT silently write zero files on piped/batched stdin. MVP (doc-only): GETTING-STARTED.md states the wizard is interactive-only and piped stdin is unsupported. Incremental (code): `setup.ts` detects stdin EOF during a prompt and exits non-zero with a diagnostic naming the prompt it was answering. No new flags, no scripted-answer API.
- **FR-014**: This feature MUST NOT change core runtime behavior beyond: the packaging list in `scripts/build-dist.mjs`, the seeded defaults in `migration/guildctl/config.ts`, the failure-message wording in `migration/guildctl/harness.ts`, the default provider endpoints/credential env vars/`--version` default model in `package/agent-shim.mjs` and `package/harness/opencode.mjs` (FR-015: identifier renames and comment/doc updates only — no harness protocol, arg, or spawn changes), removal of the dead `guildctl.config.json` and its copy references (`setup.ts:189`, `benchmark.ts:92`), and documentation files (DEVELOPMENT.md, README.md, GETTING-STARTED.md, `.env.example`). No registry, claims, evidence-gate, arbitration, audit-rule, or UI code is in scope.
- **FR-015**: Shipped artifacts MUST NOT reference DashScope as the default provider. In scope: root + `package/` `.env.example` (DashScope block removed; documents the OpenAI-compatible runtime with `OPENAI_API_KEY` + optional `OPENAI_BASE_URL` override as the default), README.md provider mentions (lines 16/28/54: "DashScope/Qwen default" → generic OpenAI-compatible wording), GETTING-STARTED.md provider references, `package/agent-shim.mjs` (key env `DASHSCOPE_API_KEY` → `OPENAI_API_KEY`; fallback base_url dashscope-intl → `https://api.openai.com/v1`; default `COPILOT_MODEL` `deepseek-v4-pro` → an OpenAI-compatible model ID), and `package/harness/opencode.mjs`'s DashScope comment. The dead `guildctl.config.json` (root + `package/`; read by nothing — only `setup.ts:189` and `benchmark.ts:92` copy it) is removed from both locations along with its copy references in those two files. Optional (incremental): keep a commented `DASHSCOPE_API_KEY=` line as one non-default alternative alongside OpenRouter/OpenAI/local entries.
- **FR-016**: FR-015's changes to `package/` files (`.env.example`, `agent-shim.mjs`, `harness/opencode.mjs`, removal of `guildctl.config.json`) MUST land in `package/` (the shipped source of truth), not root-only copies; root `.env.example` and `package/.env.example` remain byte-identical per FR-010.

### Key Entities

- **Tarball `migration/` runtime root**: the directory inside `migration-guild-kit.tar.gz` from which a consumer installs dependencies and runs the compiled CLIs; requires `package.json` + `package-lock.json` (install), `registry_schema.sql` (schema), and the two `dist/` trees (entrypoints).
- **Default provider profile**: the `model:` block and `profiles.default` seeded by `guildctl init` from `DEFAULT_GUILD_CONFIG`; the single place a fresh workspace's provider endpoint and credential env var come from.
- **Harness probe**: `checkHarness`'s spawn of the adapter with `--version`; its failure message is the only diagnostic a user sees for harness problems during onboarding.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Build `dist/migration-guild-kit.tar.gz` from a fully-installed clone, extract to a scratch directory, and run GETTING-STARTED.md steps 1–6 verbatim: `npm install` in `migration/` succeeds, and the smoke test (`guildctl --help`, `registry list-artifacts` → `[]`) passes. This is the #148 Critical acceptance test.
- **SC-002**: `npm run build:dist` succeeds on a clone with only root `npm install` run (nested `node_modules` absent) — by performing or pre-checking the nested installs per FR-004.
- **SC-003**: A fresh `guildctl init` seeds a default model profile consistent with the shipped docs (generic OpenAI-compatible: `https://api.openai.com/v1`, `OPENAI_API_KEY`); docs↔config consistency is enforced by a test comparing `DEFAULT_GUILD_CONFIG`'s default profile against the provider named in `.env.example`; and `grep -ri dashscope` over shipped artifacts (root and `package/` `.env.example`, README.md, GETTING-STARTED.md, `package/agent-shim.mjs`, `package/harness/opencode.mjs`, seeded config) returns zero default-provider references.
- **SC-004**: `guildctl doctor` with a present-but-failing adapter reports the adapter's stderr excerpt; verified by an updated/new test in `migration/test/doctor-pipeline-state.test.ts` (and/or `harness-selection.test.ts`).
- **SC-005**: Zero references to `guildctl.config.json` as the active config path in shipped docs (README.md, GETTING-STARTED.md, `.env.example`, AGENTS.md); `--legacy-path` documented; one pipeline command form across both docs — verified by doc-grep checks.

## Assumptions

- **Direction choice for FR-006**: generic OpenAI-compatible is chosen (maintainer directive, 2026-08-19). Root `.env.example`'s DashScope block is removed and the file documents the OpenAI-compatible runtime as the default; the seeded `profiles.default` points at `https://api.openai.com/v1` with `OPENAI_API_KEY`. DashScope remains usable by explicit user configuration, but is no longer referenced as the default anywhere in the kit (FR-015). This supersedes both directions the issue offered.
- **Schema path in the tarball**: `migration/registry_schema.sql` matches the documented-layout fallback at `migration/registry/db/schema.ts:18` — `path.resolve(__dirname, "..", "..", "registry_schema.sql")` from `migration/registry/dist/db/` resolves to `migration/registry_schema.sql` — so the schema walk-up finds it without code changes.
- **`.env.example` byte-identity** between root and `package/` is an existing invariant (verified identical on origin/dev); the build copies it verbatim, so root edits automatically ship.
- **Piped-stdin finding**: real — `setup.ts:189-219` uses `readline.createInterface({ input: process.stdin, ... })` and closes `rl` after the loop with no EOF handling; the doc note (FR-013 MVP) acknowledges interactive-only use; the incremental fix detects EOF and exits non-zero with a diagnostic.
- **The onboarding report** `onboarding-test-report.md` referenced in #148 is not committed to this repo and is not required to implement this spec; the spec's verified findings are the source of truth.
- **`012-onboarding-wave6-kit-packaging` is the correct next feature id**: specs 001–011 exist on origin/dev; no spec 012 exists on any branch.
- **Cross-platform**: the build script's existing `run()` helper (with `resolveCommand` for Windows `npm.cmd` + `shell: true`) is reused for any new install steps.
- **Tarball size**: the increase from `package-lock.json` (~63 KB text) is negligible.
- **Scope of prior waves**: #148's own table shows #119–#125 all PASS and #126 PARTIAL; the #126 partial is exactly this spec's Story 4. No other prior-wave work is in scope.
- **Out of scope, recorded for future waves**: (a) the `.guild/.env.example` written by `scaffoldGuildConfig` (config.ts:390) seeds `OPENROUTER_API_KEY`/`OPENAI_API_KEY`/`ANTHROPIC_API_KEY` — under the new OpenAI-compatible default its `OPENAI_API_KEY` entry is consistent, and the extra OpenRouter/Anthropic alternatives are harmless; normalizing that file's full contents is left to a future wave; (b) `benchmark.ts:92`'s copy list drops only the `guildctl.config.json` entry (the file no longer exists); its role as a legacy-artifact migration warning is otherwise unchanged.
- **`registry_schema.sql` size**: ~32 KB text; including it adds negligible tarball weight.
