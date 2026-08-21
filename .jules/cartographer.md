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
