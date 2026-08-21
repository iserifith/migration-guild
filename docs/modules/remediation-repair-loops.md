# Remediation & Repair Loops

## Purpose and Overview

This module covers what happens **after** a review/arbitration verdict or a crashed run says "no": how failed work gets put back into the claimable pool, how attempt counters are kept honest across restarts, and how the two very different "fix it" entry points relate to each other:

- **`guildctl remediate`** (`migration/guildctl/commands/remediate.ts`) — a *manual* command that spawns one `remediation-agent` LLM run to diagnose and apply exactly one safe, registry-only recovery action.
- **`guildctl repair`** (`migration/guildctl/commands/repair.ts`) — a *manual*, non-LLM crash-recovery sweep: reap dead runs, reconcile stale claims, force-release stuck artifacts. It never spawns an agent.
- **Autonomous `repair` phase** (`migration/guildctl/supervisor/loop.ts`, dispatched by `migration/guildctl/commands/auto.ts`) — the in-loop retry where the supervisor re-claims an artifact from `migrated` (or `blocked`) and dispatches a `remediation-agent` worker under the failure budget.

The arbitration/review decision itself is documented in `docs/modules/review-arbitration.md`; the single-owner claim protocol and lease mechanics are documented in `docs/modules/claim-protocol.md`. This doc cross-references both and only explains the *remediation-side* behavior.

## Architecture

Four cooperating layers:

1. **Claim lifecycle primitives** — `migration/registry/commands/claim.ts`: `releaseClaimsForRun`, `releaseClaimedArtifactsForOwner`, `reconcileStaleClaims`, `heartbeatClaim`. Every release path funnels through the private `releaseClaimRecord` (claim.ts), which returns the artifact to its recorded `from_status` and flips the claim row to `released`/`expired`.
2. **Attempt history** — `migration/registry/commands/attempts.ts`: append-only `attempt_records` written solely by `recordAttemptOutcome`; read back by `getPersistedBudgetState` to re-seed the supervisor's `FailureBudget` after a restart.
3. **Manual commands** — `remediate.ts` (LLM recovery) and `repair.ts` / `release.ts` (operator-driven unblocking).
4. **Autonomous loop** — `supervisor/loop.ts:runAuto` owns the migrate→verify→review→repair state machine; `supervisor/queue.ts:runAutoQueue` iterates artifacts and pre-cleans stale state via `reapDeadRuns` + `reconcileStaleClaims`.

## Step-by-Step Flow

### A. Manual `remediate`

`migration/guildctl/commands/remediate.ts:runRemediate`:

1. Resolves the model from the **`review`** phase (`resolvePhaseModel("review", cfg)`) but resolves its timeout from the **`remediation`** limit phase: `resolveEffectiveLimit("remediation", "ceiling", ...)` (remediate.ts:84–88). The T045 comment is explicit: the run label `phase: "review"` is dashboard/logging categorization only; enforcement uses `limitPhase: "remediation"`.
2. Builds a prompt via `makeRemediationPrompt` (remediate.ts:38): with `--id` it scopes to that artifact; without, it asks for "one remediation loop for the highest-priority exception". Both variants instruct the agent to apply **exactly one safe registry-only recovery action** and to **never edit files under `legacy/` or `modern/`**.
3. Calls `spawnAgent` with `agent: "remediation-agent"`, `limitPhase: "remediation"`, and **`releaseClaimsOnFailure: true`** (remediate.ts:109–120). In `migration/guildctl/runner.ts` (~line 701), when the child exits non-zero this flag triggers `releaseClaimsForRun` (falling back to `releaseClaimedArtifactsForOwner`) so any claim the remediation agent held is handed back instead of dangling until lease expiry.
4. Prints a before/after status-count delta (`printRemediationSummary`, statuses from `getStatusCounts`) and throws if `summarizeRunFailures` reports failure.

Tests: `migration/test/remediate-command.test.ts` verifies the targeted prompt and the non-zero-exit throw.

### B. Manual `repair` (crash sweep, no LLM)

`migration/guildctl/commands/repair.ts:runRepair`, five steps:

