# Migration Guild repository changelog

This file tracks **development changes to the kit repository itself**.

It is intended for maintainers, not migration-workspace users. User-facing setup and behavior docs belong in `README.md` and `GETTING-STARTED.md`. Date headings inside `Unreleased` group development batches; they are not release dates.

## Unreleased

### August 20, 2026

- Shipped nine operational-hardening fixes for Spec 012 (#150, #151, #153–#159) across the
  `migration/` registry + guildctl runtime and the shipped docs/prompts. (1) Manual
  arbitration (#153, FR-001..FR-002): `guildctl arbitrate` gained `--run-id`/
  `--operator-token` options and mints an ad-hoc run + operator credential when neither is
  supplied, so manual approve/reject works without an in-progress `auto` session; any
  credential/state error surfaces as one clean stderr line with a non-zero exit (never a
  stack trace). (2) Stack-aware verify + no-defect loop stop (#154, FR-003..FR-005): the
  verify step resolves the active stack pack's `verify.per_artifact` check instead of a
  hardcoded `npm test`; unavailable stack tooling reports `unverified`/`no-stack-check`
  rather than `blocked`; a new `remediation-confirmed-no-defect` event stops the
  supervisor's verify re-loop and surfaces the artifact operator-visibly. (3) Blocked
  resume (#155, FR-006..FR-007): `claimArtifactById` accepts `blocked` in its
  resume-eligible `fromStatuses`, the supervisor restores a blocked artifact to `migrated`
  after a passing resume re-verification, and unsupported resume states produce a clean
  `RegistryError` message with non-zero exit. (4) Warden-revert guard (#156, FR-008): the
  `migrated` write in `setArtifactStatus` is gated by `wardenRestoredOwnOutput()` — when a
  `filesystem-violation` restore touched the claim's own `expected_output_paths`, the write
  is refused and the artifact routes to the blocked/failed path instead of being recorded
  as successfully migrated. (5) Bounded verify concurrency (#151, FR-009..FR-011): a new
  `verify_slots` lease table (atomic acquire/release, stale-lease reclamation) caps
  concurrent verify subprocesses at `verification.max_concurrent` (default
  `max(cpus-1, 1)`, overridable via `GUILDCTL_VERIFY_MAX_CONCURRENT`); sessions wait for
  capacity rather than spawning unbounded verifiers; the java-spring stack's
  `javac-scope-compile` now runs with `-J-Xmx256m`. (6) Stale-path sweep (#157,
  FR-012..FR-013): all 99 occurrences of the pre-restructure `migration/dist/registry/cli.js`
  path corrected to `migration/registry/dist/cli.js` across `guildctl/commands`,
  `package/agents/`, and `package/prompts/`, plus a `stale-dist-path-consistency`
  regression test that fails if the stale form reappears. (7) Reasoning-model preflight
  (#158, FR-014..FR-015): the probe `max_tokens` raised 16 → 256 and a new
  `isReasoningTokenExhaustion()` shape detector reports the empty-completion-with-
  reasoning-tokens case as "model needs a larger token budget" instead of a generic empty
  completion. (8) init→auto DB path docs (#159, FR-016): GETTING-STARTED and README now
  document the `assertAutonomousRegistryPlacement` constraint and the exact `--db`/
  `REGISTRY_DB` override an operator needs before running autonomous mode. (9) Headless
  setup wizard (#150, FR-017..FR-019): `setup.ts` short-circuits up front on non-TTY stdin
  (documented default answers, non-zero exit if it can't scaffold) and each `ask()` falls
  back to its documented default on piped-EOF, with a stderr note; GETTING-STARTED's
  non-interactive-behavior note now matches the real behavior. Root↔`package/` byte parity
  restored for `.env.example` and `stacks/**/stack.yaml` (the parity drift surfaced at the
  T040 gate). Full suite is 803/803 green (738 migration + 65 UI) vs the 706 baseline.

### August 19, 2026

- Shipped five onboarding/kit-packaging fixes for Spec 012 (#148). (1) Kit packaging: the
  `dist/migration-guild-kit.tar.gz` tarball now includes `migration/package.json`,
  `migration/package-lock.json`, and `migration/registry_schema.sql`, so the documented
  `cd migration && npm install` works from the tarball alone with no sibling checkout
  (FR-001..FR-003). (2) Build self-sufficiency: `npm run build:dist` now performs its own
  nested `migration/` and `migration/ui/` installs (instead of assuming a fully-installed
  clone), and `DEVELOPMENT.md` documents all three install locations up front
  (FR-004..FR-005). (3) Provider defaults: the seeded `DEFAULT_GUILD_CONFIG` profile changes
  from an undocumented personal `rootsys`/DashScope profile to a generic OpenAI-compatible
  default (`https://api.openai.com/v1` + `OPENAI_API_KEY`, DashScope-pointing
  dashscope/cheap/reviewer/qwen entries removed — DashScope stays usable via explicit user
  config), with `.env.example` and the shipped docs telling the same story
  (FR-006..FR-007). (4) Doctor/harness diagnostics: `guildctl doctor`'s harness check
  reports the adapter's actual stderr/stdout excerpt (trimmed, capped) when the adapter
  exists but fails — and distinguishes "failed to start" from "exited N" — instead of the
  generic "missing or unreachable" wording (FR-008..FR-009). (5) Docs + dead-file cleanup:
  `--legacy-path` documented in GETTING-STARTED's Setup block, one canonical
  `guildctl run <phase>` pipeline command form across README/GETTING-STARTED, the
  interactive-only setup-wizard note, no DashScope-as-default in any shipped doc or
  `package/` artifact, and the dead `guildctl.config.json` files (root + `package/`)
  deleted along with their `benchmark.ts` copy-list entry (FR-010..FR-016). Full suite is
  771/771 green (706 migration + 65 UI).

### August 16, 2026

- Expanded the `package/mock/` fixture set for Spec 008 (#112): three additive,
  java-spring-only legacy fixtures plus docs and one regression test, no core-runtime change
  (FR-009). `legacy-order-view/` is a Struts 1.x `Action` + `order-view.jsp` that trips both
  the `struts-action` and `jsp-view` classification signals and carries inline validation +
  business logic across two request paths — exercising the `view-regeneration-*` (critical)
  and `view-logic-placement-*` (warning) audit rules end-to-end, solvable to zero view findings
  when logic is extracted into `*Validator`/`*Service`. `legacy-customer-reports/` declares a
  REAL Maven `<dependency>` on `legacy-customer-utils` and imports `LegacyCustomerKeyService`,
  giving the planner a genuine cross-module edge so `guildctl plan` emits 2+ waves with the
  dependency ordered first (SC-003). `legacy-modernization-bait/` is a deliberately shallow-migration
  "bait" fixture (`SimpleDateFormat`, raw `Map`/`List`, manual null checks — each mapped to a
  modern equivalent already in `mappings.md`); it pins the structural gap a rename-only migration
  would leave, with the detection-rule work explicitly noted as out of scope. All three ship with
  JUnit 4 legacy-side tests mirroring `LegacyCustomerKeyServiceTest`; `package/mock/README.md`
  documents all four fixtures per FR-006. New `migration/test/mock-fixture-waves.test.ts` (1/1)
  pins the SC-003 multi-wave ordering against the real scanner + `buildParallelPools`; full suite
  is 710/710 green (645 migration + 65 UI).

### August 15, 2026

- Added the view-logic-placement rule, amending #59's view-regeneration rule (#100): a
  view-handling module landing correctly as a contract-backed endpoint is no longer enough —
  its extracted validation/business logic must now consolidate into dedicated, named
  `*Validator`/`*Service` modules, never inline in the handler, never duplicated per-endpoint.
  `java-spring`'s `stack.yaml` gains a `logic_extraction:` block (service/validator suffixes,
  handler roles) and `mappings.md` gains a "Placement of extracted logic" subsection (both
  mirrored into `package/stacks/java-spring/`, parity-checked); `audit.rules.yaml` gains the
  `view-logic-placement-inline-validation` / `-inline-business-rule` rules (warning severity —
  judgment-bounded, the reviewer resolves borderline cases); the `jvm_audit_findings` CHECK
  constraint plus `JvmAuditCategory` union accept the new category.
  `post-migration-audit.prompt.md` and `audit-agent.agent.md` gain a matching holistic
  placement + per-endpoint-duplication scan, reporting through the existing findings/registry
  path; the `migration-review` skill and `review-agent.agent.md` gain a matching checklist
  item/review priority (Critical on failure, reinforcing the warning-severity audit rule with
  the critic's final call). New `audit-view-logic-placement.test.ts` (2/2) plus an extended
  `stack-pack-engine.test.ts` (16/16, rule count 12→14) cover it; full suite is 493/493 green.

### August 14, 2026

- Updated agent guidance so a missing JDK/Gradle toolchain no longer triggers filesystem-search
  thrash (#64): `code-writer-agent`, `test-writer-agent`, and `review-agent` now probe once for
  `javac`/`mvn`/`gradle` and, when absent, record
  `set-verification --state unverified --method none --reason agent-reported-unverifiable`
  instead of hunting for a compiler (`find /` and similar scans are explicitly forbidden).
  `package/agent-instructions.md` states the same rule kit-wide: an absent toolchain is an
  expected environment state and verification stays optional and bounded, never a gate.
- Added the view-regeneration rule for legacy view-handling modules (#59): JSP/JSPX/XHTML and
  JSF/Facelets sources now map to `view-regeneration` findings instead of being silently carried
  through as regeneratable UI. `java-spring`'s `stack.yaml`/`classification.yaml` widen
  `source_globs` and add `jsp-view`/`jsf-view` signals, `audit.rules.yaml` gains the
  `view-regeneration-*` rule set (mirrored into `package/stacks/java-spring/`, parity-checked),
  and the `jvm_audit_findings` CHECK constraint plus `JvmAuditCategory` union accept the new
  category. `post-migration-audit.prompt.md` and `audit-agent.agent.md` scan for the five
  view-framework signals and record findings via the `replace-view-with-api-contract` /
  `view-dropped-presentational` outcomes; the `migration-review` skill and `review-agent.agent.md`
  add a matching review checklist/priority so migrated output is checked for stray regenerated
  view components. New `audit-view-regeneration.test.ts` (5/5) plus an extended
  `stack-pack-engine.test.ts` (9/9, including the stacks/package-stacks parity check) cover it;
  full suite is 491/491 green.

### August 12, 2026

- Added artifact verification as a fact separate from migration status: a new `artifact_verifications`
  table records whether an artifact's own output was checked, by what method, and why (or why not),
  through a bounded per-artifact check (stack-pack `verify:` block) scoped to the claim's own outputs
  plus one hop of declared dependencies — never the transitive closure, never gating the status
  transition, and never able to satisfy the arbitration gate. `guildctl status` and `registry
  list-verification` surface the verified/unverified/verification-failed split.
- Added `guildctl preflight`, which resolves the runtime path a phase run would actually take
  (`resolveAgentLaunch()`, shared with the runner) and proves it with one live minimal completion
  request before any artifact is claimed; `doctor` and `auto-run` now delegate to it instead of
  separate harness/credential-only checks.
- Added `guildctl limits`, reporting each phase's effective wall-clock ceiling and inactivity timeout
  through a single four-tier precedence resolver (`resolveEffectiveLimit()`): per-phase setting →
  environment override → project configuration → built-in default. Termination messages now name the
  knob that actually governed instead of always suggesting `agent_limits.ceiling_seconds`.
- Added attempt-outcome recording: `runs` gained `files_written_count`/`files_written_source`,
  `status_from`/`status_to`, `budget_consumed`, `cleanup_outcome`/`survivor_pids`, and a computed
  `outcome_label` (never agent-supplied). `registry show-no-progress-attempts` and a `guildctl status`
  repeat-waste line surface artifacts with repeated no-progress attempts.
- Changed process termination so an attempt's whole process tree is terminated, not only its direct
  child: agents now spawn as process-group leaders and a kill escalates graceful → forced → confirmed
  (`terminateProcessGroup()`), covering both the manual runner and the autonomous worker/reviewer
  spawns. Any survivor is reported as a cleanup failure naming its PID; the claim is still released.
- Added `registry get-context`, returning usable context whenever a record exists — the stored file
  when it resolves on this host (normalizing stored path separators and rebuilding the canonical
  `migration/artifacts/<slug>/context/<agent>.md` layout when the stored path does not), otherwise the
  stored summary, always labelled by a `form` field. `get-context-path` is re-pointed at the same
  resolver; the four context-consuming packaged agents were updated to use it.

### August 2, 2026

- Changed environment loading so the workspace `.env` wins over inherited values by default, with
  explicit `--ambient-env` / `GUILD_ENV_PRECEDENCE=ambient` opt-in, always-on divergence reporting,
  and redaction of sensitive values.

### July 20, 2026

- Added `goose` harness adapter (`package/harness/goose.mjs`) — wraps the [goose](https://github.com/aaif-goose/goose) CLI (Rust binary, ~113MB RSS vs opencode's ~478MB) for memory-constrained environments. Supports `--yolo` (GOOSE_MODE=auto) and `--read-only` (GOOSE_MODE=chat), stream-json parsing with text buffering, token usage capture, and claim handoff. Registered in `harness.ts` resolver.
- Added `package/harness/HARNESS.md` — full harness adapter guide covering the adapter contract, env vars, token usage file format, per-harness setup (goose/opencode/codex/custom), selection criteria, and Windows PowerShell instructions.
- Changed `DEVELOPMENT.md` agent binary selection section to document all harnesses with a comparison table and link to HARNESS.md.

### July 15, 2026

- Changed inventory ID derivation to preserve existing non-colliding IDs while assigning deterministic path-qualified IDs to same-module basename collisions, including safe repair of partially populated registries.
- Changed Java and Python source dependency resolution to prefer exact qualified matches and reject ambiguous simple-name matches instead of selecting by registry insertion order.
- Added regression and real-codebase acceptance coverage for collision-free registration, idempotent rescans, partial-registry upgrades, and FQCN dependency resolution.

### July 6, 2026

- Added the stack-pack inventory classification contract (`classification.yaml`), Java/Python stack specs, alias normalization, ambiguous/fallback semantics, structured confidence/evidence storage, and atomic `registry batch-classify` / `mark-inventory-complete` commands.
- Changed inventory and planning to enforce an inventory-quality gate covering missing fields, invalid framework/role values, fallback-heavy distributions, module/path mismatches, unexpected registrations, generic-only tags, and missing completion evidence.
- Added regression coverage for Java servlet/filter/Struts/JAX-RS/Spring MVC/JPA/EJB/Guice/test/plain-Java detection, batch atomicity, timeout/false-success handling, and valid Java/Python stack-pack progression.
- Changed Java inventory module semantics from package-derived values to stack-pack source-root/build ownership, with test source-set suffixes and upgrade guidance for clearing old package-derived inventories.
- Changed fallback validation so high plain-code concentration is advisory unless the stack opts into hard failure; `plain-java` now requires high-confidence negative evidence and validation rejects missed configured framework signals.
- Added inventory pollution cleanup: agent-created unauthorized first- and second-class artifacts are rolled back on failed inventory while preserving legitimate pre-existing second-class records.
- Fixed TypeScript declaration generation for the registry `serve` command action and added a `build` script that runs `tsc -p tsconfig.json`.

### April 22, 2026

- Added a repo-local maintainer prompt shortcut under `.github/prompts/` for building the distributable kit from a fresh clone and installing it into an external test workspace from user-supplied workspace and legacy-source inputs.
- Changed migration runner log line timestamps to local clock time (`HH:MM:SS.mmm`) instead of UTC slices, and switched log filename layout to `timestamp-runId-agent[-phase].log` for easier chronological scanning.
- Synced shipped runtime sources by adding the packaged inspector UI project mirror under `package/tools/ui` (operational views, shared API/hooks/types/utilities, tests, and Vite/Vitest/TypeScript project config).
- Added `scripts/update-testkit.sh`, a maintainer workflow helper to rebuild migration CLI output, sync `migration/` into `package/tools/`, update an external test workspace, and optionally reset workspace registry state (`clean`, `pre-plan`, `pre-migrate`, `pre-review`).

### April 21, 2026

- Added/remapped phase entry points so migration/runtime CLIs recognize `bootstrap` and `remediate` in `run <phase>`, and aligned phase messaging/ordering across status and review output.
- Added a dedicated packaged remediation command implementation with targeted/global prompt construction, timeout/model overrides, polling integration, and status-delta summary output.
- Changed bootstrap scaffolding to prefer packaged skill assets, emit deterministic Spring app/resource files for non-library modules, return structured bootstrap results, and treat already-scaffolded targets as an explicit skip result.
- Changed runner execution logging to use stable timestamped log naming plus richer run headers/footers (owner, phase, command, claim summaries, and written-file snapshots).
- Changed timeout handling to terminate timed-out agent processes (SIGTERM then SIGKILL) instead of leaving them alive for manual stuck-process triage.
- Replaced vendor-specific runtime plumbing with strict OpenAI-compatible configuration and client behavior.
- Changed registry query/API surface by removing run-log-file endpoint plumbing and simplifying several SQL/query helpers while preserving paged monitoring query contracts.
- Changed the migration inspector UI back to a lighter Artifacts/Wave Plan experience, removing the extended multi-tab monitoring surfaces and shared async state wrappers.
- Changed tool dependency policy in both migration and packaged runtime manifests to fully pinned versions plus explicit `overrides`, with corresponding lockfile refreshes.
- Updated shipped code/test-writer agent instructions to require a short progress update in chat and to prioritize analyze-context intake before implementation.
- Added regression coverage for CLI phase aliases, pipeline failure short-circuiting, remediation command behavior, registry API query contracts, status-next-step gating, and status-reason event metadata; removed obsolete preflight/bootstrap-focused tests.

### April 20, 2026

- Added a pre-plan JVM compatibility audit refresh that persists per-artifact findings in the registry, blocks planning on critical findings, and records operator-facing readiness guidance.
- Added a dependency modernization hard gate with per-artifact dependency findings, explicit approved upgrade/replacement strategies, registry event traceability, and migration/planning enforcement.
- Added registry CLI commands for querying JVM/dependency findings and approving dependency strategies, plus mirrored regression coverage in both `migration/test` and `package/tools/test`.
- Changed Agent runner timeout behavior to perform log-health analysis and mark runs as `STUCK_PENDING_REVIEW` (without forced process kill) when output appears stalled or error-patterned, including explicit operator recovery guidance.
- Enhanced the runs UI log viewer with per-line rendering, filterable log text, wrap toggling, and source log-file visibility for faster triage.

### April 17, 2026

- Added a remediation execution phase to the migration runtime with a dedicated `remediate` command, `run remediate` support, prompt construction for targeted/global remediation loops, timeout/model overrides, and remediation summary reporting.
- Added migration completion scope output (`Migration Summary`) after Phase 4 to show first-class progress and remaining planned/analyzed/tests-written/in-progress counts.
- Added paginated registry API query support for sessions, blockers, issues, and runs (including filter metadata), and wired corresponding pagination/filter query handling in the migration and packaged registry HTTP servers.
- Expanded the registry inspector UI into operational monitoring slices (`Sessions`, `Blockers`, `Runs`, `Quality`, `Cost`) with server-backed filters/sorting/pagination, run-log inspection, UTC/local timestamp toggles, and reusable loading/empty/error state components.
- Refactored UI data access into per-slice hooks plus shared async loader utilities, updated API clients and DTOs for paged endpoint shapes, and added formatting helpers for timestamps/durations/currency.
- Added/updated UI and runtime tests covering remediation command behavior, paged API normalization, operational view interactions, wave-plan rendering, and hook concurrency/reload behavior.
- Updated the UI TypeScript project setup to use build mode (`tsc -b`) with `tsconfig.app.json` project references.

### April 13, 2026

- Added lease-backed artifact claims with opaque claim IDs/tokens, heartbeat renewal, stale-claim reconciliation, and explicit claim lifecycle events (`claim-heartbeat`, `claim-completed`, `claim-released`, `claim-expired`).
- Added run ownership metadata (`owner_id`, `phase`) plus termination reasons, pid backfill support, and run-reap event emission so run/claim cleanup is traceable.
- Changed migration workers to receive stable run/session environment (`GUILDCTL_RUN_ID`, `GUILDCTL_AGENT_KIND`), process one claim per run, and pass claim tokens when advancing status.
- Added phase-specific migration worker timeout knobs (`GUILDCTL_ANALYZE_TIMEOUT_MINS`, `GUILDCTL_TEST_TIMEOUT_MINS`, `GUILDCTL_CODE_TIMEOUT_MINS`) and stale-claim reconciliation checkpoints between pools.
- Changed first-class readiness/claimability logic to ignore non-terminal second-class dependencies when evaluating first-class migration queue progress.
- Added lease and claim-token regression tests in both development runtime (`migration/test`) and packaged runtime mirror (`package/tools/test`).

### April 10, 2026

- Added a repo-local `documentation-agent` under `.github/agents/`.
- Added `DEVELOPMENT.md` as the maintainer guide for packaging, mirroring, and repo-local workflows.
- Added automatic target-module bootstrap before migration when `modern/` is not yet scaffolded, using `target-module-bootstrap` skill assets and artifact-derived project/package detection.
- Added tier-aware registry claiming and ready-list filtering so split migration agents can stay on first-class artifacts while resolving second-class dependencies inline.
- Tightened shipped migration remediation guidance so `migration-orchestrator` and `remediation-agent` treat rework as registry-only triage, explicitly forbid source edits during remediation, and instruct operators to restore `legacy/` before continuing if it was modified accidentally.
- Changed `build:dist` to use a cross-platform Node builder instead of a Bash-only script so packaging works from Windows shells.
- Scoped the bootstrap documentation workflow to maintainer docs instead of broad user-facing docs.
- Switched the documentation-agent workflow from a local pre-commit hook to a manual maintainer step, with post-CI automation as the intended long-term home.
- Documented the split between repo-local `.github/` artifacts and shipped `package/` artifacts.
- Changed the repository layout to stop dogfooding a repo-root migration workspace: shipped Agent runtime artifacts now live only under `package/`, root `.github/` is maintainer-only, and kit testing should happen in a separate external workspace.
- Changed migration runs to surface per-phase runtime details, queue summaries, stale-session warnings, and clearer follow-up commands when work remains or runs fail.
- Changed run handling to auto-release lingering claims and treat false-success exits that leave claimed artifacts behind as failed runs.
- Removed semantic-search behavior; agents now use explicit file/context references.
