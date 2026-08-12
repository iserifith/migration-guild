# Migration Guild repository changelog

This file tracks **development changes to the kit repository itself**.

It is intended for maintainers, not migration-workspace users. User-facing setup and behavior docs belong in `README.md` and `GETTING-STARTED.md`. Date headings inside `Unreleased` group development batches; they are not release dates.

## Unreleased

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
