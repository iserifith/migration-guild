# legmod repository changelog

This file tracks **development changes to the kit repository itself**.

It is intended for maintainers, not migration-workspace users. User-facing setup and behavior docs belong in `README.md`, `GETTING-STARTED.md`, and `docs/`. Date headings inside `Unreleased` group development batches; they are not release dates.

## Unreleased

### April 13, 2026

- Added lease-backed artifact claims with opaque claim IDs/tokens, heartbeat renewal, stale-claim reconciliation, and explicit claim lifecycle events (`claim-heartbeat`, `claim-completed`, `claim-released`, `claim-expired`).
- Added run ownership metadata (`owner_id`, `phase`) plus termination reasons, pid backfill support, and run-reap event emission so run/claim cleanup is traceable.
- Changed migration workers to receive stable run/session environment (`LEGMOD_RUN_ID`, `LEGMOD_AGENT_KIND`), process one claim per run, and pass claim tokens when advancing status.
- Added phase-specific migration worker timeout knobs (`LEGMOD_ANALYZE_TIMEOUT_MINS`, `LEGMOD_TEST_TIMEOUT_MINS`, `LEGMOD_CODE_TIMEOUT_MINS`) and stale-claim reconciliation checkpoints between pools.
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
- Changed the repository layout to stop dogfooding a repo-root migration workspace: shipped Copilot runtime artifacts now live only under `package/`, root `.github/` is maintainer-only, and kit testing should happen in a separate external workspace.
- Changed migration runs to surface per-phase runtime details, queue summaries, stale-session warnings, and clearer follow-up commands when work remains or runs fail.
- Changed run handling to auto-release lingering claims and treat false-success exits that leave claimed artifacts behind as failed runs.
- Changed Foundry embedding and semantic-search behavior to index target-side files, persist resolved target paths, and return an empty result set when no embedding corpus has been built yet.
