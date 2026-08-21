# Review and Arbitration Protocol

## Purpose and Overview

The **Review and Arbitration Protocol** governs how a migrated artifact's acceptance evidence is evaluated and formally accepted (or rejected) into the main branch. Once an agent has generated code and tests, and the verification step has produced evidence of passing checks, the artifact enters the review phase. 

This protocol ensures that an independent critic assesses the work on its merits, completely read-only, and that an arbitration gate records the final decision. It strictly enforces independence between the producer and the reviewer to prevent a single agent from self-approving its own mistakes.

## Architecture

The review and arbitration system consists of the following key surfaces:

1. **Review Command (`migration/guildctl/commands/review.ts`)**: The CLI entry point that identifies `migrated` artifacts eligible for review and dispatches them to a review agent.
2. **Supervisor Integration (`migration/guildctl/supervisor/loop.ts`)**: The autonomous loop that orchestrates verification, independent review, and handling of review decisions.
3. **Read-Only Warden Guard (`guardedIndependentReview`)**: A wrapper that ensures the review agent operates with zero authorized filesystem mutations.
4. **Arbitration Command (`migration/guildctl/commands/arbitrate.ts`)**: The CLI surface for manual human operator arbitration, allowing an operator to override or bypass the automated reviewer.

## Step-by-Step Flow

### 1. Triage and Candidate Selection

The `runReview` function in `migration/guildctl/commands/review.ts` continually polls the registry for artifacts in the `migrated` state. 
- It uses `getMigratedArtifacts` to find artifacts that are `migrated` and not currently being reviewed.
- It formats a triage note (`formatReviewTriageNote`) combining the artifact's verification state and reason. This state is strictly "triage input only"—a verified artifact still requires independent evidence and cannot bypass the arbiter gate on the strength of verification alone.

### 2. Independent Review Execution

In an autonomous run (`migration/guildctl/supervisor/loop.ts`), after verification succeeds, the supervisor invokes the reviewer via `guardedIndependentReview`:
- **Pre-Review Snapshot**: A Warden snapshot is taken using `snapshotWorkspaceForWardenWithExclusions` to capture the exact pre-review state of the workspace.
- **Agent Invocation**: The `runIndependentReview` function executes the review agent logic, passing along the acceptance evidence.
- **Independence Check**: `assertIndependentReview` asserts that the reviewer agent differs from the producer agent (e.g., `code-writer-agent`). If the reviewer is identical, it fails, guaranteeing separation of concerns.

### 3. Read-Only Warden Enforcement

The most critical invariant of the review phase is that reviewers are observers, not writers. 
After the review agent completes its assessment, `guardedIndependentReview` calls `enforceWardenSnapshot` with an empty allow-list (`allowedPaths: []`).
- If the reviewer modified *any* verified workspace bytes, the Warden reverts the changes and returns a violation.
- The artifact is immediately marked as `blocked` with the reason `"Independent reviewer modified verified workspace bytes"`.

### 4. Arbitration Gate

Once a valid decision is returned by the independent reviewer, the arbitration gate applies it:
- **Approval**: If the reviewer approves, `approveArtifactWithEvidence` is called, recording the reviewer's identity, the reason, and the evidence IDs. The artifact's status transitions to `reviewed` (or `complete` in the supervisor loop).
- **Rejection**: If the reviewer rejects, the supervisor either schedules a repair attempt (`scheduleReviewRejectionRepair`) by transitioning the artifact back to `migrated` (in `repair` phase) or permanently fails it using `rejectArtifactWithEvidence`.

### 5. Manual Arbitration

Operators can manually arbitrate an artifact using `migration/guildctl/commands/arbitrate.ts` (e.g., `runArbitrate`).
- **Approvals**: For manual approvals outside an `auto` run, if no `--run-id` and `--operator-token` are provided, the system mints an ad-hoc run + operator credential scoped to this single invocation (`startRun`, `createRunOperatorCredential`). The evidence authenticity HMAC binds to this new run.
- **Rejections**: The `--reject` path never mints a run credential, preventing unused run/operator rows from being left behind.

## Invariants and Edge Cases

- **Strict Read-Only Enforcement**: The Warden uses an explicitly empty allow-list (`allowedPaths: []`) for the review phase. Custom file-locking is avoided entirely in favor of reusing the Warden's snapshot/diff capabilities.
- **Producer-Reviewer Separation**: The `producerAgent` and `reviewerAgent` must differ. A reviewer cannot be the same agent that wrote the code.
- **Resume Semantic Restoration**: If a previously `blocked` artifact is resumed and passes re-verification, the supervisor actively clears the `blocked` status and rewrites it to `migrated` (`migration/guildctl/supervisor/loop.ts`). This ensures the independent review and arbitration process operates on the correct proposed state.
- **Non-throwing Review Limit Terminations**: If a review agent is terminated due to liveliness limits (e.g., `AutonomousLimitError`), it is caught and routed through a non-throwing close-out (`closeOutReviewError`). This gracefully blocks the specific artifact while leaving the rest of the supervisor queue runnable.

## Gotchas

- **Manual Approvals Against Different Runs**: Supplying an explicit `--run-id` and `--operator-token` to `runArbitrate` is the supported path for approving evidence signed by a different run. Otherwise, the registry will reject the action with a "valid run operator credential" error.
- **Triage is Not Authorization**: A verification state of `verified` displayed to a reviewer is strictly triage information. The reviewer must still process the evidence.

## Extension Points

- `runArbitrate` (`migration/guildctl/commands/arbitrate.ts`): Can be extended to support complex operator workflows, such as multi-party sign-offs or different credential sources for manual evidence overrides.
- `guardedIndependentReview` (`migration/guildctl/supervisor/loop.ts`): The hook where alternative or additional static analysis mechanisms can be injected before the review decision is finalized.
