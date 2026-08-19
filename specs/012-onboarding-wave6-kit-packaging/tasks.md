# Tasks: Onboarding Wave 6 — Kit Build/Packaging Integrity and First-Run Guidance

**Input**: Design documents from `/specs/012-onboarding-wave6-kit-packaging/` (`spec.md`, `plan.md`). No `research.md`, `data-model.md`, or `contracts/` exist for this feature — `plan.md`'s "Technical Approach Per User Story" and "Testing Strategy" sections serve as the equivalent design detail.

**Prerequisites**: `plan.md` (required, present), `spec.md` (required, present).

**Tests**: Tests are explicitly requested. Constitution Principle V ("Tests Before Production Code") and spec.md's Governing document (Principle I, Evidence Over Assertion) require every FR below to be gated by a new or updated `migration/test/*.test.ts` case, written before/alongside the fix. Every test task below MUST be written and confirmed failing (for the specific case under test) before its paired implementation task begins.

**Organization**: Tasks are grouped by user story (US1–US5, priorities P1–P5) to enable independent implementation and testing of each story. Per `plan.md`'s "MVP vs Incremental Boundaries", all five stories are in-scope for this feature — there is no deferred story; US1/US2 are the P1/P2 Critical MVP core, US3/US4 close Medium-severity guidance gaps, and US5 is documentation plus two dead-file deletions, sequenced last.

**Source of truth for line numbers**: verified by direct read of this worktree (branch `spec/issue-148`, based on `origin/dev` @ `7db91e9`) on 2026-08-19. Re-verify line numbers before editing if the base branch has moved. Two corrections to `plan.md`'s own citations, found during this re-verification and folded into the tasks below rather than blocking: (1) `plan.md`'s FR-007 file list (11 files) undercounts against the current tree — this task list's own re-grep found **`migration/test/workspace-isolation-defaults.test.ts:109`** carries the identical `DASHSCOPE_API_KEY: "dummy"` doctor-credential fixture pattern as `doctor-pipeline-state.test.ts:282` and `cli-run-phase-exit-code.test.ts:172`, and needs the same one-line update — see T014. (2) `guild-config-openai-compatible.test.ts:52` (`delete process.env.ROOTSYS_API_KEY;`) was not itemized in `plan.md`'s per-line list but is in the same file/task as its already-cited lines 21 and 38 — see T012.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: Which user story this task belongs to (US1–US5); Setup/Foundational/Polish tasks carry no story label
- Every task includes exact repository file path(s)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Establish the regression baseline this feature's fixes are measured against. No new project scaffolding, dependencies, or directories are needed — every story lands in an existing file (`scripts/build-dist.mjs`, `migration/guildctl/config.ts`, `migration/guildctl/harness.ts`, or a documentation file) or a new `migration/test/*.test.ts` file following an existing pattern.

- [x] T001 Verify baseline: from `migration/`, run `npm test` (`node --import tsx --test test/*.test.ts`, per `migration/package.json`'s `test` script) and confirm all existing suites pass on the unmodified branch, including `migration/test/build-dist-docs-skip.test.ts` (the staging pattern US1/US2's new tests extend), `migration/test/provider-routing.test.ts`, `migration/test/harness-selection.test.ts`, and `migration/test/doctor-pipeline-state.test.ts` (the suites US3/US4 will edit). This is the "existing suites stay green throughout" baseline every later verify task is checked against.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before ANY user story can be implemented.

