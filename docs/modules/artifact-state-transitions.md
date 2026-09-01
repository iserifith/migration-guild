# Artifact State Transitions

## Purpose and Overview

The migration pipeline operates on "artifacts" (typically modules or packages being migrated). An artifact progresses through various statuses: `pending`, `planned`, `analyzed`, `tests-written`, `migrated`, etc. The module `migration/registry/commands/artifacts.ts` handles how artifacts are registered and how their status changes.

However, artifact statuses in this repository are not simple unconstrained state machines. The transition logic is tightly bound to run claims, token-based authorization, and filesystem strictness (the "warden"). This document provides a deep dive into how artifact statuses transition and the exact safeguards involved, primarily focusing on `setArtifactStatus` and `releaseTask`.

## Architecture and Data Path

The artifact state transition logic primarily resides in `migration/registry/commands/artifacts.ts`. It interacts with other subsystems:
- **Claims System (`migration/registry/commands/claim.ts`)**: To verify that a process attempting to change an artifact's status actually holds a lease on that artifact.
- **Warden Filesystem Rules (`migration/registry/commands/artifacts.ts:wardenRestoredOwnOutput`)**: To prevent an artifact from being marked `migrated` if the agent failed to generate the required output on disk and the warden had to roll back the changes.
- **Verification (`migration/registry/commands/verification.ts`)**: To reset verification state if an artifact's state regresses.

## Step-by-Step Flow

### 1. Registering an Artifact
Artifacts are instantiated via `registerArtifact` (`artifacts.ts:68`).
They are always initialized with the status `pending`. It establishes their tier (`first-class` vs `second-class`), their role, and framework.

### 2. Transitioning Statuses via `setArtifactStatus`
The core of state transition is `setArtifactStatus` (`artifacts.ts:123`). This function encapsulates all business logic and invariants for changing an artifact's status.

#### Warden Constraint
If an agent finishes its run and requests to transition the artifact to `migrated`, `setArtifactStatus` enforces a strict filesystem-level invariant (US4 / #156):

```typescript
// migration/registry/commands/artifacts.ts:setArtifactStatus
if (
  status === "migrated" &&
  opts.claimId &&
  opts.claimToken &&
  wardenRestoredOwnOutput(db, id, opts.claimId)
) {
  throw new RegistryError(
    3,
    `Refusing to record "${id}" as migrated: the warden restored this artifact's own claimed ` +
      `output mid-migrate, so the workspace no longer holds the delivered output.`,
  );
}
```
If the warden had to restore the artifact's *own* claimed output paths due to a filesystem violation, the system refuses to record `migrated`. The workspace no longer contains the delivered code, so marking it `migrated` would lie to the pipeline.

#### Claim Authorization
When changing a status, the execution must provide correct credentials.
If the artifact is currently `in-progress` and there is an active claim, the caller must either:
1. Complete the claim (via `completeClaimForArtifact`) by providing `opts.claimId` and `opts.claimToken`.
2. Release the claim (via `releaseClaimByArtifactId`) by providing a valid run operator credential (`opts.runId` and `opts.operatorToken`).

This ensures that one agent cannot forcibly transition the state of an artifact actively claimed by another agent without proper authorization.

#### Constitution I: Reset Verification
If an artifact is downgraded or re-enters work states (`in-progress` or `needs-rework`), the system ensures that previous verifications (which might represent stale, superseded output) are invalidated.

```typescript
// Content-bound evidence rule (Constitution I): a verification of superseded
// output must not survive the change. Re-entering in-progress or
// needs-rework invalidates the record back to unverified / not-attempted.
if (status === "in-progress" || status === "needs-rework") {
  resetVerification(db, id);
}
```

#### Event Logging
Finally, successful transitions record a `status-changed` event containing the `previous_status`, `new_status`, and a reason, which feeds into the UI timeline and CLI observability.

### 3. Releasing Abandoned Claims (`releaseTask`)
When an agent crashes or stalls without finishing its run, the artifact is left stuck. `releaseTask` (`artifacts.ts:282`) handles releasing these abandoned claims.

It explicitly allows releasing an artifact even if it's currently marked as `pending` but still has a `claimed_by` value. This handles cases where an agent crashed after claiming but before it could successfully push the status to `in-progress`. If there is no active claim row, it reverts the artifact's status back to its `claimed_from` value (e.g., `planned`).

## Invariants and Edge Cases

- **No Force-Migrate on Warden Violations:** You cannot mark an artifact as `migrated` if the warden reverted the agent's work.
- **Token Required for Active Claims:** Changing an `in-progress` artifact's status requires a valid `claimToken` or `operatorToken`.
- **Idempotency on Tags:** The `addTag` function enforces uniqueness manually and ignores duplicates silently without throwing errors.
- **Verification Reset:** Transitioning an artifact back to `in-progress` or `needs-rework` immediately resets its verification status to ensure stale verifications are not persisted.

## Extension Points

- **New Statuses:** Adding a new status requires updating the `Status` type definition in `migration/registry/types.ts` and ensuring the UI and planner gracefully handle the new state.
- **Additional Pre-Transition Guards:** Additional invariants before state transition (like the warden constraint) would be added to the transaction block at the start of `setArtifactStatus`.
