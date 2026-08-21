# Phase 1 Contracts: Registry Commands and CLI Surface

This feature's external interfaces are (a) the `guildctl` CLI, consumed by operators, and (b) the `registry/commands/*` function contracts, consumed by the CLI today and by the Mission Control UI endpoint in the deferred US4 increment. Per FR-004, both surfaces MUST call the identical registry-layer functions — this file is the shared contract both are built against.

## Registry command contract: `registry/commands/approval.ts` (new)

### `resolveGateScope(db, artifactId): GateScopeResult`

```ts
interface GateScopeResult {
  inScope: boolean;
  reason: string; // e.g. "risk_score 0.82 exceeds cutoff 0.70" or "below cutoff"
}
```

Reads `artifact_risk_assessments.high_risk` (already computed by the existing risk-scoring feature) and the stack pack's `resolveRiskSpec`. Pure read, no side effects. Called by `evidence.ts`'s approval path at the moment an approving arbiter verdict would otherwise transition `migrated → reviewed`.

### `recordApprovalDecision(db, opts): ApprovalDecision`

```ts
interface RecordApprovalDecisionOptions {
  artifactId: string;
  operator: string;
  decision: "approved" | "rejected";
  reason?: string;          // REQUIRED when decision === "rejected"; throws RegistryError otherwise
  runId?: string;
  operatorToken?: string;
}
```

**Preconditions** (each violation throws `RegistryError`, matching the existing `approveArtifactWithEvidence`/`rejectArtifactWithEvidence` error-shape convention):
1. Artifact status MUST be `pending-approval` — otherwise "Artifact is not awaiting approval."
2. `operator` MUST NOT equal the `arbiter` on the artifact's most recent `arbitration_decisions` row — otherwise "Approving arbiter cannot record the human decision." (research.md §1)
3. `checkEvidenceFreshness` MUST pass for the artifact — otherwise the existing freshness `RegistryError` reason (research.md §3, FR-006).
4. `reason` MUST be present when `decision === "rejected"`.

**Effect** (single transaction): inserts one `approval_decisions` row; transitions `artifacts.status` to `reviewed` (approved) or `needs-rework` (rejected); writes an `events` row consistent with existing status-transition logging conventions elsewhere in the registry.

### `listPendingApprovals(db): PendingApproval[]`

```ts
interface PendingApproval {
  artifactId: string;
  riskReasonCodes: string[];      // from artifact_risk_assessments.reason_codes_json
  arbitrationVerdictSummary: string; // from the linked arbitration_decisions row
  enteredPendingApprovalAt: string;
}
```

Pure read. Backs both `guildctl approve --list` and the deferred UI panel — one query, two renderers.

## Registry command contract: `registry/commands/attempts.ts` (new)

### `recordAttemptOutcome(db, opts): void`

```ts
interface RecordAttemptOutcomeOptions {
  artifactId: string;
  attemptNo: number;
  phase?: string;              // default "migrate"
  outcome: "succeeded" | "failed" | "budget-exhausted";
  failureKind?: FailureKind;   // required when outcome !== "succeeded"; from failures.ts's existing type
  failureSignature?: string;
  startedAt: string;
}
```

**Preconditions**: `(artifactId, attemptNo)` MUST NOT already exist in `attempt_records` — a collision throws `RegistryError` ("Attempt N already recorded for artifact X") rather than silently overwriting (data-model.md §3 invariant).

**Effect**: single `INSERT` into `attempt_records`.

### `getAttemptHistory(db, artifactId): AttemptRecord[]`

Pure read, ordered by `attempt_no`. Backs FR-010 ("queryable after the fact... without requiring access to process logs") directly — this is the function a maintainer or a future CLI/UI history view calls.

### `getPersistedBudgetState(db, artifactId): { attemptsUsed: number; playbookSignatureCounts: Record<string, number> }`

Pure read used by `FailureBudget`'s constructor (research.md §5) to seed in-process budget accounting from durable state — this is what makes FR-009's restart-resumption guarantee hold: the class no longer starts from an empty `Map`, it starts from this query's result.

## CLI contract: `guildctl approve`

```
guildctl approve --list [--json]
  Lists artifacts currently in pending-approval, per listPendingApprovals().

guildctl approve <artifact-id> [--reject --reason <text>] [--run-id <id>] [--operator-token <token>]
  Approves (default) or rejects (--reject, --reason required) the named artifact.
  Calls recordApprovalDecision() — no command-local business logic, no hand-rolled SQL (FR-004).
  Exit code non-zero + single clean stderr line on any RegistryError, matching the existing
  `guildctl arbitrate` error-handling convention in arbitrate.ts.
```

Follows the existing `guildctl arbitrate --approve/--reject --reason` argument-shape precedent in `migration/guildctl/commands/arbitrate.ts` so operators reuse a familiar mental model.

## Supervisor contract additions (not a new command, existing files extended)

- `supervisor/loop.ts` claim-eligibility query MUST exclude artifacts with `status = 'pending-approval'` (they are not claimable work) — same exclusion shape already used for `blocked`/`skipped`.
- `supervisor/loop.ts` run-summary reporting MUST list `pending-approval` counts in a field distinct from `blocked` (FR-005) — e.g. `heldForApproval: number` alongside the existing `blocked: number` summary field.
- `supervisor/failures.ts`'s `FailureBudget` gains persistence via `attempts.ts` (research.md §5) — constructor signature may gain an optional `db`/`artifactId` seed argument; exact shape decided at implementation time, not fixed here, since it is an internal contract with a single caller (`loop.ts`) rather than a public interface.

## Explicitly not contracted here (deferred)

- Mission Control UI endpoint (US4/P2) — will reuse `listPendingApprovals`/`recordApprovalDecision` verbatim per FR-004 when planned; no HTTP contract is defined in this increment.
