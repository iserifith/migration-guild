# Supervisor Loop Deep-Dive

The guildctl Supervisor (`migration/guildctl/supervisor/loop.ts`) is the autonomous engine driving artifacts through the migration pipeline without human intervention. This document explains how the supervisor handles process-tree termination, limits, provider budgets, and independent review close-outs.

## Architecture & Responsibilities

The supervisor loop runs an artifact through multiple phases (migrate, verify, review, repair). Its critical responsibility isn't just starting these phases, but *closing them out safely* when things fail.

Unlike a simple `execSync` wrapper, the supervisor handles the fact that LLM agents and autonomous tasks are inherently unstable. They hang, they hallucinate files, they spawn detached background processes, and they exhaust API quotas. The supervisor must cleanly tear down these failures, categorize them, and decide if a retry is mathematically viable.

### Key Components

- **`loop.ts:runAuto()`**: The core phase engine for a single artifact.
- **`failures.ts:FailureBudget`**: Tracks failures per artifact and determines retry eligibility based on the classified signature of the error.
- **`queue.ts:runAutoQueue()`**: Selects candidates and handles dependency-blocking logic across the full artifact queue.
- **`limits.ts:AutonomousLimitError`**: Connects time-based limits (ceiling/inactivity) to process cleanup and run state.

## 1. Limits and Process-Tree Termination

When an autonomous phase is executed, it runs under strict time limits (`ceiling` for total wall-clock time, `inactivity` for time without output). When a limit is hit, the supervisor doesn't just send a SIGTERM to the top-level PID.

### The Problem of Detached Processes

Build tools (`gradle`, `tsc`, `vite`), package managers (`npm`), and the agent tools themselves often spawn child processes. If the supervisor only killed the immediate child, orphaned grandchildren would continue running in the background, locking files, consuming CPU, and interfering with subsequent retries.

### Cleanup Outcome Tracking

When a limit fires, the underlying runner throws an `AutonomousLimitError` (defined in `migration/guildctl/limits.ts`). This error object explicitly carries the process-cleanup outcome:

```typescript
// migration/guildctl/limits.ts
export class AutonomousLimitError extends Error {
  constructor(
    message: string,
    public readonly cleanupOutcome: "clean" | "survivors" | "not-applicable" = "not-applicable",
    public readonly survivorPids: number[] = [],
  ) {
    super(message);
  }
}
```

The supervisor catches this error in `loop.ts` during both worker phase failures and review phase failures, and persists the cleanup state.

```typescript
// migration/guildctl/supervisor/loop.ts (Worker error handler snippet)
const limitKilled = workerError instanceof AutonomousLimitError;
const workerCleanupOutcome = limitKilled ? (workerError as InstanceType<typeof AutonomousLimitError>).cleanupOutcome : "not-applicable";
const workerSurvivorPids = limitKilled ? (workerError as InstanceType<typeof AutonomousLimitError>).survivorPids : [];

finishRun(db, {
  // ...
  cleanupOutcome: workerCleanupOutcome,
  survivorPids: workerSurvivorPids.length > 0 ? workerSurvivorPids : null,
  // ...
});
```

This tracking is critical: if `workerCleanupOutcome` is `"survivors"`, the operator knows there are rogue PIDs (`workerSurvivorPids`) left on the host that might require manual intervention before the artifact can be safely retried.

## 2. Review-Error Close-Out Handling

Independent review (`guardedIndependentReview`) presents a unique challenge. A failure in the *worker* (e.g., the code-writing agent) is expected and retryable. A failure in the *reviewer* (the agent tasked with verifying the worker's output) is more complex.

If the reviewer's process crashes or times out, should the artifact fail, or should the whole queue halt?

### The Non-Throwing Close-Out Path

The supervisor distinguishes between *infrastructure failures* (a malformed marker, a disconnected database) and *descriptor-derived limit terminations* (the reviewer hit its time limit analyzing a massive file).

```typescript
// migration/guildctl/supervisor/loop.ts:closeOutReviewError()
function closeOutReviewError(
  db: Database.Database,
  opts: AutoOptions,
  operatorToken: string,
  runId: string,
  attempts: number,
  error: unknown,
  statusFrom: string | null = "migrated",
): AutoResult {
    // ... persists the termination reason exactly as the worker-error path does
    // ... instead of throwing out of runAuto and halting every other artifact
}
```

If the `reviewError` is an `AutonomousLimitError`, `guardedIndependentReview` returns it gently rather than throwing:

```typescript
// migration/guildctl/supervisor/loop.ts:guardedIndependentReview()
if (reviewError instanceof AutonomousLimitError) return { violation: false, reviewError };
if (reviewError) throw reviewError;
```

This routes the timeout through `closeOutReviewError()`, which transitions the artifact's status to `blocked` and persists the reason (along with any survivor PIDs), allowing the queue to seamlessly move on to the next artifact. If it's *not* a limit error, it throws, intentionally halting the queue because an infrastructure invariant has been broken.

## 3. Provider Budget Consumption Tracking

Every LLM call costs money. A key invariant of the supervisor is that it must truthfully report when budget was consumed, even if the run failed spectacularly.

If a worker is terminated by a ceiling limit after 15 minutes, it almost certainly made LLM API calls during that time. If the supervisor recorded this attempt as "budget not consumed" because it didn't complete cleanly, the cost tracking would be dangerously inaccurate.

### Honest Conservative Defaults

Because autonomous workers do not currently plumb per-attempt token usage metrics back up through the process-tree termination boundary, the supervisor enforces an "honest conservative default":

```typescript
// migration/guildctl/supervisor/loop.ts (finishRun call)
// See closeOutReviewError: autonomous workers do not yet plumb
// per-attempt token usage; a worker that reached this point
// actually ran, so the honest conservative default is "consumed".
budgetConsumed: 1,
```

A value of `1` for `budgetConsumed` ensures that the run is flagged as having spent non-recoverable provider budget. The CLI output reflects this reality to the operator:

```
[guildctl] artifact-123 code-writing attempt closed — claim: released, retryable; process cleanup: clean (0 survivors); provider budget: consumed — this spend is not recovered
```

## 4. Failure Budgeting & The Playbook

When verification or repair fails cleanly (i.e., not a hard limit termination), the supervisor parses the output to classify the failure using `classifyFailure()` in `failures.ts`.

It then checks the `FailureBudget`.

```typescript
// migration/guildctl/supervisor/failures.ts
export class FailureBudget {
  canRunPlaybook(artifactId: string, failure: ClassifiedFailure, playbook: string): boolean {
    return (this.playbooks.get(this.key(artifactId, failure, playbook)) ?? 0) < this.maxPlaybookPerSignature;
  }
}
```

The budget prevents infinite loops of the *exact same mistake*. If the agent proposes code that results in `build-failure: tsc error 2322`, and then its repair attempt results in the *exact same* `build-failure: tsc error 2322`, the budget will quickly be exhausted for that specific signature, and the artifact will be marked `blocked` rather than burning through the remaining generic attempt limit.

## Conclusion: The `opts.resume` Semantic

A critical learning from the supervisor's design is the native behavior of the `resume` option. When an artifact is previously `blocked` and picked up by a `resume` run, the supervisor natively clears the `blocked` status to `migrated` if the verifier passes.

The supervisor actively rewrites states to move artifacts forward, relying on the robust close-out handlers described above to catch any resulting failures, ensuring that a blocked artifact isn't just permanently stuck if external conditions (like a dependency being fulfilled) have changed.