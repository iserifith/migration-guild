# Tasks: Truthful Run State

**Input**: Design documents from `/specs/001-truthful-run-state/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md), `.specify/memory/constitution.md` v1.0.0

**Tests**: REQUIRED, not optional. Constitution Principle V (*Tests Before Production Code*) is
non-negotiable, and this feature touches claims, run lifecycle, warden reporting, and phase control
flow — the exact surfaces the constitution names as requiring regression tests. plan.md § Constitution
Check records "tests-first is mandatory and is carried into task ordering". Every phase below writes
its tests before its production code.

**Organization**: Tasks are grouped by user story (P1–P6 from spec.md) so each story can be
implemented, tested, and delivered independently.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Which user story this task belongs to (US1–US6); absent on Setup, Foundational, Polish
- Every task names its exact repository file path

## Path Conventions

This repository is the **source of the Migration Guild kit**, not a migration workspace. Two source
roots with a strict boundary the constitution mandates (Repository Source-of-Truth Boundaries):

- `migration/` — runtime: registry + guildctl. Repo-only source of truth.
- `package/` — source of truth for everything shipped into user workspaces.
- `stacks/<id>/stack.yaml` and `package/stacks/<id>/stack.yaml` MUST be byte-identical and stay so; T069 first reconciles the pre-existing Python-pack difference.
- `migration/test/` is flat: the suite glob is `test/*.test.ts`, so a helper file must not end in
  `.test.ts`.
- Runtime code is **never** mirrored between `migration/` and `package/`.

## Scope Guard

Confirmed scope: issue **#49** (selected slices a–d only), **#50**, **#52**, **#53**.

Excluded and MUST NOT acquire tasks here: **#43** (Phase 0 excision), **#48** (quarantine
architecture), **#51** (as-written absolute/relative diagnosis), and closed **#40 / #44 / #45**. Also
excluded: a separate post-`migrated` verify pipeline phase, toolchain provisioning, re-materializing
stored context trees, broadening agent write authorization, and any change to the set of migration
statuses.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: establish the pre-feature baseline and the hermetic test seams every later suite needs.

- [x] T001 Install workspace dependencies and build the runtime from the repository root per quickstart.md: `npm install`, `npm --prefix migration install`, `npm --prefix migration/ui install`, `npm --prefix migration run build`
- [x] T002 Record the pre-feature `npm test` baseline (the `migration/test/` suite plus the `migration/ui/` suite) before any source change, and note any pre-existing failure so it is never attributed to this feature — procedure in `specs/001-truthful-run-state/quickstart.md`
- [x] T003 [P] Create the shared hermetic-fixture helper `migration/test/truthful-run-state-fixtures.ts` exporting an injectable-`fetch` provider stub, a fake harness adapter writer, and a SIGTERM-ignoring grandchild-spawner script writer; filename deliberately excludes `.test.ts` so the `test/*.test.ts` glob skips it, and it follows the portability conventions already in `migration/test/run-reliability.test.ts` (cwd-derived repo root, `file://` tsx loader URLs)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: registry schema delta, shared types, config keys, and the two shared resolvers that more
than one user story consumes. Placing them here is what keeps US1–US6 independently deliverable.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [x] T004 Write the failing foundational regression tests before the foundational implementations: schema upgrade coverage in `migration/test/registry-schema-delta.test.ts` (fresh and in-place registries end with the `artifact_verifications` table, all eight new `runs` columns, and the three new indexes, with no existing table, column, `CHECK`, trigger, or index modified or dropped); `finishRun` persistence coverage in `migration/test/run-outcome-plumbing.test.ts`; shared runtime-resolution coverage in `migration/test/runtime-resolution.test.ts`; graceful/forced/confirmed process-group primitive coverage in `migration/test/process-group-primitives.test.ts`; and the existing `stacks/` ↔ `package/stacks/` byte-parity baseline in `migration/test/stack-pack-engine.test.ts`
- [x] T005 Add the `artifact_verifications` table and `idx_artifact_verifications_state` / `idx_artifact_verifications_run` to the base section of `migration/registry_schema.sql`, exactly as specified in `specs/001-truthful-run-state/contracts/registry-schema.md` §1
- [x] T006 [US1] Add the eight attempt-outcome columns (`files_written_count`, `files_written_source`, `status_from`, `status_to`, `budget_consumed`, `cleanup_outcome`, `survivor_pids`, `outcome_label`) to the base `CREATE TABLE runs`; create `idx_runs_outcome_label` only after the guarded existing-database column upgrades so the base schema batch remains safe for in-place upgrades
- [x] T007 Register all eight new `runs` columns with the `ensureColumn()` guard at the end of `applySchema()` in `migration/registry/db/schema.ts` — required because this SQLite build rejects `ADD COLUMN IF NOT EXISTS`; adding only the `ALTER TABLE` half leaves existing databases wrong
- [x] T008 [P] Add `VerificationState`, the closed verification-reason vocabulary (`not-attempted`, `no-stack-check`, `tree-incomplete`, `budget-exhausted`, `agent-reported-unverifiable`, `check-failed`, `check-error`), `VerificationRecord`, `AttemptOutcome`, and `ContextResponse` to `migration/registry/types.ts`
- [x] T009 [P] Add config keys `verification.budget_seconds` (default 120, overridable by `GUILDCTL_VERIFY_BUDGET_SECONDS`), `preflight.budget_seconds` (default 30, overridable only by the preflight flag), and `agent_limits.termination_grace_seconds` (default 5, replacing the value hardcoded in the runner) to `migration/guildctl/config.ts`
- [x] T010 Extend `finishRun` in `migration/registry/commands/runs.ts` to accept and persist the eight attempt-outcome fields in the same transaction that closes the run (plumbing only — label derivation and domain validation belong to US4 T050)
- [x] T011 Add the optional `finish-run` flags (`--files-written`, `--files-written-source`, `--status-from`, `--status-to`, `--budget-consumed`, `--cleanup-outcome`, `--survivor-pids`, `--outcome-label`) and emit the new columns from `list-runs --json` in `migration/registry/cli.ts`; omitting every new flag must reproduce today's behaviour exactly
- [x] T012 [P] Add `resolveAgentLaunch()` to `migration/guildctl/harness.ts` returning launch-private `ResolvedRuntimeConfig` plus a secret-free `ResolvedRuntimeReport` projection (harness name/command/source, provider base URL, model, `credentialEnv` name only, divergences[]); re-point `migration/guildctl/runner.ts` at the resolver and require all operator/reporting paths to use the projection (FR-011, FR-019)
- [x] T013 [P] Add platform-conditional process-group termination primitives to `migration/guildctl/util.ts` — POSIX `process.kill(-pgid, SIGTERM|SIGKILL)` with `kill(-pgid, 0)`/`ESRCH` confirmation, Windows `taskkill /PID <pid> /T [/F]` with `tasklist` confirmation — consumed by US1's verification budget (T026) and US5's attempt termination (T057)

**Checkpoint**: schema, types, config, and both shared resolvers exist. User story implementation can now begin.

---

## Phase 3: User Story 1 - `migrated` stops meaning "maybe compiles" (Priority: P1) 🎯 MVP

**Goal**: migration status and verification state become two separate recorded facts. Every artifact
reaching `migrated` carries whether its own output was checked, by what method, and when — with an
explicit *unverified* state rather than silence. Verification is bounded to the claimed unit plus one
hop of declared dependencies, never waits on a tree-wide build, and never blocks an artifact whose
neighbours simply have not been migrated yet.

**Independent Test**: run a migration wave against a workspace whose overall build cannot succeed,
then query status. Delivers value if artifacts still advance, every advanced artifact reports a
verification state and reason, and the verified / unverified / verification-failed split is visible
without reading logs.

**Requirements**: FR-001–FR-010. **Success criteria**: SC-005, SC-006, SC-007.

### Tests for User Story 1 ⚠️

> Write these FIRST and confirm they FAIL before any implementation task in this phase.

- [x] T014 [P] [US1] Write `migration/test/verification-state.test.ts`: the three states and the closed reason vocabulary; `reason` required and non-empty whenever `state <> 'verified'`; `verified` requires non-null `duration_ms` and non-empty `scope_json`; missing row coalesces to `unverified` / `not-attempted` / `none` through the `LEFT JOIN` read-model; upsert is last-write-wins with an `events` audit row; `detail` passes `redactSecrets()`; verification resets to `unverified` / `not-attempted` when the artifact re-enters `in-progress` or `needs-rework`; and the US1 close-out summary renders verification state, method, and reason separately from migration status
- [x] T015 [P] [US1] Write `migration/test/verification-bounds.test.ts`: scope is the claim's `expected_output_paths` plus one-hop `source_dependencies` + `dependencies` and never the transitive closure; every substituted path is asserted inside the workspace root via `isPathInside` and a path escaping it yields `verification-failed` / `check-error`; the budget terminates the check's process group and records `unverified` / `budget-exhausted` while the claim still closes; an unmigrated one-hop dependency yields `unverified` / `tree-incomplete` and the artifact still advances; no filesystem globbing and no read outside the workspace occurs
- [x] T016 [P] [US1] Extend `migration/test/arbiter-gate.test.ts` with the Constitution IV enforcement point from research R11: an artifact with `artifact_verifications.state = 'verified'` and no passing `acceptance_evidence` row is still **rejected** by arbitration, and verification state can neither substitute for evidence nor unlock a status transition
- [x] T017 [P] [US1] Extend `migration/test/stack-pack-engine.test.ts` for the `verify:` block in `specs/001-truthful-run-state/contracts/stack-pack-verify.md`: schema parsing, placeholder expansion (`{artifact_path}`, `{output_paths}`, `{dependency_paths}`, `{scope_paths}`, `{module}`, `{workspace_root}`) passed as discrete argv entries with `shell: false`, absence of any `{all_artifacts}` placeholder, a failing `availability_args` probe mapping to `unverified` / `no-stack-check` rather than `verification-failed`, and a pack with no `verify:` block mapping to `no-stack-check`
- [x] T018 [P] [US1] Extend `migration/test/warden.test.ts` for FR-010: an attempt blocked by a required change outside its authorized output paths records the `blocked:out-of-scope-path` tag plus a `filesystem-violation` event carrying `{ out_of_scope_paths, claim_id, run_id }`, while the warden's existing restore-and-fail behaviour and its allow-list are unchanged and the offending path is never added to any allow-list

### Implementation for User Story 1

- [x] T019 [US1] Create `migration/registry/commands/verification.ts` with `setVerification` / `getVerification` / `listVerification`, enforcing the above-schema invariants (reason vocabulary, `verified` requires duration + scope), `redactSecrets()` on `detail`, the coalescing `LEFT JOIN` read-model, the `ON CONFLICT (artifact_id) DO UPDATE` upsert, and the companion `events` audit row; it must never write `artifacts.status`, never write `acceptance_evidence`, and never unlock a gate
- [x] T020 [US1] Register `set-verification`, `get-verification`, and `list-verification` in `migration/registry/cli.ts` per `specs/001-truthful-run-state/contracts/registry-cli.md` §A — active claim token or valid run operator credential required (a privileged-looking actor name does not bypass it), exit `0`/`1`/`2` with a missing verification row returning exit `0` and the coalesced default
- [x] T021 [US1] Add the verification invalidation reset (state → `unverified`, reason → `not-attempted`) when an artifact enters `in-progress` or `needs-rework` in `setArtifactStatus` in `migration/registry/commands/artifacts.ts`, mirroring the content-bound evidence rule of Constitution I
- [x] T022 [US1] Add `verification_state` and `verification_reason`, read through the coalescing `LEFT JOIN`, to `getArtifact`, `listArtifacts`, and `showStatus` in `migration/registry/commands/queries.ts` so review and arbitration consumers can treat `unverified` and `verification-failed` as triageable conditions
- [x] T023 [US1] Parse the optional `verify.per_artifact` block (`id`, `cmd`, `args`, `availability_args`, `working_dir`, `budget_seconds`, `pass_exit_codes`, `unavailable_note`) in `migration/guildctl/stack.ts`, treating it as data only — no build or test command may enter core runtime (Constitution VII)
- [x] T024 [P] [US1] Add the `verify.per_artifact` block acting on `{scope_paths}` with declared `availability_args` to `stacks/java-spring/stack.yaml` and copy it byte-identically into `package/stacks/java-spring/stack.yaml`
- [x] T025 [P] [US1] Add the `verify.per_artifact` block acting on `{scope_paths}` with declared `availability_args` to `stacks/python/stack.yaml` and copy it byte-identically into `package/stacks/python/stack.yaml`
- [x] T026 [US1] Implement bounded per-artifact verification in `migration/guildctl/verify.ts`: build the `VerificationScope` from registry rows only, assert containment with `isPathInside`, probe `availability_args` first, `spawn` with `shell: false` under `scrubVerificationEnv()`, enforce the budget by terminating the check's process group via the T013 helpers, and map outcomes per `specs/001-truthful-run-state/contracts/stack-pack-verify.md` § Outcome mapping
- [x] T027 [US1] Invoke verification at claim close and persist the record through the registry in both `migration/guildctl/runner.ts` and the autonomous close path in `migration/guildctl/supervisor/loop.ts`, ensuring no verification outcome ever blocks the artifact from advancing; emit verification state, method, and reason in the same attempt close-out block as migration status on both paths; and ensure a run whose agent reported it could not verify its own output records `unverified` / `agent-reported-unverifiable` instead of reading as a verified completion (FR-006, FR-007)
- [x] T028 [US1] Record the `blocked:out-of-scope-path` tag and the `filesystem-violation` event payload naming the offending path in `migration/guildctl/warden.ts`, leaving restore-and-fail behaviour and the allow-list untouched
- [x] T029 [US1] Add the `COUNT`-shaped verification split (`verified · unverified · verification-failed`) with the `registry list-verification --state <state>` pointer to `migration/guildctl/commands/status.ts` per `specs/001-truthful-run-state/contracts/guildctl-cli.md` §H
- [x] T030 [US1] Surface verification state and reason as triage input in `migration/guildctl/commands/review.ts`, explicitly without granting it any approval or gate-unlocking power (FR-009, research R11)
- [x] T031 [US1] Add the verification-reporting expectation — agents record their own bounded check outcome through `set-verification`, and state `agent-reported-unverifiable` rather than closing silently — to `package/agent-instructions.md` (same file as T054; do not run the two in parallel)

- [x] T031a [Foundational] Extend the shared launch resolver for both autonomous launch sites in `commands/auto.ts` (scripted worker and reviewer) by routing them through `resolveAgentLaunch()` with an explicit `route` plus attempt/model-selection option delegating to `resolveProviderRoute`; extend the existing `runtime-resolution.test.ts` assertions to cover both autonomous routes; the safe-report projection is already covered by the MVP test at `runtime-resolution.test.ts:78`

**Checkpoint**: User Story 1 is fully functional and independently testable. This is the MVP.

---

## Phase 4: User Story 2 - Preflight fails when the run would fail (Priority: P2)

**Goal**: preflight exercises the same resolution and the same environment a phase run will use,
issues one minimal end-to-end request, and asserts on the response. It reports the harness, provider,
and model actually resolved, and flags divergence from project configuration even when the call
succeeds.

**Independent Test**: configure a credential that is set but not usable, point the ambient environment
at a different model than the project configuration declares, and run preflight. Delivers value if
preflight fails, names the credential/provider stage as the cause, and prints the resolved provider
and model.

**Requirements**: FR-011–FR-019. **Success criteria**: SC-001, SC-002.

### Tests for User Story 2 ⚠️

- [x] T032 [P] [US2] Write `migration/test/preflight-resolved-path.test.ts` using the injectable-`fetch` stub and fake adapter from `migration/test/truthful-run-state-fixtures.ts`: table-driven direct-provider mapping (`401`/`403` → `authorization`; `429`/quota body → `authorization`; `404`/model-not-found body → `model-availability`; network error, malformed body, or empty completion → `response`; `2xx` with non-empty completion → pass); a resolvable adapter whose direct provider request returns an empty completion is **not** a pass; an environment-sourced harness (`AGENT_CMD`) is still gated; budget elapse returns `fail` citing the elapsed budget; `--offline` returns the third verdict `unvalidated` and never `pass`; divergences are reported even on success; the credential value appears in no output path while its setting name always does; preflight and the runner resolve through the same `resolveAgentLaunch()`; doctor delegates to preflight, including explicit `doctor --offline` reporting `unvalidated`; and `commands/auto-run.ts` gates the queue on one shared preflight verdict before dispatching work

### Implementation for User Story 2

- [x] T033 [US2] Create `migration/guildctl/preflight.ts` implementing two stages (`resolution` via `resolveAgentLaunch()`, then one live direct-provider model request through the resolved base URL/model using injectable `fetch` with provider failure mapping to `authorization` / `model-availability` / `response`), one shared wall-clock budget read from `config.preflight.budget_seconds` (default 30 seconds, with the CLI override applied per invocation), the three verdicts `pass` / `fail` / `unvalidated`, the fail-closed rule of FR-015, and adapter reachability validation during resolution when required; an empty provider completion is never a pass and the path must not issue a second completion request
- [x] T034 [US2] Register `guildctl preflight [--offline] [--json] [--budget-seconds <n>]` in `migration/guildctl/cli.ts`, using the already-global `--profile <name>` option rather than re-declaring a command-level shadow, honouring `GUILD_PREFLIGHT_OFFLINE=1`, always printing the `resolved` block on both pass and fail, and exiting `0` for `pass` and `unvalidated`, `1` for `fail`
- [x] T035 [US2] Replace the three model / harness / credential checks with delegation to `preflight` in `migration/guildctl/cli.ts` (where the current doctor command action lives), keep the config, prompt-pack, git, and pipeline-state checks unchanged, add and test explicit `doctor --offline` handling that reports the `unvalidated` verdict rather than a green tick, and unconditionally gate `commands/auto-run.ts` on one shared preflight verdict before any autonomous artifact is claimed regardless of harness source; remove the per-artifact `preflightProviderCredential(cfg)` gate from `commands/auto.ts` rather than retaining a second credential-only path, accept only `pass` for autonomous dispatch (both `fail` and `unvalidated` block claims), and reuse the queue verdict rather than issuing one live request per artifact

**Checkpoint**: User Stories 1 and 2 both work independently.

---

## Phase 5: User Story 3 - The project file wins, and every divergence is spoken aloud (Priority: P3)

**Goal**: project-local `.env` values take precedence by default, ambient precedence requires an
explicit opt-in, and any variable defined in both places with differing values is always reported —
variable name, both values, and the winner — whichever side won. Every phase run announces the
provider and model actually in effect.

**Independent Test**: set a variable to one value in the project `.env` and a different value in the
ambient environment, then run any phase. Delivers value if the project value is used, the divergence
line names both values and the winner, and the run-start line reports the resolved provider and model.

**Requirements**: FR-020–FR-026. **Success criteria**: SC-003, SC-004.

> This is the one intended behaviour change in the feature; FR-026 exists because of it.

### Tests for User Story 3 ⚠️

- [x] T036 [P] [US3] Write `migration/test/env-precedence.test.ts`: without opt-in the workspace `.env` value wins; with `GUILD_ENV_PRECEDENCE=ambient` or `--ambient-env` the ambient value wins; the divergence set is computed before either side is applied and reported regardless of winner or mode; a variable matching `isSensitiveEnvName` has **both** values replaced with `<redacted>` while name and winner remain; variables in only one source, identical values, and CLI-install-relative-only values are not divergences; the bootstrap rule — mode is read only from the ambient snapshot and the flag, never from a `.env`; today's inter-file candidate order (first file defining a variable wins) is preserved; an absent workspace `.env` still prints the run-start line; `.env`-set `GUILDCTL_STALL_MINS` is observed at module scope; SC-003 reproducibility — identical checkouts with differing ambient environments resolve the same provider and model; and the run-start line and the launch passed to `spawnAgent` share the same `ResolvedRuntimeConfig` object identity, including a config divergence that names setting, declared value, resolved value, and source

### Implementation for User Story 3

- [x] T037 [US3] Export the existing module-private `isSensitiveEnvName` predicate from `migration/guildctl/verify.ts`, extend `ConfigDivergence` with `source: "ambient" | "project-file" | "config"` and populate it in `harness.ts` from an explicit `envOrigin` map supplied by the T037 loader, then create `migration/guildctl/env.ts` implementing the snapshot-then-apply loader of `specs/001-truthful-run-state/contracts/environment-precedence.md` §B — snapshot ambient `process.env`, parse each candidate with `dotenv.parse` (no side effects), compute workspace `.env` `EnvDivergence[]`, apply precedence, emit the report — reusing that predicate so one definition of "secret" governs evidence logs, preflight output, and this report alike; name-based `<redacted>` in the divergence report is authoritative for values from the losing ambient snapshot
- [x] T038 [US3] Replace the implicit three-candidate `dotenv` auto-load at the top of `migration/guildctl/cli.ts` with the T037 loader and add the global `--ambient-env` flag, keeping the existing candidate order; when a variable is defined in an install-relative file, workspace `.env`, and ambient environment, the workspace `.env` participates in precedence/divergence and the install-relative value is compatibility-only and never wins; explicitly do not use `dotenv`'s `override: true`; pre-scan `process.argv` for `--ambient-env` only before module-level loading, then let Commander perform the authoritative parse; keep the loader at module scope before the first command import so import-time environment readers observe applied values
- [x] T039 [US3] Create `migration/guildctl/runtime-report.ts` as the shared rendering helper for the run-start line and divergence block; it must consume the existing secret-free `toResolvedRuntimeReport()` projection from `harness.ts` plus the T037 `EnvDivergence[]` as separate inputs and never recreate or serialize `agentEnv`. At each manual phase entry, resolve once, render from that object, and pass the same `ResolvedRuntimeConfig` through `SpawnAgentOpts`; `spawnAgent` merges only run-scoped `extraEnv` onto the supplied `agentEnv` and MUST NOT re-resolve when a resolution is supplied. Emit exactly once per nine manual entry points — `inventory`, `plan`, `migrate`, `review`, `remediate`, and the four emitting benchmark actions — and exactly once per autonomous queue from `migration/guildctl/commands/auto-run.ts`; `commands/auto.ts`, `supervisor/queue.ts`, and `spawnAgent` emit nothing. Cover all manual phases plus autonomous dispatch without printing credential values.
- [x] T040 [P] [US3] Document project-local `.env` precedence, the `GUILD_ENV_PRECEDENCE=ambient` / `--ambient-env` opt-in, and that this is a **change in behaviour** in `README.md`
- [x] T041 [P] [US3] Document the same three points plus the concrete `AGENT_CMD` migration note (a workspace whose `.env` sets `AGENT_CMD` now wins over an exported ambient `AGENT_CMD`) in `GETTING-STARTED.md`
- [x] T042 [P] [US3] Record the environment-precedence behaviour change under `Unreleased`, grouped by a human-readable date heading, in `CHANGELOGS.MD`

**Checkpoint**: User Stories 1–3 all work independently.

---

## Phase 6: User Story 4 - Kill messages name the real knob, summaries name the real outcome (Priority: P4)

**Goal**: a limit message names the knob that actually governed the limit that fired, its effective
value, and where that value came from; the precedence order is inspectable before a run. The closing
summary states files written, status transition, claim disposition, and budget consumption in one
place, and never labels a no-progress termination with a success-equivalent outcome.

**Independent Test**: run a phase with a deliberately short per-phase limit and let an agent hit it.
Delivers value if the message names the phase knob (not the overridden project-configuration setting)
with its effective value and source, and the summary reports zero files written, no status advance,
and spent budget.

**Requirements**: FR-027–FR-034. **Success criteria**: SC-008, SC-010, SC-012.

### Tests for User Story 4 ⚠️

- [x] T043 [P] [US4] Write `migration/test/limit-knob-naming.test.ts`: the termination message reads `knob`, `effectiveValueMs`, and `source` from the same `EffectiveLimit` descriptor enforcement used, so it is structurally impossible to name a knob that does not govern; changing the named knob changes the observed limit; the inactivity limit firing names the inactivity knob under the same rule; environment overrides are named when they govern; when a phase-specific timeout env var is unset, tier 1 is unoccupied and resolution falls through to the global environment override, project configuration, or phase built-in default; the test pins `project-configuration` versus `built-in-default`; `floorApplied` reports the enforced `effectiveValueMs` rather than the requested `requestedValueMs` for the per-phase 5-minute or 1-minute floor; malformed timeout input normalizes to the built-in default; `guildctl limits` prints each phase's effective limit, knob, and the four-tier precedence order; autonomous worker-path mapping is `migrate`→`code-writing` and `repair`→`remediation`, with a limit rejection recorded through the worker-error per-artifact block; autonomous review-path mapping is `review`, with a limit rejection recorded through a review-error per-artifact block that leaves independent queue work runnable; both paths use the same `resolveEffectiveLimit()` as the manual runner, quote the same descriptor fields, and persist a `terminationReason` with the same enforced value
- [x] T044 [P] [US4] Write `migration/test/attempt-outcome.test.ts`: `outcome_label` is computed, never supplied by an agent; `no-progress` requires `files_written_count = 0` **and** `status_from = status_to`; a terminated attempt that wrote files is `released-retryable`, not `no-progress`; `succeeded` is rejected whenever `status_from = status_to`; `files_written_source` records `warden-snapshot` / `git-diff` / `unavailable` and a non-git workspace no longer reports a false "(none)"; the counted repeat-waste condition is derived from `runs ⋈ artifact_claims`, never a stored counter; terminal reason, outputs-produced, and post-cleanup status are answerable from recorded state without reading logs

### Implementation for User Story 4

- [x] T045 [US4] Create and export `migration/guildctl/limits.ts` with the single `resolveEffectiveLimit(phase, kind)` resolver returning the `EffectiveLimit` descriptor (`phase`, `kind`, `knob`, `effectiveValueMs`, `requestedValueMs`, `source`, `floorApplied`, `precedenceOrder`) for both ceiling and inactivity kinds. Implement precedence per-phase setting → environment override (`GUILDCTL_AGENT_CEILING_SECONDS`, `GUILDCTL_INACTIVITY_TIMEOUT_SECONDS`) → project configuration → built-in default; a phase-specific timeout env var participates in tier 1 only when explicitly set, otherwise tier 1 is unoccupied and resolution falls through; provide this resolver for T047 to replace the enforcement computation at `runner.ts:689-698`, rather than duplicating the logic. Source tier 1 knob/default/floor definitions from `migrate.ts:24-26`, `remediate.ts:11`, `review.ts:11`, and `inventory.ts:255-257`, then repoint those call sites so no second copy survives; the inactivity kind has no per-phase tier or floor today, so its resolution starts at the environment override. Distinguish an explicitly declared `agent_limits` project value from the deep-merged built-in config so an absent project setting reports `built-in-default`; apply each ceiling phase's documented minimum in minutes before converting to milliseconds (5 minutes for analyze/test/code-writing/remediation, 1 minute for review/inventory), set `floorApplied` only when the floor raised the value, and normalize unparseable input to the built-in default rather than propagating `NaN`
- [x] T046 [US4] Register `guildctl limits [--phase <phase>] [--json]` in `migration/guildctl/cli.ts` per `contracts/guildctl-cli.md` §C, printing the four-tier precedence line and the per-phase table with the `floor` column stating the requested value when a minimum was applied; make clear this reports time limits and is unrelated to `auto-run --limit <n>`, which limits artifact count
- [x] T047 [US4] Add ceiling and inactivity enforcement around the per-artifact worker dispatch, resolving through the T045 `resolveEffectiveLimit()` descriptor. The autonomous spawns are both in `migration/guildctl/commands/auto.ts` (worker `:278`, review `:132`); `auto-run.ts` delegates via `runAutoQueue` → `runAutoCommand`. Assign the autonomous review spawn a phase and enforce both limits so the directly launched process is bounded; descendant-process cleanup remains the separate US5 responsibility (T056–T057). Replace the enforcement computation at `migration/guildctl/runner.ts:689-698` with the resolver, and replace both manual limit message sites — the `killAgent` stderr message (`:709`) and persisted `terminationReason` (`:594-602`) — with text quoting `knob`, `effectiveValueMs`, and `source` from the single enforcing descriptor
- [x] T048 [US4] Count files written from the warden snapshot diff, falling back to the existing git diff only when no warden snapshot exists, and record which mechanism produced the count in `files_written_source` in both `migration/guildctl/runner.ts` and `migration/guildctl/supervisor/loop.ts`; for autonomous limit terminations, `auto.ts` surfaces the descriptor-derived limit error through the worker rejection into `supervisor/loop.ts`'s `workerError` per-artifact close-out path, which persists that reason; a review-spawn limit rejection from `guardedIndependentReview` must use a corresponding review-error per-artifact close-out path rather than the outer queue-halting catch, and must persist the descriptor-derived `terminationReason`. Do not rewrite unrelated autonomous `finishRun` reasons for drift, violations, rejection, or budget outcomes. If neither a warden snapshot nor a usable git diff is available, record `files_written_source = 'unavailable'` rather than reporting `git-diff` with a false zero count
- [x] T049 [US4] Derive `outcome_label` and emit the single close-out summary block in both `migration/guildctl/runner.ts` and `migration/guildctl/supervisor/loop.ts` for manual, worker-error, and review-error per-artifact paths — files written with source, artifact status transition, **verification state with method/reason**, claim disposition, process-cleanup outcome, provider budget with the explicit statement that spend is not recovered, and terminal reason. Limit terminations must carry the descriptor-derived `terminationReason`; an unavailable file count must carry `files_written_source = unavailable` and the `released-retryable` outcome rather than `no-progress`; a no-progress termination can never carry a success-equivalent label, and neither manual nor autonomous summaries present migration status without its verification state
- [x] T050 [US4] Validate the attempt-outcome value domains in `finishRun` in `migration/registry/commands/runs.ts` — `files_written_source`, `budget_consumed`, `cleanup_outcome`, `outcome_label`, `survivor_pids` non-empty iff `cleanup_outcome = 'survivors'` — and reject `succeeded` when `status_from` equals `status_to`
- [x] T051 [US4] Add the `show-no-progress-attempts [--min <n>] [--artifact <id>] [--json]` query over `runs ⋈ artifact_claims` grouped by artifact to `migration/registry/commands/runs.ts` and register it in `migration/registry/cli.ts`
- [x] T052 [US4] Add the `COUNT`-shaped repeat-waste line (`N artifact(s) with ≥2 no-progress attempts`) with the `registry show-no-progress-attempts --min 2` pointer to `migration/guildctl/commands/status.ts` (same file as T029; sequence after it)
- [x] T053 [P] [US4] Document the effective per-phase limits, their sources, and the precedence order in `README.md` and `GETTING-STARTED.md` (same files as T040/T041; sequence after them if US3 and US4 are worked concurrently)
- [x] T054 [US4] Add the attempt close-out expectations — the five facts an attempt must state together, and that a released claim is never reported as proof the attempt succeeded — to `package/agent-instructions.md` (same file as T031; do not run the two in parallel)

**Checkpoint**: User Stories 1–4 all work independently.

---

## Phase 7: User Story 5 - Nothing keeps spending after the kill (Priority: P5)

**Goal**: terminating an attempt terminates everything that attempt started — graceful first, forced
after a bounded grace period, then confirmed. Any survivor is reported as a cleanup failure, and claim
release is never presented as proof that spending stopped.

**Independent Test**: force a ceiling termination and inspect running processes afterward. Delivers
value if no process started by that attempt is still alive shortly after termination, and any survivor
is named in the run output.

**Requirements**: FR-035–FR-039. **Success criteria**: SC-009.

### Tests for User Story 5 ⚠️

- [x] T055 [P] [US5] Write `migration/test/process-tree-termination.test.ts` using the SIGTERM-ignoring grandchild fixture from `migration/test/truthful-run-state-fixtures.ts`: graceful group signal is attempted first; forced escalation follows only after the bounded grace period; confirmation reports zero survivors when the tree is gone; a process that ignores graceful termination is forcibly terminated; an unkillable survivor is reported as a cleanup failure naming its PID while the claim is still released; an attempt terminated between processes reports `clean (0 survivors)` as success; and both the runner and autonomous `auto-run` path are covered, with the Windows `taskkill` path guarded on POSIX CI
- [x] T056 [US5] Spawn agents as process-group leaders (`detached: true`) in `migration/guildctl/runner.ts` and `migration/guildctl/commands/auto.ts`, forwarding operator `SIGINT`/`SIGTERM` into each group so Ctrl-C no longer leaves either tree running, and explicitly not calling `child.unref()` so each parent still awaits the exit needed to finalize its run
- [x] T057 [US5] Add graceful → forced → confirm escalation for autonomous workers, rather than replacing a nonexistent autonomous `proc.kill()` path, using the T013 helpers and bounded by `agent_limits.termination_grace_seconds` in `migration/guildctl/commands/auto.ts` / `migration/guildctl/commands/auto-run.ts`; the supervisor loop consumes the cleanup result while the existing manual runner path is updated separately
- [x] T058 [US5] Persist `cleanup_outcome` and `survivor_pids` through `finish-run` in the runner and autonomous cleanup paths, in `migration/guildctl/runner.ts` and `migration/guildctl/supervisor/loop.ts`, reporting any survivor as a cleanup failure rather than omitting it or treating it as acceptable
- [x] T059 [US5] Print the claim disposition and the process-cleanup outcome together in both manual and autonomous close-out summaries, in `migration/guildctl/runner.ts` and `migration/guildctl/supervisor/loop.ts` — a released claim is never printed alone, and the claim is still released when cleanup fails, since claim recoverability outranks cleanup completeness

**Checkpoint**: User Stories 1–5 all work independently.

---

## Phase 8: User Story 6 - Agents always receive usable context (Priority: P6)

**Goal**: context retrieval always returns something usable when a record exists — the stored file
when it can be located here, otherwise the stored summary content — and always labels which of the two
it returned.

**Independent Test**: request context for an artifact whose recorded location does not resolve on the
current host but whose summary is present. Delivers value if usable summary content is returned and
labelled as such, with no path-repair work left to the caller.

**Requirements**: FR-040–FR-044. **Success criteria**: SC-011.

### Tests for User Story 6 ⚠️

- [x] T060 [P] [US6] Write `migration/test/context-retrieval.test.ts`: an existing file returns `form: "file"` with a path that resolves as written on this host; a record written with foreign separators resolves without caller-side conversion; an unlocatable file with a stored summary returns `form: "summary"`; the canonical `migration/artifacts/<slug>/context/<agent>.md` layout rebuilt via `idToSlug` is tried before falling back; a whitespace-only summary counts as absent and yields `form: "none"` with `reason` and `fallback`; `reason` is `no-context-record` when no row exists and `no-locatable-file-or-summary` when a row yields nothing usable; all three forms exit `0` and only a missing artifact exits `2`; no filesystem search is performed at any step

### Implementation for User Story 6

- [x] T061 [US6] Implement the deterministic five-step resolver and the `ContextResponse` `form` discriminator in `migration/registry/commands/context.ts` — normalize stored separators, resolve relative paths against the workspace root, try the canonical layout, fall back to the stored summary, otherwise `none` — leaving the `agent_context` table itself unchanged
- [x] T062 [US6] Register `get-context --id <artifact-id> --agent <agent-name> [--json]` and re-point the existing `get-context-path` at the same resolver in `migration/registry/cli.ts`, keeping `get-context-path`'s bare-path stdout shape but exiting `2` with a message naming `get-context` when only a summary is available, so it never again prints a path that does not exist
- [x] T063 [P] [US6] Update `package/agents/code-writer-agent.agent.md` to call `get-context` and consume the returned `content` directly, with no instruction to convert separators, search for the file, or repair a stored location
- [x] T064 [P] [US6] Apply the same `get-context` guidance change to `package/agents/test-writer-agent.agent.md`
- [x] T065 [P] [US6] Apply the same `get-context` guidance change to `package/agents/codegen-agent.agent.md`
- [x] T066 [P] [US6] Apply the same `get-context` guidance change to `package/agents/test-agent.agent.md`

**Checkpoint**: all six user stories are independently functional.

---

## Phase 9: Polish & Cross-Cutting Concerns

- [x] T067 [P] Record the run-lifecycle and claim-semantics changes, the new `migration/test/` suites, and the maintainer checklist answers in `DEVELOPMENT.md`
- [x] T068 [P] Add the remaining feature entries (verification state, preflight, limit precedence, process-tree termination, portable context) under `Unreleased` in `CHANGELOGS.MD`, grouped by a human-readable date heading
- [x] T069 [P] Extend the foundational parity assertion from T004 in `migration/test/stack-pack-engine.test.ts` to cover every future stack id and run it as the Phase 9 release gate; the pre-existing Python difference was reconciled before implementation by the baseline patch to `package/stacks/python/stack.yaml`
- [x] T070 Run the full quality gate from the repository root — `npm test` then `npm run build`, driven by the scripts in `package.json` and `migration/package.json` — and compare the result against the T002 baseline
- [x] T071 Walk all six acceptance checks in a fixture workspace **outside this repository** (using `package/mock/` for sample content, per the constitution's source-of-truth boundaries) following `specs/001-truthful-run-state/quickstart.md` § Acceptance checks
- [x] T072 Final constitution and scope guard against `specs/001-truthful-run-state/spec.md` § Out of Scope: confirm no migration status value or pipeline phase was added, no write authorization was broadened, `artifact_verifications` still has no foreign key to `acceptance_evidence` and cannot satisfy the arbiter gate, every secret is redacted in test output / reports / recorded evidence, and no work from #43, #48, #51, or closed #40 / #44 / #45 entered the branch

---

## Dependencies & Execution Order

### Phase Dependencies

```text
Phase 1 Setup (T001-T003)
        │
        ▼
Phase 2 Foundational (T004-T013)   ◄── BLOCKS every user story
        │
        ├──────────────┬──────────────────────────────┐
        ▼              ▼                              ▼
   Phase 3 US1   Shared foundation gate         Phase 7 US5 / Phase 8 US6
   T014-T031     T031a                            T055-T066
                       ├──────────────┬──────────────┐
                       ▼              ▼              ▼
                  Phase 4 US2    Phase 5 US3    Phase 6 US4
                  T032-T035      T036-T042      T043-T054
                       └──────────────┴──────────────┘
                                      │
                                      ▼
                          Phase 9 Polish (T067-T072)
```

- **Setup (Phase 1)**: no dependencies — start immediately.
- **Foundational (Phase 2)**: depends on Setup. **Blocks all user stories.** T031a has only T012 as
  a technical prerequisite; it is a delivery-order gate before US2/US3, not a technical dependency
  of US4–US6.
- **User Stories (Phases 3–8)**: US1 and US5–US6 depend only on Phase 2; US2 and US3 additionally
  depend on T031a; US4's T047 autonomous half additionally depends on T031a, T035, and T039, while
  its remaining limit/reporting work depends on Phase 2. They may then run in parallel where their
  shared-file table permits, or sequentially in priority order P1 → P6.
- **Polish (Phase 9)**: depends on all desired user stories being complete.

### Foundational task dependencies

- T004 (all foundational tests) → T005–T013; for the schema slice specifically, T004 → T005, T006 →
  T007 (schema.ts guard is required alongside the DDL; either half alone leaves fresh or existing
  databases wrong)
- T010 → T011
- T008, T009, T012, T013 are mutually independent

### User Story Dependencies

All six stories depend on Phase 2; US2 and US3 additionally depend on T031a, and US4's T047 autonomous half additionally depends on T035 and T039. None has a broader product-story dependency:

- **US1 (P1)** — needs T005/T007 (schema), T008 (types), T009 (budget config), T013 (group kill).
- **US2 (P2)** — needs T012 (`resolveAgentLaunch()`) and T031a (autonomous shared resolution). Independent of US1 and US3.
- **US3 (P3)** — needs T012 for the run-start line and T031a for autonomous dispatch. Independent of US1 and US2.
- **US4 (P4)** — needs T006/T007 (columns), T010/T011 (`finishRun` plumbing), and the resolved runtime/queue seams from T031a, T035, and T039 for T047's autonomous enforcement and single runtime/termination descriptor. Independent of US1–US3 for the remaining limit/reporting work.
- **US5 (P5)** — needs T013 (group kill) and T010/T011 (persisting `cleanup_outcome`). Independent of
  US4: US4 owns label derivation and the summary, US5 owns cleanup population.
- **US6 (P6)** — needs T008 (`ContextResponse`) only. Fully independent of every other story.

### Known shared-file sequencing (not story dependencies)

These files are touched by two phases. Order them; do not parallelize across them.

| File | Tasks | Order |
|------|-------|-------|
| `migration/guildctl/commands/status.ts` | T029 (US1), T052 (US4) | T029 → T052 |
| `package/agent-instructions.md` | T031 (US1), T054 (US4) | T031 → T054 |
| `README.md` / `GETTING-STARTED.md` | T040/T041 (US3), T053 (US4) | T040/T041 → T053 |
| `migration/guildctl/runner.ts` | T027 (US1), T047–T049 (US4), T056–T059 (US5) | one story at a time |
| `migration/guildctl/commands/auto.ts` | T031a (foundation), T047/T056/T057 (US4/US5) | T031a → T047/T056/T057 |
| `migration/guildctl/commands/auto-run.ts` | T035 (US2), T039 (US3), T047/T057 (US4/US5) | T035/T039 → T047/T057 |
| `migration/guildctl/commands/review.ts` | T030 (US1), T039 (US3), T045 (US4) | T030/T039 → T045 |
| `migration/guildctl/commands/migrate.ts` | T045 (US4) | T045 |
| `migration/guildctl/commands/remediate.ts` | T045 (US4) | T045 |
| `migration/guildctl/commands/inventory.ts` | T045 (US4) | T045 |
| `migration/guildctl/supervisor/loop.ts` | T027 (US1), T048/T049/T058/T059 (US4/US5) | one story at a time |
| `migration/guildctl/cli.ts` | T034 (US2), T038 (US3), T046 (US4) | one story at a time |
| `migration/registry/cli.ts` | T011 (Foundational), T020 (US1), T051 (US4), T062 (US6) | T011 first |
| `migration/test/stack-pack-engine.test.ts` | T017 (US1), T069 (Polish) | T017 → T069 |

`migration/guildctl/runner.ts` is the heaviest convergence point — US1, US4, and US5 all modify it.
When stories are staffed in parallel, serialize runner edits or land them behind clearly separated
functions.

### Within Each User Story

- Tests are written **first** and MUST FAIL before implementation begins (Constitution V).
- Registry/schema layer before guildctl layer.
- Resolvers before the reporting that reads them — this is what makes "reporting cannot drift from
  behaviour" checkable rather than aspirational.
- Story complete and independently verified before moving to the next priority.

---

## Parallel Opportunities

### Within Phase 1

- T003 runs in parallel with T001/T002 once the repo is cloned.

### Before User Stories 2–3

- T031a follows the MVP and must land before T032 or T036. It touches the autonomous resolver path and
  the existing runtime-resolution suite, so it is not parallelized with T035 or T039.

### Within Phase 2

- T008, T009, T012, T013 — four different files, no shared state:

```bash
Task: "Add registry verification/outcome/context types in migration/registry/types.ts"
Task: "Add verification.budget_seconds, preflight.budget_seconds, and agent_limits.termination_grace_seconds in migration/guildctl/config.ts"
Task: "Add resolveAgentLaunch() in migration/guildctl/harness.ts"
Task: "Add process-group termination primitives in migration/guildctl/util.ts"
```

### Within Phase 3 (User Story 1)

All five test tasks touch five different files and can be written together:

```bash
Task: "Write migration/test/verification-state.test.ts"
Task: "Write migration/test/verification-bounds.test.ts"
Task: "Extend migration/test/arbiter-gate.test.ts for the verified-without-evidence rejection"
Task: "Extend migration/test/stack-pack-engine.test.ts for the stack.yaml verify: block"
Task: "Extend migration/test/warden.test.ts for blocked:out-of-scope-path"
```

Then the two stack-pack task pairs:

```bash
Task: "Add verify: block to stacks/java-spring/stack.yaml + package/stacks/java-spring/stack.yaml"
Task: "Add verify: block to stacks/python/stack.yaml + package/stacks/python/stack.yaml"
```

### Within Phase 5 (User Story 3)

- T040, T041, T042 — three different documentation files in parallel.

### Within Phase 6 (User Story 4)

- T043 and T044 — two different test files in parallel.

### Within Phase 8 (User Story 6)

- T063, T064, T065, T066 — four different packaged agent definitions in parallel.

### Within Phase 9

- T067, T068, T069 — three different files in parallel; T070–T072 are sequential gates.

### Across stories

Once Phase 2 completes, all six stories can be staffed in parallel, subject to the shared-file
sequencing table above.

---

## Independent Test Criteria

| Story | Priority | Independent test | Passes when |
|-------|----------|------------------|-------------|
| **US1** | P1 | Run a wave against a workspace whose overall build cannot succeed, then query status | Artifacts still advance; every advanced artifact reports a verification state and reason; the verified / unverified / verification-failed split is visible without reading logs |
| **US2** | P2 | Configure a set-but-unusable credential, point the ambient environment at a different model than project configuration declares, run preflight | Preflight fails, names the credential/provider stage, and prints the resolved harness, provider, and model |
| **US3** | P3 | Set one variable to different values in the project `.env` and the ambient environment, run any phase | The project value is used; the divergence line names both values and the winner; the run-start line reports the resolved provider and model |
| **US4** | P4 | Run a phase with a deliberately short per-phase limit and let an agent hit it | The message names the phase knob (not the overridden project-configuration setting) with its effective value and source; the summary reports zero files written, no status advance, and spent budget |
| **US5** | P5 | Force a ceiling termination and inspect running processes afterward | No process started by that attempt is alive after the grace period; any survivor is named in that run's output |
| **US6** | P6 | Request context for an artifact whose recorded location does not resolve on this host but whose summary is present | Usable summary content is returned and labelled `form: "summary"`, with no path-repair work left to the caller |

---

## Implementation Strategy

### MVP scope

**MVP = Phase 1 + Phase 2 + Phase 3 (User Story 1), tasks T001–T031.** T031a is a required
post-MVP shared foundation gate before implementing US2 or US3; it is not part of the MVP acceptance
checkpoint.

User Story 1 is the MVP because it is the only slice that addresses a direct violation of the
constitution's non-negotiable first principle — status advancing on an agent's self-report. The other
five slices each make a *diagnosis* faster; this one stops the system from asserting something untrue
about the work product itself. It is independently shippable: verification becomes a recorded fact
separate from migration status, visible in status output, without any of the preflight, environment,
limit, termination, or context work.

1. Complete Phase 1: Setup.
2. Complete Phase 2: Foundational — **critical, blocks everything**.
3. Complete Phase 3: User Story 1.
4. **STOP and VALIDATE**: run quickstart.md acceptance check 1 against a fixture workspace whose
   tree-wide build cannot succeed.
5. Ship.

### Incremental delivery

| Increment | Tasks | Delivers |
|-----------|-------|----------|
| Foundation | T001–T013 | Schema, types, config, shared resolvers |
| **MVP** | + T014–T031 | US1 — truthful completion and bounded verification |
| Pre-US2/US3 foundation | + T031a | Autonomous shared resolution |
| 2 | + T032–T035 | US2 — preflight that validates the resolved path |
| 3 | + T036–T042 | US3 — environment precedence and divergence visibility |
| 4 | + T043–T054 | US4 — honest limits and attempt outcomes |
| 5 | + T055–T059 | US5 — complete process-tree termination |
| 6 | + T060–T066 | US6 — always-usable agent context |
| Release | + T067–T072 | Docs, changelog, full gate, scope guard |

Each increment adds value without breaking the previous one. Every new registry column is nullable or
defaulted and every new command is additive, so an older workspace row and a newer reader coexist —
which is what makes stopping after any increment safe.

### Parallel team strategy

1. Everyone completes Phase 1 + Phase 2 together (T001–T013).
2. Then, respecting the shared-file sequencing table:
   - **Developer A**: US1 (T014–T031) — the largest slice, and the MVP.
   - **Developer B**: T031a, then US2 (T032–T035), then US6 (T060–T066) — all self-contained after the shared foundation.
   - **Developer C**: US3 (T036–T042), then US4's limit/reporting slice (T043–T046).
   - **Developer D**: T047–T048, coordinating the T035/T039 runtime handoff with Developer B/C before autonomous enforcement; then US5 (T055–T059), coordinating `runner.ts` edits with A and C.
3. Land US1 first regardless of finish order, so the MVP is the first thing on the branch.

---

## Notes

- `[P]` = different files, no dependency on an incomplete task.
- `[USn]` maps a task to its user story for traceability; Setup, Foundational, and Polish carry no
  story label by design.
- Verify each test fails before implementing against it — a test that passes on first write is not
  pinning the behaviour it claims to pin.
- Commit after each task or logical group; stop at any checkpoint to validate a story independently.
- **Constitution invariants that no task may weaken**: verification state is triage input only and can
  never satisfy the arbiter gate (IV, research R11); the claim is released even when process cleanup
  fails (VI, FR-039); output stays silence-first — this feature adds exactly one new always-on line per
  phase run (VI); every stack-specific build or test command lives in a stack pack, never in core
  (VII).
- `migration/test/registry-schema-delta.test.ts`, `migration/test/run-outcome-plumbing.test.ts`,
  `migration/test/runtime-resolution.test.ts`, `migration/test/process-group-primitives.test.ts`,
  and `migration/test/truthful-run-state-fixtures.ts` are the five files added beyond the suite list
  in plan.md § Source Code. The four test files give every foundational slice tests-first coverage as
  Constitution V requires; the shared fixture removes duplication across thirteen new suites and is
  named to fall outside the `test/*.test.ts` glob.