**This phase is intentionally empty.** The five user stories touch disjoint production files (`scripts/build-dist.mjs` for US1/US2, `migration/guildctl/config.ts` for US3, `migration/guildctl/harness.ts` for US4, documentation + `package/agent-shim.mjs` + `package/harness/opencode.mjs` + two `guildctl.config.json` deletions + `migration/guildctl/commands/benchmark.ts` for US5) and mostly-disjoint new test files, with no shared model, schema, or infrastructure change introduced by any of them (per `plan.md`'s Constitution Check: "no schema change", "no new redaction path"). The one cross-story file overlap — `migration/test/doctor-pipeline-state.test.ts`, edited by both US3 (FR-007, line 282) and US4 (FR-009, line 319) — is a same-file-different-lines sequencing note, not a blocking dependency; see "Same-File Sequencing" below. No task is required beyond T001's baseline check.

**Checkpoint**: Foundation ready — all five user story phases below may start immediately once T001 passes.

---

## Phase 3: User Story 1 - Tarball-only consumer reaches a working `guildctl` workspace (Priority: P1) 🎯 MVP — #148 Critical

**Goal**: `scripts/build-dist.mjs`'s `assembleTarball()` copies `migration/package.json`, `migration/package-lock.json`, and `migration/registry_schema.sql` into the tarball's `migration/` directory (verbatim, per FR-002), alongside the existing `registry/dist`, `guildctl/dist`, `ui-dist`, and `stacks` copies (lines 188–191), so a tarball-only consumer's documented `cd migration && npm install` (GETTING-STARTED.md step 4) has a real `package.json` to install from and never crashes on `Cannot find module 'dotenv'` or a missing `registry_schema.sql`.

**Independent Test** (spec.md): build the tarball, extract it into a scratch directory outside the repo, run the GETTING-STARTED.md steps verbatim as shell commands, and assert the smoke test (`guildctl --help`, `registry list-artifacts` → `[]`) passes. Fully testable without any other story.

### Tests for User Story 1 ⚠️

> Write these tests FIRST; case (a) MUST fail against the current, unmodified `scripts/build-dist.mjs` before T003 is implemented.

- [x] T002 [P] [US1] Write failing tests in `migration/test/build-dist-packaging.test.ts` (NEW). Follow `migration/test/build-dist-docs-skip.test.ts`'s `stageKitRoot()` / `runBuildDist()` / `extractTarball()` pattern exactly (stage a temp kit root with `migration/node_modules` + `migration/ui/node_modules` + root `node_modules` copied in, so the staged `scripts/build-dist.mjs`'s own `npx tsup` / `npm run build:ui` steps can run for real, then execute the *staged* script via `execFileSync`). Cases:
  - (a) after a successful `runBuildDist()`, extract the tarball and assert `migration/package.json`, `migration/package-lock.json`, and `migration/registry_schema.sql` all exist under the extracted `migration-guild-kit-build/migration/` tree (FR-003). **Must fail today**: `assembleTarball()` (`scripts/build-dist.mjs` lines 188–191) copies only `registry/dist`, `guildctl/dist`, `ui-dist`, and `stacks/` — none of these three files.
  - (b) verbatim-copy check (FR-002): the extracted `migration/package.json`'s `dependencies` block deep-equals the repo's `migration/package.json` `dependencies` block (`dotenv`, `better-sqlite3`, `commander`, `yaml`, `@modelcontextprotocol/sdk`) — proves the copy is not rewritten, not just present.
  - (c) SC-001 live smoke test (may be marked slow/opt-in given `npm install`'s network dependency, matching the precedent that `build-dist-docs-skip.test.ts` already accepts long-running `tsup`/`vite` subprocess calls): after `npm install` completes in the extracted `migration/`, run `node migration/guildctl/dist/cli.js --help` and `node migration/registry/dist/cli.js list-artifacts` in a scratch workspace and assert both exit `0`, with `list-artifacts` printing `[]`.

### Implementation for User Story 1

- [x] T003 [US1] Implement the fix in `scripts/build-dist.mjs`'s `assembleTarball()`: add three `fs.copyFile` calls (near lines 188–191, alongside the existing `copyFilteredDirectory` calls) copying `migration/package.json`, `migration/package-lock.json`, and `migration/registry_schema.sql` from `repoRoot` into `buildDir/migration/`. Use plain `fs.copyFile` (verbatim, per FR-002), not `copyFilteredDirectory`'s `.ts`-filtering logic — that filter exists for `package/` (a source tree), not these three already-final runtime files. Depends on T002 (test must exist and fail first).
- [x] T004 [US1] Verify: from `migration/`, run `npm test` and confirm `migration/test/build-dist-packaging.test.ts` passes (all cases) and `migration/test/build-dist-docs-skip.test.ts` remains green (SC-001). Depends on T003.

**Checkpoint**: US1 is independently functional and testable — a freshly built tarball now installs and boots from nothing but its own contents.

---

## Phase 4: User Story 2 - Maintainer builds the dist from a fresh clone using only documented steps (Priority: P2) — #148 Critical

**Goal**: `npm run build:dist` does not fail on a clone where only the root `npm install` has run — `scripts/build-dist.mjs`'s `main()` performs the nested `migration/` and `migration/ui/` installs itself (preferred direction, FR-004) before Step 1 (`npx tsup`, line 215–216) and Step 3 (`npm run build:ui`, line 227), and `DEVELOPMENT.md`'s "Build the repo" section (lines 131–138) states all three install locations up front (FR-005).

**Independent Test** (spec.md): from a fresh clone (or a clone with `migration/node_modules` and `migration/ui/node_modules` removed), run exactly the documented steps and assert the tarball is produced. Fully testable without US1's runtime checks.

### Tests for User Story 2 ⚠️

> Write these tests FIRST; case (a) MUST fail against the current, unmodified `scripts/build-dist.mjs` before T006 is implemented.

- [x] T005 [P] [US2] Write failing tests in `migration/test/build-dist-nested-install.test.ts` (NEW). Stage a temp kit root the same way `build-dist-docs-skip.test.ts` does, but deliberately *omit* `migration/node_modules` and `migration/ui/node_modules` from the staged copy (skip those two `fs.cpSync` calls) while still providing the root `node_modules` (so `npm`/`npx` themselves are resolvable). Cases:
  - (a) `runBuildDist()` against this stripped-down staged kit exits `0` and produces a tarball. **Must fail today**: `main()`'s Step 1 (`scripts/build-dist.mjs` line 216, `run("npx", ["tsup"], { cwd: migration/ })`) requires `migration/node_modules` to already exist; a stripped kit throws.
  - (b) regression guard against a silently-stale-artifact false pass: assert `migration/node_modules/dotenv` (a leaf dependency) exists in the *staged temp kit* after the run, not just that a tarball was produced.
  - (c) regression (FR-004 "behavior unchanged for an already-installed clone"): re-run the existing fully-installed `stageKitRoot(false)` variant through the now-nested-install-aware `build-dist.mjs` and assert the output tarball's top-level contents are unchanged in shape from `build-dist-docs-skip.test.ts`'s existing assertions (no new/missing entries beyond US1's three additions from T003).
  - (d) assert `DEVELOPMENT.md`'s "Build the repo" section text (bounded by the `### 5. Build the repo` heading and the next `###` heading, currently lines 131–138) mentions both `migration/` and `migration/ui/` install locations, not only the separate "Run the repository test suites" section (lines 109–115). **Must fail today**.

### Implementation for User Story 2

- [x] T006 [US2] Implement the fix in `scripts/build-dist.mjs`'s `main()`: add a pre-install step before Step 1 (line 215) that runs `run("npm", ["install"], { cwd: path.join(repoRoot, "migration") })`, and a second pre-install step before Step 3 (line 227's `npm run build:ui`) that runs `run("npm", ["install"], { cwd: path.join(repoRoot, "migration", "ui") })`. Reuse the existing `run()` helper (already resolves `npm`→`npm.cmd` on Windows with `shell: true`, lines 18–24/26–46) — do not add a new spawn call. Neither step is wrapped in a try/swallow: a genuinely broken `npm install` must propagate through `main().catch()` (lines 238–242) the same way a failed `tsup`/`vite` step already does (existing precedent, comment at lines 224–226). `npm install` against an already-populated `node_modules` is a fast no-op, so this runs unconditionally on every invocation — no idempotence guard needed. Depends on T005.
- [x] T007 [P] [US2] Edit `DEVELOPMENT.md`'s "Build the repo" section (lines 131–138, the `### 5. Build the repo` heading): add a line stating all three install locations (root `npm install`, `cd migration && npm install`, `cd migration/ui && npm install`) up front, explaining that `npm run build:dist` performs the nested installs automatically per T006. Independent file from T006 — can run in parallel. Depends on T005.
- [x] T008 [P] [US2] Verify: from the repo root, confirm `npm run build:dist` still succeeds on a fully-installed clone (no regression); from `migration/`, run `npm test` and confirm `migration/test/build-dist-nested-install.test.ts` passes (all cases) and `migration/test/build-dist-docs-skip.test.ts` / `migration/test/build-dist-packaging.test.ts` remain green (SC-002). Depends on T006, T007.

**Checkpoint**: US1 and US2 are both independently functional — a freshly built tarball installs and boots (US1), and the build itself succeeds from documented steps alone on a clone with only the root install done (US2).

---

## Phase 5: User Story 3 - Fresh `guildctl init` produces a provider profile consistent with the shipped docs (Priority: P3) — #148 Medium

**Goal**: `DEFAULT_GUILD_CONFIG` in `migration/guildctl/config.ts` seeds a generic OpenAI-compatible default (`base_url: "https://api.openai.com/v1"`, `api_key_env: "OPENAI_API_KEY"`, an OpenAI-compatible model id) instead of the undocumented personal `https://rootsys.cloud/v1` / `ROOTSYS_API_KEY` profile, and drops the four DashScope-pointing `profiles` entries — so a doc-following user's fresh `guildctl init` never hands them a `doctor` failure on a credential nobody told them to set.

**Independent Test** (spec.md): run `guildctl init` in a scratch workspace, read the generated `.guild/config.yaml` `model:` block, and compare against the provider documented in `.env.example`/GETTING-STARTED.md. No dependency on other stories.

### Tests for User Story 3 ⚠️

> Write these tests FIRST; case (a) MUST fail against the current, unmodified `config.ts` before T010 is implemented.

- [x] T009 [P] [US3] Write failing tests in `migration/test/default-provider-profile.test.ts` (NEW, SC-003's doc/config-consistency test). Cases:
  - (a) read `.env.example` (or `package/.env.example`, byte-identical) and assert its documented default credential env var (`OPENAI_API_KEY`) matches `DEFAULT_GUILD_CONFIG.model.api_key_env`, and `DEFAULT_GUILD_CONFIG.model.base_url === "https://api.openai.com/v1"` — a real doc-vs-config equality assertion, not a hardcoded-string duplicate. **Must fail today**: `config.ts` lines 53–58 seed `api_key_env: "ROOTSYS_API_KEY"`, `base_url: "https://rootsys.cloud/v1"`.
  - (b) `scaffoldGuildConfig()` in a scratch dir produces a `.guild/config.yaml` whose `model:` block round-trips the same values (exercising `stringifySimpleYaml`/`parseSimpleYaml`, the same pattern `guild-config-openai-compatible.test.ts` already uses).
  - (c) recursively assert no seeded config field (`DEFAULT_GUILD_CONFIG`, JSON-stringified) contains the case-insensitive substring `dashscope`, `fiq/`, or `rootsys` — directly encoding SC-003's "zero default-provider references" bar for the seeded-config half of that criterion. **Must fail today**: `config.ts` lines 59–65 (`provider.routes`) and 80–87 (`profiles`) both contain `fiq/*` and `dashscope-intl` literals.

### Implementation for User Story 3

- [x] T010 [US3] Implement the fix in `migration/guildctl/config.ts`'s `DEFAULT_GUILD_CONFIG` (lines 46–88): rewrite the seeded defaults per FR-006 —
  - `model` (lines 53–58): `{ model: "<an OpenAI-compatible model id, e.g. gpt-4o-mini>", base_url: "https://api.openai.com/v1", api_key_env: "OPENAI_API_KEY", context_length: 131072 }` (`context_length` unchanged).
  - `provider.routes` (lines 59–65): replace all `fiq/*` identifiers in `default`/`census`/`review` with OpenAI-compatible model ids, internally consistent with `model.model`.
  - `agents` (lines 66–70): replace `deepseek-v4-pro`/`deepseek-v4-flash`/`glm-5.1` with OpenAI-compatible model ids; keep the `default`/`cheap`/`reviewer` key structure and `temperature` values unchanged.
  - `profiles` (lines 80–87): `default` → `{ base_url: "https://api.openai.com/v1", model: "<same id as model.model>", api_key_env: "OPENAI_API_KEY" }`; remove the `dashscope`, `cheap`, `reviewer`, `qwen` entries entirely (no profile may reference DashScope, per FR-006); leave `local` unchanged (already provider-neutral).
  `deepMerge` (line 337 in `resolveGuildConfig`) is untouched — only the seed values feeding it change. Depends on T009 (test must exist and fail first).
- [x] T011 [P] [US3] Update `migration/test/provider-routing.test.ts` (lines ~11, 13–24, 30–36): replace `ROOTSYS_API_KEY`/`fiq/*` literal assertions (`api_key_env`, the three `resolveProviderRoute` route arrays, the `preflightProviderCredential`/`redactConfigForDisplay` credential-env literal) with the new `OPENAI_API_KEY`/OpenAI-compatible-id equivalents. Depends on T010.
- [x] T012 [P] [US3] Update `migration/test/guild-config-openai-compatible.test.ts` (lines 21, 38, 52): `cfg.model.base_url === "https://rootsys.cloud/v1"` (line 21) and the YAML round-trip equivalent (line 38) → `"https://api.openai.com/v1"`; `delete process.env.ROOTSYS_API_KEY;` (line 52) → `delete process.env.OPENAI_API_KEY;` (this credential-env cleanup line was not itemized in `plan.md`'s per-line list but is in the same file/task as lines 21/38). Depends on T010.
- [x] T013 [P] [US3] Update `migration/test/env-precedence.test.ts`: replace `rootsys.cloud`/`ROOTSYS_API_KEY` literals used as realistic-looking fixture values throughout the file (e.g. lines ~232, 240, 254, 263, 267, 272, 277, 297, 449, 639, 664, 729, 734, 745) with `api.openai.com`/`OPENAI_API_KEY` equivalents. Depends on T010.
- [x] T014 [P] [US3] Update `migration/test/preflight-resolved-path.test.ts`: `CREDENTIAL_ENV = "ROOTSYS_API_KEY"` (line 39) and all dependent fixture URLs/models throughout the file (e.g. lines ~122, 129, 193, 348, 353, 531, 656) → OpenAI-compatible equivalents. Depends on T010.
- [x] T015 [P] [US3] Update `migration/test/runtime-resolution.test.ts`: `ROOTSYS_API_KEY` env fixtures throughout the file (e.g. lines ~44, 64, 90, 97, 109, 131, 156, 161, 183–210, 233–277, 371–443) and the `fiq/grok-4.5` model-divergence fixture (lines ~132, 138) → equivalents. Depends on T010.
- [x] T016 [P] [US3] Update `migration/test/auto-canary.test.ts`: `ROOTSYS_API_KEY`/`rootsys.cloud` propagation assertions throughout (e.g. lines ~638, 648, 654, 764–850) → `OPENAI_API_KEY`/`api.openai.com` equivalents. Depends on T010.
- [x] T017 [P] [US3] Update `migration/test/cli-run-phase-exit-code.test.ts` (line 172): `DASHSCOPE_API_KEY: "dummy"` env fixture → `OPENAI_API_KEY: "dummy"`. Depends on T010.
- [x] T018 [P] [US3] Update `migration/test/doctor-pipeline-state.test.ts` (line 282 ONLY — line 319's wording assertion is US4/FR-009, tracked in T023): `DASHSCOPE_API_KEY: "dummy"` env fixture → `OPENAI_API_KEY: "dummy"`. Same file as US4's T023 (different lines) — see "Same-File Sequencing" below. Depends on T010.
- [x] T019 [P] [US3] Update `migration/test/workspace-isolation-defaults.test.ts` (line 109): `DASHSCOPE_API_KEY: "dummy"` env fixture → `OPENAI_API_KEY: "dummy"` — identical doctor-credential-fixture pattern to T017/T018, found during this task list's re-verification of `plan.md`'s FR-007 grep surface (`plan.md` cited only 13 files; this repo's current `grep -lE 'DEFAULT_GUILD_CONFIG|rootsys|ROOTSYS|fiq/|dashscope' migration/test/*.test.ts` matches this 14th file too). Depends on T010.
- [x] T020 [US3] Verify (FR-007's full surface): from `migration/`, run `npm test` and confirm T009's new suite plus T011–T019's nine updated suites all pass, AND confirm the four structural-only files (`migration/test/limit-knob-naming.test.ts`, `migration/test/auto-queue.test.ts`, `migration/test/process-tree-termination.test.ts`, `migration/test/harness-selection.test.ts` — each imports/spreads `DEFAULT_GUILD_CONFIG` with no literal-value assertion on `model`/`profiles`) and the two incidental-literal files (`migration/test/evidence-runtime.test.ts`, `migration/test/verification-state.test.ts` — use `ROOTSYS_API_KEY` only as an arbitrary secret-shaped redaction-fixture name, not a `DEFAULT_GUILD_CONFIG` assertion) stay green with no edit (SC-003). Depends on T011–T019.

**Checkpoint**: US1–US3 are all independently functional — the tarball installs and boots, the build is self-sufficient, and a fresh `guildctl init` seeds a provider profile consistent with the shipped docs.

---

## Phase 6: User Story 4 - `doctor` reports *why* a present-but-failing harness fails (Priority: P4) — #148 Medium

**Goal**: `checkHarness` in `migration/guildctl/harness.ts` (lines 190–204), when the adapter file exists but the probe spawn returns non-zero or a spawn error, includes the adapter's actual stderr/stdout excerpt (trimmed, length-capped) in the failure message instead of the generic `(<command> is missing or unreachable)` wording — so a user whose Copilot CLI isn't installed sees the real cause instead of hunting for a file (`agent-shim.mjs`) that is fine.

**Independent Test** (spec.md): point a `HarnessResolution` at an adapter script that exists on disk and exits non-zero with a message on stderr, call `checkHarness` directly, and assert the failure message includes the adapter's stderr excerpt rather than the generic wording. Fully testable in a new `migration/test/*.test.ts` file.

### Tests for User Story 4 ⚠️

> Write these tests FIRST; case (a) MUST fail against the current, unmodified `harness.ts` before T022 is implemented.

- [x] T021 [P] [US4] Write failing tests in `migration/test/harness-stderr-excerpt.test.ts` (NEW). Build a fixture adapter script (a temp `.sh` file, mirroring `migration/test/harness-stderr.test.ts`'s existing `fake-agent.sh` pattern) that exits non-zero with a distinctive stderr string. Cases:
  - (a) a `HarnessResolution` with `source: "config"` pointing at the fixture script → `checkHarness()`'s returned `message` contains the stderr excerpt, not the generic wording (FR-008 Scenario 1). **Must fail today**: `harness.ts` lines 200–202 discard `result.stderr`/`result.stdout`/`result.error` entirely.
  - (b) a resolution pointing at a nonexistent path with `source: "config"` still returns the unchanged `missing adapter: <path>` message (regression, FR-008 Scenario 2, `harness.ts` line 192 unchanged).
  - (c) a resolution whose command cannot be spawned at all (spawn error, not non-zero exit) produces a message distinguishing "failed to start" from "exited N" (FR-008 Scenario 3).
  - (d) a genuinely healthy harness (e.g. `node --version` via a `source: "environment"` resolution pointing at `process.execPath`) still returns the unchanged `ok: true` message (FR-008 Scenario 4).
  - (e) a stderr string far longer than the cap is truncated in the message (mirrors `harness-stderr.test.ts`'s existing `HARNESS_OUTPUT_CAP` cap-verification pattern; `HARNESS_OUTPUT_CAP = 512` is exported from `migration/guildctl/runner.ts:98` and may be reused or a smaller local cap defined per spec.md's "~200 chars is plenty" — implementation detail, not spec-pinned).

### Implementation for User Story 4

- [x] T022 [US4] Implement the fix in `migration/guildctl/harness.ts`'s `checkHarness` (lines 194–203): distinguish the two non-ok cases — spawn error (`result.error` truthy) → `active harness: ${resolution.name} (${command} failed to start: <trimmed/capped result.error.message>)`; non-zero exit (`result.status !== 0`) → `active harness: ${resolution.name} (${command} exited ${result.status}: <trimmed/capped excerpt>)` where the excerpt is `(result.stderr || result.stdout || "").trim()`, capped. The `ok: true` branch (line 203) and the missing-adapter branch (lines 191–193) are byte-for-byte unchanged. No new credential-scrubbing logic — `checkHarness` never sees API keys, only the adapter's own `--version` stdio. Depends on T021 (test must exist and fail first).
- [x] T023 [US4] Update the two existing wording assertions (FR-009), verified to both hit the **spawn-error** branch (not non-zero-exit) since both fixtures point at a nonexistent command path (confirmed: `spawnSync` on a nonexistent, non-`.mjs`/`.cjs`/`.js` command path sets `result.error`, not just `result.status`):
  - `migration/test/harness-selection.test.ts` line 32: `assert.match(result.message, /active harness: custom.*missing or unreachable/)` — fixture at line 29 (`command: path.join(os.tmpdir(), "missing-harness-command")`, `source: "environment"`) → update the regex to match the new "failed to start" wording.
  - `migration/test/doctor-pipeline-state.test.ts` line 319: `assert.ok(result.some((r) => r.status === "fail" && /active harness: custom.*(missing or unreachable)/.test(r.message)))` — fixture at line 317 (`AGENT_CMD` pointing at a nonexistent temp path) → same regex update. Same file as US3's T018 (different line, 319 vs 282) — see "Same-File Sequencing" below.
  Depends on T022.
- [x] T024 [US4] Verify: from `migration/`, run `npm test` and confirm `migration/test/harness-stderr-excerpt.test.ts` passes (all cases) and `migration/test/harness-selection.test.ts` / `migration/test/doctor-pipeline-state.test.ts` remain green (SC-004). Depends on T022, T023.

**Checkpoint**: US1–US4 are all independently functional — packaging, build self-sufficiency, provider defaults, and harness diagnostics are each fixed and independently testable.

---

## Phase 7: User Story 5 - Shipped docs tell one consistent story (Priority: P5) — #148 Low

**Goal**: Five independent, low-risk edits close the remaining documentation/dead-file inconsistencies: a stale `guildctl.config.json` comment in `.env.example` (FR-010), a missing `--legacy-path` doc line in GETTING-STARTED.md (FR-011), two different pipeline command forms across README.md/GETTING-STARTED.md (FR-012), an unguarded piped-stdin EOF in the setup wizard (FR-013, MVP doc note + optional incremental code fix), and DashScope named as the shipped default anywhere in `README.md`, `.env.example` (×2), `package/agent-shim.mjs`, `package/harness/opencode.mjs`, plus removal of the dead `guildctl.config.json` (root + `package/`) and its `benchmark.ts:92` copy-list entry (FR-015/FR-016).

**Independent Test** (spec.md): `grep` the shipped docs for `guildctl.config.json` (expect zero non-legacy references) and `dashscope` (expect zero default-provider references), check `--legacy-path` appears in GETTING-STARTED.md's setup block, and diff the command forms used in README's pipeline table against GETTING-STARTED's pipeline block.

### Tests for User Story 5 ⚠️

> Write these tests FIRST; MUST fail against the current, unmodified docs/`package/` files before T026–T031 are implemented.

- [x] T025 [P] [US5] Write failing tests in `migration/test/doc-consistency.test.ts` (NEW). Cases:
  - (a) grep `.env.example`, `package/.env.example`, `README.md`, `GETTING-STARTED.md` for the case-insensitive substring `dashscope` and assert zero matches outside an explicitly-allowed optional commented-alternative line (if FR-015's optional incremental `# DASHSCOPE_API_KEY=` line is taken up in T026). **Must fail today**: `.env.example`/`package/.env.example` line 3 ("DashScope (Alibaba Qwen)... default for Migration Guild"), `README.md` lines 16/28/54.
  - (b) grep `.env.example`, `package/.env.example`, `README.md`, `GETTING-STARTED.md`, `AGENTS.md` for `guildctl.config.json` and assert zero non-comment matches (SC-005). **Must fail today**: `.env.example`/`package/.env.example` line 5.
  - (c) assert `GETTING-STARTED.md` contains the substring `--legacy-path`. **Must fail today**: the Setup block (lines 19–46) shows only `--legacy-url` (line 31).
  - (d) assert `README.md`'s "Pipeline at a glance" table (lines 71–83) and `GETTING-STARTED.md`'s "Run the pipeline" block (lines 105–117) both use the `guildctl run ` form exclusively for phase invocations (a targeted regex over each file's relevant section, not a whole-file scan, to avoid false positives from unrelated commands like `guildctl status`). **Must fail today**: README's table (lines 75–79) uses the bare `guildctl inventory`/`guildctl plan`/etc. form.
  - (e) grep `package/agent-shim.mjs` for `DASHSCOPE_API_KEY`/`dashscope-intl` and assert zero matches. **Must fail today**: lines 3, 13, 65, 67, 96.
  - (f) assert neither `guildctl.config.json` (root) nor `package/guildctl.config.json` exists as a file. **Must fail today**: both are present.

### Implementation for User Story 5

- [x] T026 [P] [US5] Edit `.env.example` and `package/.env.example` identically (FR-010/FR-015/FR-016): remove the DashScope block (lines 3–6), replace the stale `guildctl.config.json` comment (line 5) with a `.guild/config.yaml` profiles reference, document the OpenAI-compatible runtime (`OPENAI_API_KEY` + optional `OPENAI_BASE_URL` override) as the default. Optionally retain a commented `# DASHSCOPE_API_KEY=` line as one non-default alternative (FR-015's stated optional allowance) — if included, T025(a)'s test must allowlist that exact line. Keep the two files byte-identical (existing invariant, FR-010/FR-016). Depends on T025.
- [x] T027 [P] [US5] Edit `README.md` (FR-012/FR-015): reword lines 16, 28, 54 to drop "DashScope/Qwen default" framing in favor of generic OpenAI-compatible wording (the "Provider-neutral" bullet, the Quick start `cp .env.example .env` comment, and the Mermaid `LLM` node label); change the "Pipeline at a glance" table's Command column (lines 75–79) from bare `guildctl <phase>` to `guildctl run <phase>`, matching GETTING-STARTED.md. Depends on T025.
- [x] T028 [P] [US5] Edit `GETTING-STARTED.md` (FR-011): add a `--legacy-path <dir>` line to the Setup block's non-interactive alternative (after line 31), mirroring the existing `--legacy-url` line's phrasing. No DashScope wording found in this file during verification (confirmed via grep) — no further change needed here for FR-015. Depends on T025.
- [x] T029 [P] [US5] Edit `package/agent-shim.mjs` (FR-015): rename `DASHSCOPE_API_KEY`→`OPENAI_API_KEY` (the env var check at line 65 and its error message at line 67, plus the header-comment mention at line 13); `dashscope-intl` fallback base_url (line 96) → `https://api.openai.com/v1`; `COPILOT_MODEL` default (line 98) `deepseek-v4-pro` → an OpenAI-compatible model id; update the header comment (lines 2–3, 9). Identifier/comment changes only — no change to `parseArgs`, the `spawn` call shape, or the `--allow-all`/`--no-color`/`--model` argument construction (FR-014/FR-015's "no harness protocol, arg, or spawn changes"). Depends on T025.
- [x] T030 [P] [US5] Edit `package/harness/opencode.mjs` (FR-015): update the line-11 comment ("Unlike codex... opencode drives OpenAI-compatible chat/completions endpoints (e.g. DashScope)") to drop the DashScope example, replacing with provider-neutral phrasing. No functional change — `writeProviderConfig()` (lines 64–66) already defaults `baseURL` to `https://api.openai.com/v1` and `apiKeyEnv` to `OPENAI_API_KEY`. Depends on T025.
- [x] T031 [US5] Delete `guildctl.config.json` (root) and `package/guildctl.config.json` (FR-014/FR-016, verified byte-identical, read by nothing at runtime); remove the `"guildctl.config.json"` entry from the copy-list array in `migration/guildctl/commands/benchmark.ts` line 92 (`for (const name of ["guildctl.config.json", ".env.example", "agent-shim.mjs"] as const)`). The `fs.existsSync` guard already makes this loop tolerate the file's absence, so this is cleanup for clarity, not a behavior-preserving necessity. Depends on T025.
- [x] T032 [US5] FR-013 MVP (doc-only, default scope): add a one-line note to `GETTING-STARTED.md`'s Setup block stating the setup wizard is interactive-only and piped/batched stdin is unsupported. No `setup.ts` change. Depends on T025.
- [ ] T033 [US5] FR-013 incremental (separable — optional, only if this feature's scope is widened to include it; spec.md's Edge Cases explicitly names the doc note as MVP and this as incremental): add EOF detection to `setup.ts`'s readline prompt loop (lines 189–219) — e.g. an `rl.on("close", ...)` handler that, if triggered before all prompts resolved, prints a diagnostic naming the specific prompt in flight and exits non-zero. No new flags, no scripted-answer API (spec.md's explicit boundary). Add a corresponding case to `migration/test/setup-runinstall-legacy.test.ts` (the existing file already covering `setup.ts`'s legacy-source flags via its `runSetup()` helper) piping a truncated stdin stream into a spawned `setup.js` invocation and asserting a non-zero exit with the diagnostic. This task may be dropped from the implementation pass without affecting FR-013 compliance, since T032 alone satisfies the MVP bar. Depends on T025.
- [x] T034 [US5] Verify: from `migration/`, run `npm test` and confirm `migration/test/doc-consistency.test.ts` passes (all cases) and, if T033 was taken up, `migration/test/setup-runinstall-legacy.test.ts` remains green with its new case passing (SC-005). Depends on T026, T027, T028, T029, T030, T031, T032 (and T033 if included).

**Checkpoint**: All five user stories are now independently functional and testable — packaging, build self-sufficiency, provider defaults, harness diagnostics, and documentation consistency each pass their own regression suite without affecting the others.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Confirm all five fixes hold together and the full regression suite + spec's success criteria pass simultaneously.

- [x] T035 Run the full `migration/` regression suite (`npm test` in `migration/`, all of `test/*.test.ts`) once T004, T008, T020, T024, and T034 have each individually passed, confirming SC-001 through SC-005 hold simultaneously with no cross-story interaction — in particular that US3's `migration/test/doctor-pipeline-state.test.ts` line-282 edit (T018) and US4's line-319 edit (T023) coexist correctly in the same file. Depends on T004, T008, T020, T024, T034.
- [x] T036 [P] Run `npm run build:dist` from the repo root on a fully-installed clone (regression: US1/US2 must not have broken the existing, already-working build path) and confirm the produced tarball still boots per US1's smoke test (SC-001) end to end, outside the `migration/test/` suite's staged-temp-kit environment — a real top-level confirmation. Independent from T037 — can run in parallel.
- [x] T037 [P] Doc-grep confirmation pass (SC-003, SC-005) independent of the `migration/test/` suite, as a final human-readable check: `grep -ril dashscope .env.example package/.env.example README.md GETTING-STARTED.md package/agent-shim.mjs package/harness/opencode.mjs` returns nothing outside any allowed optional-alternative line; `grep -ril "guildctl.config.json" .env.example package/.env.example README.md GETTING-STARTED.md AGENTS.md` returns nothing outside a negation context (e.g. GETTING-STARTED.md:142's existing "**not** from `guildctl.config.json`" is fine — it documents what is NOT read, not a stale reference); confirm neither `guildctl.config.json` nor `package/guildctl.config.json` exists as a file. Independent from T036 — can run in parallel.
- [x] T038 Add a `CHANGELOGS.MD` `Unreleased` entry (constitution Dev-Workflow gate: "Notable changes MUST be added to `CHANGELOGS.MD`"): dated August 19, 2026 (matching this feature's verification date), summarizing this feature's five shipped-behavior fixes — (1) kit tarball packaging now includes `migration/package.json`, `migration/package-lock.json`, and `migration/registry_schema.sql` (FR-001..FR-003); (2) `npm run build:dist` performs its own nested `migration/`/`migration/ui/` installs and DEVELOPMENT.md documents all three install locations up front (FR-004..FR-005); (3) the seeded default provider profile (`DEFAULT_GUILD_CONFIG`) changes from an undocumented personal `rootsys`/DashScope profile to a generic OpenAI-compatible default (FR-006..FR-007); (4) `guildctl doctor`'s harness check reports the adapter's actual stderr/stdout excerpt instead of generic "missing or unreachable" wording when the adapter exists but fails (FR-008..FR-009); (5) documentation consistency fixes (`--legacy-path` documented, one canonical pipeline command form, stale `guildctl.config.json` references removed) plus deletion of the dead `guildctl.config.json` files (FR-010..FR-016). Follow the existing entries' style (issue/feature number, FR references, one-paragraph technical summary, full-suite pass count). Depends on T035 (all fixes landed and full suite green, so the entry can cite an accurate pass count).
- [x] T039 Verify the constitution's root-level `npm test` gate: from the repo ROOT (not `migration/`), run `npm test` (root `package.json`'s script: `npm --prefix migration test && npm --prefix migration/ui test`) and confirm both the `migration/` `node:test` suite and the Mission Control UI vitest suite (`migration/ui/*.test.tsx`/`*.test.ts`) pass. This closes CN2 — every other verify task in this feature (T001, T004, T008, T020, T024, T034, T035) scopes `npm test` to `migration/` only, so the UI suite's continued-green status is otherwise never confirmed as part of this feature's completion. Depends on T035.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately (T001).
- **Foundational (Phase 2)**: Empty — depends only on Setup (T001).
- **User Stories (Phases 3–7)**: All depend only on T001. The five stories touch disjoint production files and can proceed fully in parallel, or sequentially in priority order (P1 → P2 → P3 → P4 → P5, matching spec.md's stated severity ordering). The sole cross-story file touch is `migration/test/doctor-pipeline-state.test.ts` (US3's T018 at line 282, US4's T023 at line 319) — different lines, so not a hard blocking dependency, but avoid running T018 and T023 as truly simultaneous edits to the same file; sequence one after the other.
- **Polish (Phase 8)**: Depends on all five user story phases being complete (T004, T008, T020, T024, T034). T038 and T039 additionally depend on T035 (full-suite confirmation) so the `CHANGELOGS.MD` entry and the root-level test gate are the final two steps.

### User Story Dependencies

- **User Story 1 (P1)**: Can start after T001. No dependency on US2–US5.
- **User Story 2 (P2)**: Can start after T001. No dependency on US1, US3–US5.
- **User Story 3 (P3)**: Can start after T001. No dependency on US1, US2, US4, US5 (its one file overlap with US4 is a same-file-different-lines note, not a dependency).
- **User Story 4 (P4)**: Can start after T001. No dependency on US1–US3, US5 (same note as above).
- **User Story 5 (P5)**: Can start after T001. No dependency on US1–US4.

### Within Each User Story

- Test task(s) MUST be written and observed failing (for the specific new-behavior case) before the paired implementation task begins (Constitution Principle V).
- Within US3, T011–T019 (nine test-file updates) all depend on T010 (the `config.ts` edit) but are mutually independent (different files) — all nine may run in parallel once T010 lands.
- Within US5, T026–T033 (docs/`package/`/dead-file edits) all depend on T025 (the new doc-consistency test) but are mutually independent (different files) — all may run in parallel once T025 lands, except T031 (`benchmark.ts` + file deletion) and T033 (`setup.ts`) which touch files no other US5 task touches, so they carry no extra sequencing beyond T025.
- Each story's final task is an `npm test` verification run scoped to (at minimum) that story's new suite plus the pre-existing suites touching the same file(s).

### Same-File Sequencing (explicit)

- `scripts/build-dist.mjs`: T003 (US1, `assembleTarball()`) → T006 (US2, `main()`) — different functions in the same file; sequence T003 before T006 to avoid a merge conflict, though both are additive and could be reordered.
- `migration/guildctl/config.ts`: T010 only (single edit; no other task in this feature touches this file).
- `migration/guildctl/harness.ts`: T022 only.
- `migration/test/doctor-pipeline-state.test.ts`: T018 (US3, line 282) and T023 (US4, line 319) — different lines, same file; do not run as literally simultaneous edits.
- `.env.example` / `package/.env.example`: T026 only (both files, one task, kept byte-identical).
- `migration/guildctl/commands/benchmark.ts`: T031 only.
- `setup.ts`: T033 only (incremental, optional).
- All nine `migration/test/*.test.ts` files touched by T011–T019: one task each, no overlap between them.

### Parallel Opportunities

- T002 [US1], T005 [US2], T009 [US3], T021 [US4], and T025 [US5] are five different new test files, each depending only on T001 — all five can be written in parallel.
- T011–T019 (US3's nine test-file updates) can all run in parallel once T010 lands.
- T026–T030, T032 (US5's docs/`package/` edits) can all run in parallel once T025 lands; T031 and T033 are also parallel-safe with them (different files).
- T036 and T037 in Polish are independent checks and can run in parallel once all five stories' verify tasks are complete.
- The five user story phases as a whole can be staffed and executed in parallel by different people, since they share no production file (only the one noted test-file line overlap).
- T038 and T039 both depend only on T035 (not on T036/T037) and touch different files (`CHANGELOGS.MD` vs. a verify-only command) — they can run in parallel with each other and with T036/T037.

---

## Parallel Example: Kicking Off All Five Stories

```bash
# After T001 (Setup baseline) passes, launch all five stories' test-writing tasks together:
Task: "T002 [US1] Write failing tests in migration/test/build-dist-packaging.test.ts"
Task: "T005 [US2] Write failing tests in migration/test/build-dist-nested-install.test.ts"
Task: "T009 [US3] Write failing tests in migration/test/default-provider-profile.test.ts"
Task: "T021 [US4] Write failing tests in migration/test/harness-stderr-excerpt.test.ts"
Task: "T025 [US5] Write failing tests in migration/test/doc-consistency.test.ts"
```

---

## Implementation Strategy

### MVP Scope

Per `plan.md`'s "MVP vs Incremental Boundaries": **US1 and US2 are the P1/P2 Critical MVP core** — without them, the tarball is not installable and the build is not reproducible from documented steps, so nothing else in the kit matters until these land. US3 (P3) and US4 (P4) are Medium-severity guidance fixes that do not block reaching a running workspace but each closes one "user hits a wall with zero explanation" gap. US5 (P5) is documentation plus two dead-file deletions, sequenced last because it has no runtime impact. All five stories are in-scope for this feature (spec.md lists no deferred story); within US5, FR-013's `setup.ts` EOF-handling half (T033) has an explicit spec-sanctioned MVP/incremental split — T032 (doc note) is the default scope, T033 (code fix) is optional and separable.

### Recommended Delivery / Review Order (risk sequencing, not scope deferral)

Because the five stories are file-disjoint and independently testable, they may be implemented in any order or in parallel. For staged code review and risk management, follow spec.md's stated priority rationale:

1. **US1 (P1) first** — the dominant onboarding-time risk: a tarball-only consumer who cannot install has no recovery path at all.
2. **US2 (P2) second** — compounds US1: not only is the output broken, the build itself is broken for anyone following the docs (but maintainers can recover from source; tarball-only users cannot).
3. **US3 (P3) third** — every doc-following fresh `init` hits a confusing `doctor` failure on an undocumented credential.
4. **US4 (P4) fourth** — the partial pass on a prior onboarding wave: fail-closed behavior already works, only the diagnosis quality is wrong.
5. **US5 (P5) last** — pure documentation edits with no runtime impact.

### Incremental Validation

1. Complete Setup (T001) → baseline established.
2. Complete US1 (T002–T004) → **STOP and VALIDATE**: a freshly built tarball, extracted cold, installs and passes the GETTING-STARTED.md smoke test.
3. Complete US2 (T005–T008) → **STOP and VALIDATE**: `npm run build:dist` succeeds from a clone with only the root `npm install` run.
4. Complete US3 (T009–T020) → **STOP and VALIDATE**: a fresh `guildctl init`'s `.guild/config.yaml` seeds `https://api.openai.com/v1` / `OPENAI_API_KEY`, consistent with `.env.example`.
5. Complete US4 (T021–T024) → **STOP and VALIDATE**: `guildctl doctor` against a present-but-failing adapter reports the adapter's real stderr excerpt, not generic wording.
6. Complete US5 (T025–T034) → **STOP and VALIDATE**: zero `dashscope`/`guildctl.config.json` references in shipped docs; `--legacy-path` documented; one pipeline command form across README.md and GETTING-STARTED.md.
7. Complete Polish (T035–T039) → full-suite confirmation (SC-001–SC-005 simultaneously), a top-level `build:dist` + doc-grep sanity pass outside the test suite, a dated `CHANGELOGS.MD` entry, and a root-level `npm test` pass confirming the Mission Control UI suite stays green.

---

## Notes

- [P] tasks touch different files and have no dependency on an incomplete task.
- [Story] label maps each task to its user story (US1–US5) for traceability; Setup/Foundational/Polish tasks carry no story label per the task-format rules.
- Every implementation task (T003, T006, T010, T022, T026–T033) is preceded in its phase by a test task (T002, T005, T009, T021, T025) that must exist and fail (for the new-behavior case) first — Constitution Principle V.
- FR-014's scope fence is honored throughout: no task in this list touches registry, claims, evidence-gate, arbitration, audit-rule, or UI code. The only files touched are `scripts/build-dist.mjs`, `migration/guildctl/config.ts`, `migration/guildctl/harness.ts`, `migration/guildctl/commands/benchmark.ts` (one array entry), `package/agent-shim.mjs`, `package/harness/opencode.mjs` (comment only), two `guildctl.config.json` deletions, `setup.ts` (optional, T033 only), documentation (`README.md`, `GETTING-STARTED.md`, `DEVELOPMENT.md`, `.env.example` ×2), `CHANGELOGS.MD` (T038, a dev-workflow-gate entry, not a functional change), plus new/updated files under `migration/test/`.
- Task total: 39 numbered tasks (T001–T039) across 8 phases. T038 (`CHANGELOGS.MD` entry) and T039 (root `npm test` verification) close the constitution's two Dev-Workflow gates identified in this feature's analyze pass (CN1, CN2) — neither adds a functional change, both are additive verification/documentation steps gated on T035.
- This task list makes **no source changes itself** — it is a planning artifact. Task execution is a separate, later step.
- Avoid: vague tasks, same-file conflicts marked [P], cross-story dependencies that would break independent testability.
