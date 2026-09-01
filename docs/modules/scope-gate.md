# Scope Gate

## Purpose and Overview

In large legacy migrations, it is rare that every single module in the codebase is intended for modernization. Often, deprecation paths, internal tooling, or experimental branches are carried along in the legacy codebase but are explicitly excluded from the modernized target.

The **Scope Gate** subsystem is an interactive and programmatic bottleneck in the migration pipeline. It requires a human operator (or an automated test harness) to explicitly declare a `keep` or `drop` decision for every identified module *before* the planner is allowed to process the artifacts within that module.

By enforcing this at the module level rather than the individual artifact level, it drastically reduces operator fatigue while providing strong guarantees that the autonomous agents won't waste API budget planning or migrating code that is slated for deletion.

## Architecture

The Scope Gate operates across two main boundaries:

1. **The Registry Domain (`migration/registry/commands/scope.ts`)**: Handles the business logic of fetching module summaries, persisting decisions into the `scope_decisions` table, and cascaded status updates to individual artifacts.
2. **The CLI / Operator Domain (`migration/guildctl/commands/scope.ts` and `migration/guildctl/dashboard.ts`)**: Handles the interactive prompt loop, gating, and visualizations.

The gating enforcement itself is wired into the `plan` command via the Planning Readiness system (see `docs/modules/planning-readiness-gates.md`), which blocks if any first-class artifact belongs to a module without a recorded decision.

## Step-by-Step Flow and Mechanics

### 1. Grouping and Edge Detection
Before any decisions are made, the system must summarize the state of the workspace. `getModuleScopeSummary` in `migration/registry/commands/scope.ts` is responsible for this.

- **Aggregation**: It queries the `artifacts` table, grouping rows by `module` (which is assigned during the `inventory` phase by the Classification Engine). It counts total artifacts and differentiates between `first-class` and `second-class` tiers.
- **Decision Join**: It maps existing rows from the `scope_decisions` table to these summaries.
- **Cross-Module Dependency Tracking**: Crucially, it queries the `source_dependencies` table to find edges where an artifact in Module A depends on an artifact in Module B. This is returned as `depended_on_by` edges. This prevents the operator from blindly dropping a module that another, kept module relies upon.

### 2. The Interactive Gate
The CLI entry point is `runScope` (`migration/guildctl/commands/scope.ts`).

- It first prints a visual map using `printScopeMap` (from `migration/guildctl/dashboard.ts`), which displays each module, its keep/drop status, and any incoming dependency edges.
- It filters the summaries to find `undecided` modules (those with no decision and at least one first-class artifact).
- If `process.env["GUILDCTL_AUTO_KEEP_SCOPE"]` is set to `"1"` (used during automated benchmark runs), it bypasses the prompt and auto-keeps everything.
- Otherwise, it drops the operator into an interactive `readline` loop, requiring a `[k]eep`, `[d]rop`, or `[s]kip` decision for each undecided module.

### 3. Persisting the Decision
When the operator provides a decision (and a required rationale for drops), `recordScopeDecision` (`migration/registry/commands/scope.ts`) executes a transaction:

1. **Upsert**: It inserts or updates the `scope_decisions` table with the decision (`keep` or `drop`), the reason, and the agent (`operator`).
2. **Bulk Artifact Transition**: If the decision is `drop`, the system iterates over all artifacts assigned to that module.
   - **The `PRE_MIGRATION_STATUSES` Constraint**: It only transitions an artifact to `skipped` if its current status is one of `pending`, `planned`, or `analyzed`.
   - If an artifact has already progressed past analysis (e.g., it is `in-progress` or `migrated`), the system *leaves it alone* (`inFlightArtifactIds`). This fail-safe ensures that if a module is retroactively dropped mid-migration, the system doesn't rip active work out from under an agent's feet or invalidate completed evidence.
3. **Warnings**: It returns the list of cross-module dependencies, allowing the CLI to warn the operator that they just dropped a module that other modules still import.

## Invariants and Edge Cases

- **Skip vs Drop**: In the interactive prompt, selecting `skip` (or pressing enter) does *not* record a decision in the database. It merely defers the decision. Because no decision is recorded, the Planning Readiness gate will continue to block the `plan` phase.
- **Second-Class Modules**: A module consisting entirely of `second-class` artifacts (e.g., test fixtures or build scripts not explicitly targeted) does not trigger the interactive prompt or block the planner, as `runScope` filters for `first-class_count > 0`.
- **Reasoning Requirements**: Dropping a module strictly requires the operator to type a rationale. Keeping a module allows the rationale to be blank (defaulting to "Kept in scope").

## Gotchas

- **Retroactive Drops**: If a module is dropped *after* its artifacts have begun migration, `recordScopeDecision` warns the user but leaves the in-flight artifacts in their current state. The operator must manually abort or clean up those specific artifacts if they truly want them stopped.

## Extension Points

- The `PRE_MIGRATION_STATUSES` array in `migration/registry/commands/scope.ts` dictates the cut-off point for bulk-skipping. If new pre-execution states are added to the artifact lifecycle (e.g., an `approved-for-planning` state), this array must be updated.
- The `ModuleScopeSummary` interface could easily be expanded to include aggregated risk scores or LOC counts to give the operator more context before they make a keep/drop decision.