# The Claim Protocol: Distributed Task Execution

## Purpose and Overview

The **Claim Protocol** is a core distributed execution mechanism in the Migration Guild's registry (`migration/registry/commands/claim.ts`). It manages how autonomous agents acquire, hold, and release locks (claims) on artifacts (tasks) during the migration process.

Because multiple agents can run concurrently (e.g., in separate terminal tabs, or scheduled via a CI pipeline), the registry needs a robust way to ensure that:
1. No two agents work on the same artifact at the same time.
2. Agents only work on artifacts whose dependencies are resolved and have met the risk confirmation requirements.
3. If an agent crashes or hangs, its claim eventually expires so another agent can pick up the work.
4. Agents cannot accidentally release or heartbeat claims they do not own.

The system uses an explicit lease-based locking model backed by SQLite transactions to provide these guarantees.

## Architecture

The Claim Protocol is built on two primary database tables (defined implicitly in the SQLite schemas and modeled in `migration/registry/types.ts`):
1. **`artifacts`**: Represents the work items. An artifact's `status` indicates whether it's available (`planned`), being worked on (`in-progress`), or finished.
2. **`artifact_claims`**: Represents the active and historical leases. When an agent claims an artifact, a row is inserted here with a state of `active`.

### Core Data Models (`migration/registry/types.ts`)

- **`ArtifactClaim`**: Represents a lease. Key fields include:
  - `claim_id`: Unique identifier for the claim record.
  - `claim_token`: An opaque secret token. Only the holder of this token can release or heartbeat the claim.
  - `state`: Can be `active`, `completed`, `released`, `expired`, or `failed`.
  - `from_status`: The status the artifact was in *before* it was claimed. If the claim expires, the artifact is rolled back to this status.
  - `lease_expires_at`: The timestamp when the claim will naturally expire if not heartbeated.

- **`ClaimedArtifact`**: An intersection of an `Artifact` and its active `ArtifactClaim`. This is returned to the agent upon successfully securing a claim.

## Step-by-Step Flow

### 1. Acquiring a Claim (`claimNextTask`)

When an agent needs work, it calls `migration/registry/commands/claim.ts:claimNextTask`. The process is as follows:

1. **Candidate Selection:** A single, large SQLite query selects the best candidate artifact. The query enforces several strict rules:
   - The artifact must have the requested `fromStatus` (default is `planned`).
   - The artifact must match the requested `wave` and `tier`, if provided.
   - **Risk Gate:** The artifact must *not* have any pending risk confirmations (`SELECT 1 FROM risk_confirmations rc WHERE rc.artifact_id = a.id AND rc.decision != 'confirmed'`).
   - **Dependency Gate:** The artifact must *not* depend on any first-class artifact that is not yet fully migrated (i.e., its dependencies must be in `migrated`, `reviewed`, `completed`, or `skipped` states).
   - **Ordering:** Candidates are ordered by `wave ASC`, `in_degree DESC` (highly depended-upon artifacts are tackled first), and `created_at ASC`.

2. **Concurrency Check:** If a candidate is found, an `UPDATE` statement attempts to change its status to `in-progress`. If `update.changes !== 1`, it means another agent claimed it concurrently, and a `RegistryError` is thrown.

3. **Lease Creation:** A new row is inserted into `artifact_claims` with an `active` state. The `from_status` is saved (e.g., `planned`), and a `claim_token` is generated. The `lease_expires_at` is set (defaulting to 30 minutes, configurable via `GUILDCTL_CLAIM_LEASE_MINS`).

4. **Event Logging:** An event of type `claimed` is recorded in the `events` table.

### 2. Validating Ownership

Before any state-mutating operation (like releasing a claim), ownership is strictly validated. In `migration/registry/commands/claim.ts:releaseClaim`, the system checks:
- The claim exists and is `active`.
- The provided `claimToken` exactly matches the `claim_token` in the database.
If there's a mismatch, it throws a `RegistryError` (unless overridden with a `--force` flag by an operator).

### 3. Releasing a Claim (`releaseClaim`)

When an agent finishes its work (successfully or otherwise), it calls `migration/registry/commands/claim.ts:releaseClaim`.

This calls `releaseClaimRecord`, which:
- Updates the `artifacts` table, clearing the `claimed_by` and `claimed_at` fields.
- Updates the `artifact_claims` table, changing the state from `active` to `released` (or `completed` depending on the surrounding flow).
- Appends an event documenting the release.

### 4. Handling Crashes and Stale Claims (`reconcileStaleClaims`)

If an agent process is killed (OOM, SIGKILL) or hangs indefinitely, it will fail to release its claim. The `reconcileStaleClaims` function is periodically called by the system (e.g., before starting a new run or via a background poller).

It queries for claims where `state = 'active'` AND:
- `lease_expires_at` is in the past, OR
- The claim is associated with a specific `run_id`, but that run is no longer `running`.

For every stale claim found, `releaseClaimRecord` is called. The crucial detail here is the **Rollback Mechanism**: The artifact's status is rolled back to the `claim.from_status` (e.g., it goes from `in-progress` back to `planned`). This guarantees that incomplete work is re-queued for another agent, rather than being stuck in `in-progress` forever.

## Invariants and Edge Cases

- **Token Security:** The `claim_token` is opaque and never visible in public API responses (except to the agent that successfully acquired it). This prevents unauthorized agents from hijacking or dropping leases.
- **Rollback Correctness:** The `from_status` is recorded at the exact moment of claiming. If an artifact was claimed from `analyzed` instead of `planned`, an expired lease will correctly revert it to `analyzed`.
- **Run-Bound Claims:** When a claim is created, it can be bound to a specific `run_id`. If the run crashes, the system can quickly identify and release all active claims associated with that `run_id` without waiting for the `lease_expires_at` timer, speeding up recovery.