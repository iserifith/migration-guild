# The Registry State Model

## Purpose and Overview

The **Registry State Model** is the source of truth for the Migration Guild's artifact tracking system. It governs how legacy files and logic are represented as "artifacts", tracks their progression through a rigid state machine (`Status`), and records every mutation (via `events`, `runs`, and `artifact_claims`). The registry sits at the center of the pipeline—commands like `guildctl status`, `guildctl watch`, and the autonomous loop all read from and write to this database to understand the state of the migration.

Unlike typical stateless automation tools, the registry is a durable SQLite database (defined in `migration/registry_schema.sql` and `migration/registry/db/schema.ts`) that guarantees invariants about concurrency (via the claim protocol) and tracks deep analytics (such as token usage, verification history, and file mutations).

## Architecture

The registry's state model revolves around several core entities (defined in `migration/registry/types.ts`):

1. **`Artifact` (`artifacts` table):** The central unit of work (e.g., a legacy source file, a module).
2. **`Status`:** The current state of the artifact in the migration pipeline.
3. **`Event` (`events` table):** An append-only audit trail of every significant change to an artifact (status transitions, claims, verifications).
4. **`Run` (`runs` table):** Represents a single execution attempt by an agent or operator, tracking metadata like resource usage, exit code, and attempt outcomes.
5. **`ArtifactClaim` (`artifact_claims` table):** Tracks active and historical distributed leases on artifacts (see `claim-protocol.md`).
6. **`ApprovalDecision` (`approval_decisions` table):** An append-only audit row per human approve/reject decision made on a `pending-approval` artifact — operator identity, run binding, reason, and an evidence-freshness snapshot (spec 013; see `review-arbitration.md`).
7. **`AttemptRecord` (`attempt_records` table):** An append-only row per concluded migrate attempt (`artifact_id`, `attempt_no`, `outcome`, `failure_kind`/`failure_signature`, timings). Unlike `runs` (one row per process execution), this is the durable, restart-proof source of truth for "what happened on attempt N" and for reconstructing the retry budget (spec 013; see `supervisor.md`).

## Step-by-Step Flow: Status Transitions

The lifecycle of an artifact is tracked by its `status` field, mutated exclusively via `setArtifactStatus` (`migration/registry/commands/artifacts.ts`).

### 1. Registration (`pending` / `planned`)
Artifacts are initially inserted with a `pending` status. During planning, they are transitioned to `planned` (or `analyzed`).

### 2. Claiming (`in-progress`)
When an agent or the autonomous loop is ready to work, it acquires a claim (see `claimNextTask` in `claim.ts`). This transitions the artifact to `in-progress` and records the agent in `claimed_by`.

### 3. Execution & Mutating Status (`setArtifactStatus`)
The `setArtifactStatus` function strictly governs how an artifact exits `in-progress`:
- **Authorization:** If the artifact is `in-progress`, the caller *must* provide either a valid claim token (`opts.claimToken`) or a valid run operator credential (`opts.operatorToken`). This enforces Constitution III (only the active worker or operator can transition a claimed artifact).
- **Claim Completion:** Supplying a valid claim token transitions the artifact and marks the active claim as completed (`completeClaimForArtifact`).
- **Claim Release:** Supplying an operator credential manually releases the claim (`releaseClaimByArtifactId`).
- **Status Rollback:** If a worker drops the lease without completing it (or if it times out), the claim protocol rolls the status back to `claimed_from` (the status prior to `in-progress`).