1. **Reap dead runs** — `reapDeadRuns` (`registry/commands/runs.ts`): runs whose PID is gone (or PID-less rows older than `GUILDCTL_STALE_RUN_MINUTES`, default 10) are marked failed; this cascades into step 2 because their claims are then backed by a non-running run.
2. **Reconcile stale claims** — `reconcileStaleClaims` (`claim.ts:672`): releases every active claim whose `lease_expires_at <= now` **or** whose bound run no longer exists/isn't running. Each artifact returns to the claim's `from_status` ("returned to planned/migrated/…"). The dry-run twin `reconcileStaleClaimsDryRun` (repair.ts:270) runs the identical query read-only.
3. **Release stuck artifacts** — unless disabled, `getStuckArtifacts` (repair.ts:33) finds `in-progress` artifacts with active claims (optionally filtered by `--older-than` minutes and wave) and calls `releaseTask` (`registry/commands/artifacts.ts:282`). Note `releaseTask` also accepts the abandoned-claim case `status='pending' AND claimed_by != NULL` (#124) but refuses `planned` + unclaimed.
4. **Record next-step guidance** — `setNext` (`registry/commands/operator.ts`) points the operator at `inventory`, `migrate [--wave N]`, or `status` depending on remaining counts.
5. **Summarize** and print status/wave/in-progress panels plus stale-session warnings.

`guildctl release --id X | --all-stuck` (`migration/guildctl/commands/release.ts:runRelease`) is the narrower operator tool: same `releaseTask` primitive, no run-reaping or claim reconciliation.

Tests: `migration/test/repair-command.test.ts` covers clean-state reporting, dead-run reaping, dry-run immutability, and stuck-release-by-default.

### C. Autonomous repair inside `runAuto`

`migration/guildctl/supervisor/loop.ts:runAuto` (see `docs/modules/autonomous-loop.md` for the full machine; here only the repair transitions):

1. **Entry into repair**: three ways —
   - Verification fails → `classifyFailure({phase:"verify",...})`; if `budget.canRunPlaybook(artifactId, failure, "repair")` holds, `budget.recordPlaybook(...)` is called, the attempt outcome is durably recorded as `"failed"` (loop.ts:1018–1027), and the loop sets `fromStatus = "migrated"; phase = "repair"`.
   - Independent review rejects → `scheduleReviewRejectionRepair` (loop.ts:291) classifies `review rejected: <reason>` as a failure, checks both the artifact budget and the per-signature repair playbook budget, records an `auto-rework` event, and on success sets `fromStatus="migrated"; phase="repair"; reviewReason=<reason>`. If it returns `false` (no budget), the artifact is terminally rejected via `rejectArtifactWithEvidence` and blocked.
   - Resume of a blocked/failed artifact whose re-verification fails → straight into `phase="repair"` with `fromStatuses` extended to include `"blocked"` on the reclaim (loop.ts:698–700).
2. **Worker spawn**: each iteration claims via `claimArtifactById` with `agent: phase === "repair" ? "remediation-agent" : "code-writer-agent"` and owner `guildctl-auto:<artifactId>` (loop.ts:685–701). The actual process is spawned in `migration/guildctl/commands/auto.ts` (~line 440): the child gets `GUILDCTL_AUTO_PHASE`, `GUILDCTL_CLAIM_ID/TOKEN`, `GUILDCTL_REVIEW_REASON`, etc., and limits are enforced through `enforceSpawnLimits(child, limitPhaseForAutoWorker(phase), cfg)` — a limit firing raises `AutonomousLimitError`.
3. **Failure close-out**: on worker error or warden violation, the loop calls `releaseClaimsForRun(db, runId, "guildctl", "auto cleanup after failed <phase>")`, records the attempt outcome (`recordAttemptOutcome`, attempts.ts:66 — insert-only; a duplicate `(artifact_id, attempt_no)` throws), sets the artifact `blocked`, and finishes the run with a derived outcome label. On success the claim is released with `"auto cleanup after <phase>"` before verification runs.
4. **Terminal states**: budget exhaustion breaks the loop → final `releaseClaimsForRun(..., "auto budget exhausted")` + `blocked`. A remediation pass that appends the `remediation-confirmed-no-defect` event makes the next `runAuto` invocation refuse to re-loop entirely (loop.ts:540–551, US2/T009).

### D. Attempt counters & durable budget

- The claim row itself carries `attempt_no`: both `claimNextTask` and `claimArtifactById` compute `MAX(attempt_no)+1` over prior claims for the artifact (claim.ts:572–577, 804–808). So every re-entry into the pool increments the counter regardless of who released the previous claim.
- The supervisor's in-memory counter is seeded from disk: `attempts = getPersistedBudgetState(db, artifactId).attemptsUsed` (loop.ts:533) and `FailureBudget` is constructed with the persisted `{attemptsUsed, playbookSignatureCounts}` (loop.ts:508–511). This is why `recordAttemptOutcome` must fire *before* every repair boundary — including the review-rejection path, where ordering matters doubly because evidence-freshness tie-breaks by rowid (comment at loop.ts:924–929).
- Outcomes are `"succeeded" | "failed" | "budget-exhausted"`; `failure_kind` is NULL iff succeeded (attempts.ts:66–74 invariant).

## Invariants & Edge Cases

- **Release always returns to `from_status`**, never blindly to `planned`: `releaseClaimRecord` (claim.ts:210) restores `claim.from_status ?? "planned"`, and claims record the status actually reclaimed from (US3), so a repair claim made from `blocked` returns to `blocked` on release.
- **Lease vs liveness**: a claim goes stale either by lease expiry (`GUILDCTL_CLAIM_LEASE_MINS`, default 30, floor 5) or by its run dying — `reconcileStaleClaims` treats both, distinguishing only for the event reason string.
- **Append-only attempts**: `(artifact_id, attempt_no)` collisions throw rather than overwrite; restart-resumption therefore neither resets nor double-counts budget (FR-009).
- **Remediation agents don't touch code**: both the manual prompt (remediate.ts:46) and the autonomous remediation path rely on the warden snapshot to enforce that only expected output paths change; a violating worker is hard-blocked, not retried.
- **`remediate` failure ≠ artifact failure**: `runRemediate` throwing only fails the CLI invocation; the released claims simply make work re-claimable. There is no attempt-record write on the manual path — manual remediation does not consume autonomous budget.
- **Dry-run symmetry**: `repair --dry-run` mirrors all three mutation queries read-only and prints `[dry-run]` annotations; verified by test.

## Gotchas

- **Phase-name mapping is load-bearing**: manual phases (`remediation`, `review`, …) differ from auto worker phases (`migrate`, `repair`). `limitPhaseForAutoWorker` (`limits.ts:173`) maps `repair → "remediation"` and `migrate → "code-writing"`, and `resolveEffectiveLimit` resolves knobs/floors from that name (`GUILDCTL_REMEDIATION_TIMEOUT_MINS`, 15m default, 5m floor). Meanwhile `spawnAgent`'s `phase` field is a *label* — `remediate` deliberately labels its run `review` while enforcing the `remediation` limit. Confusing the two makes termination messages quote a knob that doesn't govern (the FR-028 problem `resolveEffectiveLimit` exists to prevent).
- **`repair` is not "retry migration"** — it only clears crash state; it never spawns agents and never changes statuses other than returning claimed artifacts to pre-claim values. Re-entry into the pool is implicit: once an artifact is back at `planned`/`migrated` with no active claim, normal candidate selection picks it up.
- **Queue-level pre-clean vs command-level repair**: `runAutoQueue` calls `reapDeadRuns` + `reconcileStaleClaims` itself at startup (queue.ts:245–246), so autonomous runs self-heal stale claims; `guildctl repair` is mainly for interactive/operator contexts.
- **A queue-halting throw vs per-artifact block**: reviewer failures that are not `AutonomousLimitError` propagate out of `runAuto` and fail the whole queue (`guardedIndependentReview`, loop.ts:357–363); limit terminations route through `closeOutReviewError` and block just the one artifact.
- **`releaseTask` refuses healthy artifacts**: `planned` + unclaimed cannot be "released"; only genuinely stuck states qualify.

## Extension Points

- **New limit phases**: add a `CEILING_SPECS` entry in `limits.ts` and (if it's an auto worker phase) extend `limitPhaseForAutoWorker`'s mapping.
- **New recovery actions**: the remediation agent's contract is "exactly one safe registry-only action" — new actions belong in the remediation-agent instructions, not in `remediate.ts`, which only composes prompts.
- **New failure signatures**: `classifyFailure`/`normalizeFailureSignature` in `supervisor/failures.ts` drive playbook-budget accounting; unmapped errors become `unknown` signatures with their own budget bucket.
- **Injected workers**: `runAuto` takes `worker`/`verify`/`review` callbacks, so an alternative repair strategy can be tested hermetically (as the tests do) without touching the loop.
