## 2024-03-24 - Autonomous Loop Resume Semantics
**Learning:** `opts.resume` logic natively clears the `blocked` status of an artifact to `migrated` if the verifier passes. This allows the independent review and arbitration process to run correctly on artifacts that were previously stuck.
**Action:** Always check the exact state transitions for `blocked` statuses when investigating pipeline halts; some phases actively rewrite states rather than just halting them.

## 2024-03-24 - Read-Only Warden Enforcement
**Learning:** The Warden is reused not just for bounding file modifications by code-writers, but strictly preventing *any* modifications by independent reviewers by passing an empty `allowedPaths` array during review enforcement.
**Action:** When implementing read-only agent actions, reuse the Warden with an empty allow-list rather than building custom file-locking.

## 2024-03-24 - Registry schema SQLite ALTER TABLE limitations
**Learning:** The specific SQLite build in use for the registry rejects `ADD COLUMN IF NOT EXISTS`. To support in-place upgrades of existing workspaces, schema migrations are done by manually checking if a column exists and then performing a plain `ALTER TABLE` in `migration/registry/db/schema.ts`, while the base schema (`migration/registry_schema.sql`) still holds the full current table definitions.
**Action:** When adding columns to the registry, always split the definition: add to the base CREATE TABLE, and write a guarded ALTER TABLE in `schema.ts`.

## 2024-03-24 - Supervisor Deep Dive
**Learning:** The supervisor loop relies heavily on the `AutonomousLimitError` to pass process cleanup state and limit termination info across the boundary instead of just doing a raw exit.
**Action:** When handling errors or writing tools that have long running processes, ensuring a structured error containing process info is critical.

## 2024-08-21 - CLI Command Wiring and SQLite Transactions
**Learning:** The operator CLI surface (`migration/registry/cli.ts`) is designed as a thin routing layer that wraps subcommand execution in a central `run(fn)` helper. The actual business logic and database mutations are isolated in `migration/registry/commands/*.ts`. This ensures commands can be reused directly by the local API server while enforcing consistent error handling (`RegistryError` -> exit codes) and JSON serialization.
**Action:** When documenting or modifying commands, remember the separation of concerns: parameter parsing and formatting in `cli.ts`, state validation and SQLite transactions in `commands/*.ts`.

## 2024-08-21 - Dependency Disposition Nulling Semantics
**Learning:** When confirming a dependency disposition (`confirmDisposition`), the registry implements strict "nulling semantics". If the disposition strategy changes (e.g., from `replace-with-native` to `keep`), fields relevant only to the old strategy (like `native_replacement`) are cleared to `null` unless explicitly overridden. This prevents the confirmed row from containing stale, mixed data from a previous proposal.
**Action:** Always check the exact state transitions and field handling when updating complex rows; do not assume a simple merge of new and old values.

## 2024-03-24 - Diagnostics and Failure Modes
**Learning:** The guildctl operator health suite differentiates between config-resolved harnesses and custom AGENT_CMD harnesses when testing reachability. `preflight.ts` will explicitly probe the adapter of a config-sourced harness but leave custom harnesses to be validated only by the live provider request. `doctor.ts` explicitly checks custom environment harnesses to ensure the operator's custom program is reachable before green-lighting the configuration.
**Action:** When documenting reachability constraints, distinguish how preflight handles config-sourced configurations vs environment/custom harnesses.

## 2024-08-21 - Effective Limit Phase Remapping
**Learning:** Manual phase commands (like `remediate`) and autonomous loop phases (like `repair`) often use different terminologies for the same logical stage, but the limit configuration must map to the base spec (e.g., `remediation`). `limitPhaseForAutoWorker` handles this so `resolveEffectiveLimit` pulls the right config knob.
**Action:** When tracking configurations, ensure the phase name used matches the limit mapping, not just the run label or status.

## 2024-08-22 - UI Presentation Ordering via SQLite
**Learning:** The CLI dashboard uses a hardcoded `ORDER BY CASE status WHEN 'pending' THEN 1 ... END` directly in SQLite queries (e.g. `printStatusSummary` in `migration/guildctl/dashboard.ts`) to enforce business-logic pipeline ordering of aggregated rows, avoiding the need for an in-memory JS sort step.
**Action:** When adding new aggregations or UI views that have a logical pipeline order, implement the sorting directly in the SQL projection rather than fetching and mapping arrays in the backend.
## 2024-08-25 - Property Masking in Sequence Evaluation
**Learning:** The CLI runner for the planner (`migration/guildctl/commands/plan.ts`) uses property masking on the `PlanningReadiness` struct (by passing artificially empty arrays via the spread operator) to evaluate gating checks sequentially across its lifecycle, rather than evaluating all checks simultaneously at the start.
**Action:** When evaluating sequential gates or constraints across multiple domains, consider property masking to bypass specific checks while reusing the same underlying formatter logic.

## 2024-08-25 - Environment Snapshot-Then-Apply
**Learning:** Environment precedence (`migration/guildctl/env.ts`) deliberately avoids `dotenv`'s `override: true` to prevent silently overwriting ambient variables. It instead uses a custom snapshot-then-apply algorithm that computes the difference *before* applying. Crucially, it implements a "fail-closed" mechanism where an empty credential in `.env` will not overwrite a working ambient credential.
**Action:** When working with environment configuration logic, do not assume simple overrides. Always trace how divergences are calculated and respect fail-closed protections for working credentials.