### 4. Warden Validation Gate
There is an active gate inside `setArtifactStatus` directly related to filesystem enforcement (US4 / #156). If an agent attempts to transition an artifact to `migrated`:
- `setArtifactStatus` checks `wardenRestoredOwnOutput(db, id, opts.claimId)`.
- If the Warden reverted the artifact's own claimed output because of an out-of-scope write (see `warden.md`), the registry *refuses* to record the artifact as `migrated`. It throws a `RegistryError`, forcing the supervisor to treat it as a failure, because the workspace no longer holds the promised output.

### 5. Event Audit Logging
Every successful call to `setArtifactStatus` dynamically writes an event to the `events` table (e.g. `status-changed`) documenting the change. Additionally, a database-level trigger (`trg_artifact_status_change` in `migration/registry_schema.sql`) acts as a fallback to record a `status-changed` event whenever the status column updates, even if done via raw SQL or external processes.

### 6. Evidence Invalidation
If an artifact transitions back to `in-progress` or `needs-rework` (e.g., due to a failed review or bug report), `resetVerification` (`migration/registry/commands/verification.ts`) is called to clear any previous verification state. This enforces Constitution I: evidence bound to superseded outputs must not survive the change.

### 7. The `pending-approval` Hold (spec 013)
Not every approving arbiter verdict promotes an artifact straight to `reviewed`. `approveArtifactWithEvidence` (`migration/registry/commands/evidence.ts`) checks `resolveGateScope` (`migration/registry/commands/approval.ts`) against the artifact's stored risk assessment: if it's above the stack pack's high-risk cutoff, the artifact is transitioned to `pending-approval` instead, and an `approval-gated` event is written in the same transaction as the arbiter's `arbitration_decisions` row. `pending-approval` is a genuine `Status` value (`migration/registry/types.ts`) — it is claimable by nothing; the supervisor explicitly refuses to pick it up (see `supervisor.md`). A human operator releases the hold via `recordApprovalDecision` (`guildctl approve`), which writes one `approval_decisions` row and transitions the artifact to `reviewed` or `needs-rework`.

## Invariants and Edge Cases

- **Trigger-Based Event Logging:** To guarantee that the CLI commands (like `guildctl watch` which polls the `events` table) never miss a status transition, the `trg_artifact_status_change` trigger automatically logs an event if the `status` column changes directly.
- **Fail-Safe Claims Release:** `releaseTask` allows explicitly reverting a "stuck" claim (where `claimed_by` is set, but no active claim exists in `artifact_claims`, or it crashed in `pending`).
- **Idempotency of Verification Reset:** `resetVerification` silently degrades verification to `unverified` and `not-attempted` without deleting the historical row (FR-002 last-write-wins model), but does so immediately upon the artifact becoming active again.
- **Run Attempt Tracking:** The `runs` table tracks both normal execution logs (pid, usage) and "Attempt Outcomes" (e.g., `files_written_count`, `budget_consumed`, `outcome_label`). These attempt outcomes are crucial for tracking waste loops (`showNoProgressAttempts`) and are updated atomically via `finishRun` (`migration/registry/commands/runs.ts`).

## Gotchas

- **SQLite `ALTER TABLE` Limitations:** Because the specific SQLite build in use rejects `ADD COLUMN IF NOT EXISTS`, schema migrations for existing databases (in `migration/registry/db/schema.ts:applySchema`) use a split approach. The base schema contains the full table definitions, while `applySchema` splits the `.sql` file, explicitly guarding and running `ALTER` statements individually while catching expected "duplicate column" errors. Adding new columns requires strictly following this pattern.
- **Status is not Verification:** The artifact `status` transitioning to `migrated` merely means the code-writer *claims* to have finished its task. It does not mean the code is verified or correct; that state is strictly managed in `artifact_verifications` and `acceptance_evidence`.

## Extension Points

- **New Statuses:** Adding a new status requires updating `Status` in `migration/registry/types.ts`, and ensuring any logic in `supervisor/loop.ts` and `setArtifactStatus` correctly handles the new lifecycle stage. `pending-approval` (spec 013) is the reference example of a "non-claimable, awaiting-human" status: it had to be excluded from the supervisor's claim-eligibility whitelist (`claim.ts`/`queue.ts`), added to `terminalStatus`'s non-terminal checks (`queue.ts`), and given its own `AutoResult.status` value (`"held"`, `loop.ts`) so callers don't mistake a held artifact for a completed one.
- **Run Tracking:** Adding new telemetry for runs (like memory usage or API tokens) involves adding the nullable column to `runs` in `registry_schema.sql`, the schema fallback in `schema.ts`, the typing in `AttemptOutcomeInput`/`Run`, and the write path in `finishRun`.
