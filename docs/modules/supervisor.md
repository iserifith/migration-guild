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

## 5. The Approval Gate: `pending-approval` Is Never Claimed (spec 013)

A high-risk artifact whose arbiter verdict gets held at `pending-approval` (see `review-arbitration.md`) is *awaiting a human decision*, not blocked and not failed. The supervisor treats it as a third thing entirely.

### Short-Circuit Before Claiming

`runAuto` checks the artifact's status before it ever calls `requireReview`, `startRun`, or attempts a claim:

```typescript
// migration/guildctl/supervisor/loop.ts (top of runAuto)
if (initialStatusRow?.status === "pending-approval") {
  process.stderr.write(`held for approval: artifact ${opts.artifactId} is pending-approval; awaiting a human approval decision\n`);
  return { status: "held", runId, attempts, heldForApproval: true, reason: "pending-approval" };
}
```

This is deliberately a pre-flight, blacklist-style check specific to `runAuto`; the claim layer itself (`claimArtifactById` in `claim.ts`) enforces the same invariant structurally — its callers (including `queue.ts`'s candidate-selection query) simply never include `pending-approval` in their claim-eligible status whitelist. Both mechanisms have to agree, so any future non-claimable status needs updating in both places.

### Reporting "held" Instead of "complete" for Mid-Run Gating

An artifact can also become gated *during* the same `runAuto` call — the arbiter approves it, but it turns out to be above the risk cutoff, so `approveArtifactWithEvidence` gates it to `pending-approval` instead of promoting it. `reportApprovalOutcome` (`loop.ts`) re-reads the artifact's actual status after that call, rather than assuming success:

```typescript
// migration/guildctl/supervisor/loop.ts:reportApprovalOutcome()
function reportApprovalOutcome(db, artifactId, runId, attempts): AutoResult {
  const statusRow = db.prepare("SELECT status FROM artifacts WHERE id = ?").get(artifactId);
  if (statusRow?.status === "pending-approval") {
    return { status: "held", runId, attempts, heldForApproval: true, reason: "pending-approval" };
  }
  return { status: "complete", runId, attempts };
}
```

Both call sites that invoke `approveArtifactWithEvidence` route their return through this helper — `AutoResult.status` only ever reports `"complete"` when the artifact is genuinely done, never when it's sitting at `pending-approval`. This mirrors `arbitrate.ts`'s manual-arbitration path, which does the identical post-verdict status re-read for the same reason.

### Queue-Level Reporting

`queue.ts`'s `remainingCounts` tracks a `heldForApproval` count alongside `blocked`/`needsRework`/etc., and `terminalStatus` treats `heldForApproval > 0` as non-terminal (`"partial"`) — a queue run that finishes with artifacts still awaiting human approval is never reported as `"complete"`.

## 6. Attempt-Scoped Retry History (spec 013)

Before spec 013, the retry budget (`FailureBudget`, `failures.ts`) was purely in-memory: it started fresh every time `runAuto` was invoked. A supervisor restart mid-artifact would silently reset the attempt count, letting an artifact burn through more attempts than `maxAttempts` actually allows across the restart boundary.

### The `attempt_records` Table

`migration/registry/commands/attempts.ts` adds a durable, append-only `attempt_records` table: one row per concluded attempt (`artifact_id`, `attempt_no`, `outcome`, `failure_kind`/`failure_signature`, timings). `recordAttemptOutcome` is the only writer — a pre-existing `(artifact_id, attempt_no)` row throws `RegistryError` rather than being silently overwritten, so a bug that double-records an attempt number fails loudly instead of corrupting history.

### Seeding the Budget and the Loop Counter on Every Call

`getPersistedBudgetState(db, artifactId)` reads back `attemptsUsed` (a `COUNT(*)`) and per-signature playbook counts, and `runAuto` seeds *both* of the mechanisms that gate retries from it:

```typescript
// migration/guildctl/supervisor/loop.ts
const budget = new FailureBudget(maxAttempts, 2, {
  artifactId: opts.artifactId,
  ...getPersistedBudgetState(db, opts.artifactId),
});
let attempts = getPersistedBudgetState(db, opts.artifactId).attemptsUsed;
```

Seeding `attempts` (the loop's own counter, used to compute the next `attemptNo`) matters as much as seeding `budget`: without it, a resumed run would compute `attemptNo` starting from 1 again and collide with already-persisted rows, throwing instead of resuming at the correct attempt number. With both seeded from the same source, `getAttemptHistory(db, artifactId)` (FR-010) can answer "what happened on attempt N" purely from the registry — no log scraping — and that answer stays correct across any number of restarts.

## Conclusion: The `opts.resume` Semantic

A critical learning from the supervisor's design is the native behavior of the `resume` option. When an artifact is previously `blocked` and picked up by a `resume` run, the supervisor natively clears the `blocked` status to `migrated` if the verifier passes.

The supervisor actively rewrites states to move artifacts forward, relying on the robust close-out handlers described above to catch any resulting failures, ensuring that a blocked artifact isn't just permanently stuck if external conditions (like a dependency being fulfilled) have changed. The same restart-safety now extends to retry accounting (§6) and to artifacts awaiting human approval (§5) — neither loses track of its true state across a process restart.