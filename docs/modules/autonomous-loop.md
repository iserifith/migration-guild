# The Autonomous Supervisor Loop

## Purpose and Overview

The **Autonomous Supervisor** (`migration/guildctl/supervisor/loop.ts`) is the state-machine engine that orchestrates the end-to-end lifecycle of an automated migration attempt. Unlike the manual CLI runner which simply spawns a requested agent and records the result, the Supervisor actively drives artifacts through a rigid lifecycle: Migration $\rightarrow$ Verification $\rightarrow$ Independent Review $\rightarrow$ Approval or Repair.

It implements critical guardrails including failure budgets, artifact drift analysis, and strict adherence to the Warden's filesystem boundaries. If any step fails, the loop evaluates the exact nature of the failure (via `migration/guildctl/supervisor/failures.ts`) and determines if the artifact is eligible for another repair pass or if it should be permanently blocked for operator attention.

## Architecture

The Supervisor loop relies on four major components orchestrated via `runAuto`:

1. **Worker Protocol (`worker`)**: The capability to dispatch an autonomous agent (either a code-writer for migration or a remediation agent for repair) against an artifact.
2. **Verifier (`verifier`)**: An injected verification protocol that runs project-defined checks (e.g., tests, linters, stack checks). Verification dictates whether the artifact moves to review or triggers a repair.
3. **Independent Review (`review`)**: A strictly separate review pass (`runIndependentReview`) driven by a different agent or model. It verifies the quality of migrated code *after* verification passes.
4. **Drift Gate (`computeDriftGate`)**: An analyzer that evaluates the structural API changes between the legacy artifact and the modernized output (e.g. `highRiskDriftKinds` like `public-method-removed` or `visibility-narrowed`).

## Step-by-Step Flow

The main logic resides in `runAuto(db, opts)`:

### 1. Resume Check (US3 / T047-T049)
If the supervisor starts with `opts.resume = true`, it checks if the artifact is `blocked` or `migrated` (with a prior failure). The loop re-runs the `verifier`.
- **Passed**: A blocked artifact has its blocked cause cleared by the verifier, its status is restored to `migrated`, and the artifact proceeds directly to Independent Review.
- **Failed**: The artifact is placed in the `repair` phase, keeping its failure state.

### 2. Worker Attempt
The loop enters a budget-constrained cycle (`FailureBudget` handles limits per artifact/failure signature).
- Claims the artifact, defining the worker phase (`migrate` or `repair`).
- Snapshots the filesystem via Warden.
- Invokes the `worker`.
- Immediately runs `enforceWardenSnapshot`. If the worker violates filesystem rules, the artifact is hard-blocked and the run terminates (fail-closed).
- If the worker crashes or hits a limit (`AutonomousLimitError`), the worker attempt is closed with a terminal or retryable error label.

### 3. Verification at Claim Close
Independent of the loop's branching logic, the supervisor runs `verifyAtClaimClose` to capture the static state of the workspace just as the claim finishes (e.g., stack completeness).

### 4. Verification and Drift Gate
The `verifier` tests the agent's work.
- **Fail**: The failure is categorized via `classifyFailure` (e.g. `test-failure`, `build-failure`). If budget remains, it transitions the phase to `repair` and loops back to step 2. If the budget is exhausted, it blocks the artifact.
- **Pass**: The loop evaluates the Drift Gate (`computeDriftGate`). If high-risk structural changes occurred (e.g. `public-method-removed`), the Drift Gate fails and blocks the artifact. Otherwise, static-check evidence is recorded.

### 5. Independent Review
If the drift gate is cleared, `guardedIndependentReview` dispatches the reviewer agent.
- The review is heavily guarded by its own Warden pass (`guildctl-review-warden`) with an *empty allow-list*—the reviewer is strictly read-only.
- If the reviewer rejects the artifact (`reviewed.approved = false`), the artifact is sent to `repair` if budget allows, otherwise it is rejected and blocked.
- If approved, `approveArtifactWithEvidence` finalizes the transition, and the run exits successfully.

## Invariants and Edge Cases

- **Limit Expirations (`AutonomousLimitError`)**: If a worker or reviewer is terminated by the runner's limit watcher (inactivity or timeout ceiling), this is surfaced as an `AutonomousLimitError`. The supervisor catches this and closes the artifact attempt gracefully, preserving process cleanup logs (`survivorPids`) instead of crashing the entire loop (T048, T049).
- **Remediation Confirmed No Defect (US2 / T009)**: If the repair worker appends the event `remediation-confirmed-no-defect`, the supervisor recognizes that no defect was found. The loop immediately halts the verification/repair cycle and surfaces the artifact to the operator as `blocked`.
- **Reviewer Read-Only Enforcement**: A reviewer agent must never modify the filesystem. Its Warden pass passes an empty `allowedPaths` array. If a modification is detected, the run is hard-blocked as a filesystem violation.
- **Review Identity (Assert Independent Review)**: The Independent Reviewer must never be the same agent (and if specified, the same model) as the producer. `assertIndependentReview` rigidly enforces this separation.

## Gotchas and Extension Points

- **Resume Drift Gate (Gotcha)**: When resuming an already-verified artifact, the drift gate still re-runs. If the artifact has out-of-date signatures compared to the expected outputs, the resume will fail even if verification passed.
- **Failure Classification (`failures.ts`)**: When extending the testing pipeline or introducing new worker tasks, the regex-based signatures in `normalizeFailureSignature` may need updates so that new error logs are mapped correctly to `FailureKind`s instead of being tracked as `unknown`.
- **Worker Injection**: The `runAuto` loop does not hardcode the agent spawning logic. The `opts.worker`, `opts.review`, and `opts.verify` are injected callbacks, meaning this loop can theoretically oversee vastly different kinds of AI pipelines as long as they abide by the claim/warden/evidence protocols.
