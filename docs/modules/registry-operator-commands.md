# Registry Operator Command Surface

The registry operator command surface (`migration/registry/cli.ts`) is the primary interface for human operators and automated agents to interact with the Migration Guild's central registry. While the runtime pipeline (supervisor, planner, agents) operates autonomously, the operator CLI provides the necessary levers to inspect state, resolve blockers, configure modernization strategy, and manage the migration lifecycle.

This document dives deep into how the core operator commands work, how they mutate the underlying SQLite registry, and how they interact with the broader migration protocols. We focus specifically on the behavioral commands that mutate or verify state, rather than simple listing commands.

## Architecture and Command Wiring (`cli.ts`)

The CLI is built using `commander` and acts as a thin routing layer. Its primary responsibilities are:
1. Parsing arguments and enforcing required flags.
2. Initializing the registry database connection via `getDb()`.
3. Wrapping subcommand execution in a central `run(fn)` helper that standardizes error handling (translating `RegistryError` into proper exit codes) and JSON serialization for stdout.
4. Delegating the actual business logic to dedicated modules in `migration/registry/commands/*.ts`.

```typescript
// migration/registry/cli.ts excerpt
function run(fn: () => unknown): void {
  try {
    const result = fn();
    if (result !== undefined) console.log(JSON.stringify(result, null, 2));
  } catch (err: any) {
    if (err instanceof RegistryError) {
      console.error(err.message);
      process.exit(err.code);
    }
    // ...
  }
}
```

This strict separation ensures the command logic in `commands/*.ts` can be reused directly by other parts of the system (like the local API server) without going through the shell, while the CLI remains the canonical entry point for operators.

## Verification Records (`verification.ts`)

Artifact verification tracks whether an artifact's own output was checked, by what method, and why it might have failed.

**Crucial Invariant:** The verification module is deliberately powerless. It *never* writes `artifacts.status`, *never* writes `acceptance_evidence`, and *never* unlocks an arbitration gate. Verification is solely triage input. The arbitration gate strictly requires independent verifier-produced runtime evidence (Constitution IV).

### Recording a Verification

The `setVerification` command (exposed as `record-verification` in the CLI) requires authorization—either an active claim token or a valid run operator credential.

```typescript
// migration/registry/commands/verification.ts:setVerification
export function setVerification(db: Database.Database, input: SetVerificationInput): VerificationRecord {
  requireArtifact(db, input.artifactId);
  requireAuthorization(db, input);
  validateInput(input);
  // ...
```

The state transition must be one of `"verified"`, `"unverified"`, or `"verification-failed"`. If the state is `"verified"`, the caller *must* provide `durationMs` and a non-empty `scope` (so the verification can declare exactly what it covered). If the state is not `"verified"`, a `reason` from a closed vocabulary (`VERIFICATION_REASONS`) must be provided.

The write is performed atomically:
1. Upsert into `artifact_verifications` (last-write-wins).
2. Insert an `evaluated` event into the `events` table for auditability.

### Invalidation on Rework

When an artifact fails arbitration and is sent back to `needs-rework`, its verification must be invalidated (content-bound evidence). The `resetVerification` function is called to clear the state back to `"unverified"` and `"not-attempted"`.

## Slot Verification and Concurrency Limit (`verifySlot.ts`)

To prevent the verify phase from overwhelming local resources (e.g., launching 100 headless browsers simultaneously), the registry enforces a strict concurrency limit using a lease table: `verify_slots`. This mirrors the `artifact_claims` shape.

### Acquiring a Slot

Agents attempt to acquire a slot via `acquireVerifySlot`. This uses a clever atomic insert to prevent race conditions:

```typescript
// migration/registry/commands/verifySlot.ts:tryAcquire
const result = db
  .prepare(
    `INSERT INTO verify_slots (slot_id, run_id, artifact_id, acquired_at, lease_expires_at, released_at)
     SELECT @slot_id, @run_id, @artifact_id, @acquired_at, @lease_expires_at, NULL
     WHERE (SELECT COUNT(*) FROM verify_slots
            WHERE released_at IS NULL AND lease_expires_at > @now) < @max_concurrent`,
  )
  .run({ /* ... */ });
```

If the `WHERE` clause evaluates to false (the pool is full), no row is inserted, and the agent must poll. The lease is bounded by `lease_expires_at` (derived from the verification budget). If a holder crashes, its slot eventually lapses and is reclaimed by the next acquirer (`reclaimStale`).

## Module Scope Decisions (`scope.ts`)

Operators can decide whether a module should be migrated (`keep`) or intentionally skipped (`drop`) using the `record-scope-decision` command.

```typescript
// migration/registry/commands/scope.ts:recordScopeDecision
export function recordScopeDecision(
  db: Database.Database,
  opts: RecordScopeDecisionOptions,
): RecordScopeDecisionResult {
  // ... validation ...
```

When a module is marked as `"drop"`, the registry performs a bulk state transition: any artifact in that module that is still in a pre-migration state (`"pending"`, `"planned"`, or `"analyzed"`) is immediately transitioned to `"skipped"`.

```typescript
      for (const row of rows) {
        if ((PRE_MIGRATION_STATUSES as readonly string[]).includes(row.status)) {
          setArtifactStatus(db, row.id, "skipped", {
            agent: opts.decidedBy.trim(),
            reason: `Module "${module}" dropped from scope: ${opts.reason.trim()}`,
          });
          skippedArtifactIds.push(row.id);
        } else {
          inFlightArtifactIds.push(row.id);
        }
      }
```

Artifacts that are already past the pre-migration stage (e.g., currently being migrated by an agent) are left alone. This avoids abruptly terminating in-flight work or reverting completed migrations.

## Dependency Dispositions (`dispositions.ts`)

Dependency dispositions govern how external libraries are handled during migration (e.g., keep the library, replace it with a native framework equivalent, or inline it).

The CLI provides commands to propose (`propose-disposition`) and confirm (`confirm-disposition`) these strategies.

### Propose vs Confirm

*   `propose-disposition`: Often written by automation (like the `planner-agent` or `collector`). It records a suggested strategy in the `dependency_dispositions` table.
*   `confirm-disposition`: Executed by a human operator (or authorized automation) to lock in the strategy.

### Overrides and Nulling Semantics

When confirming, an operator can override the proposed fields. The `confirmDisposition` function implements specific "nulling semantics" to handle strategy changes:

```typescript
// migration/registry/commands/dispositions.ts:confirmDisposition
      native_replacement: opts.nativeReplacement !== undefined
        ? (opts.nativeReplacement?.trim() || null)
        : (opts.disposition === undefined || opts.disposition === "replace-with-native"
          ? existing.native_replacement
          : null),
```

If the strategy is changed (e.g., from `replace-with-native` to `keep`), fields relevant only to the old strategy (like `native_replacement`) are cleared to `null` unless explicitly overridden. This ensures the confirmed row doesn't contain stale, mixed data.

### The Locked Dependency Set

Once confirmed, these dispositions form the "deterministic locked dependency set", exposed via `locked-dependency-set`. This set is consumed by downstream processes, such as the version-locked doc-RAG proposal, to ensure agents operate against a stable view of approved library versions.

## Framework Stack Mappings (`mappings.ts`)

The `record-mapping` (via `createMapping` and `confirmMapping`) commands manage how legacy frameworks map to target frameworks (e.g., Java EE to Spring Boot).

Similar to dependency dispositions, mappings must be confirmed. The planner checks `hasUnconfirmedMappings` as a guard condition; it will not proceed with planning if any mappings exist but remain unconfirmed, forcing the operator to resolve the ambiguity before code generation begins.

## The Approval Gate (`approval.ts`, spec 013)

`migration/registry/commands/approval.ts` is the human decision layer for high-risk artifacts held at `pending-approval` (see `review-arbitration.md` for the full protocol). It exposes three functions, and — notably — is the one place in the registry where the CLI (`guildctl approve`) and the Mission Control dashboard's `/api/approvals*` routes call the *exact same* functions rather than each reimplementing the query:

- **`resolveGateScope(db, artifactId)`**: A pure read of the artifact's stored `artifact_risk_assessments.high_risk` flag against the stack pack's cutoff. Called from inside `approveArtifactWithEvidence`'s transaction (`evidence.ts`) to decide whether an approving verdict promotes straight to `reviewed` or holds at `pending-approval`.
- **`listPendingApprovals(db)`**: One JOIN across `artifacts`, `artifact_risk_assessments`, and each artifact's most recent `arbitration_decisions` row, filtered to `status = 'pending-approval'`. Backs both `guildctl approve --list` and `GET /api/approvals`.
- **`recordApprovalDecision(db, opts)`**: The only writer. Runs inside one transaction: validates the artifact is actually `pending-approval`, that the human operator isn't the same identity as the gating arbiter, that evidence is still fresh (`checkEvidenceFreshness`), that a rejection carries a reason, and — when `runId`/`operatorToken` are both supplied — that they resolve to a real `run_operator_credentials` row (`validateRunOperatorCredential`, reused from `claim.ts`). It inserts one `approval_decisions` row, transitions the artifact to `reviewed`/`needs-rework`, and appends an `approval-approved`/`approval-rejected` event. On approval, it also runs `commitPromotedArtifact` (imported from `evidence.ts`) — the same git-commit-on-promotion step an automatic arbiter approval gets, so a human-approved artifact isn't missing its output commit.

```typescript
// migration/registry/commands/approval.ts:recordApprovalDecision (excerpt)
if (opts.runId && opts.operatorToken && !validateRunOperatorCredential(db, opts.runId, opts.operatorToken)) {
  throw new RegistryError(1, "Approval requires a valid run operator credential.");
}
```

`guildctl approve` (`migration/guildctl/commands/approve.ts`) is intentionally thin — no SQL, no business logic — it just parses flags and calls `listPendingApprovals`/`recordApprovalDecision`. It requires `--run-id` and `--operator-token` together or not at all (supplying exactly one throws); when neither is supplied, it mints an ad-hoc run + operator credential scoped to the single invocation, the same precedent `arbitrate.ts` established for manual approvals.

## Attempt-Scoped Retry History (`attempts.ts`, spec 013)

`migration/registry/commands/attempts.ts` gives the supervisor a durable, restart-proof record of every migrate attempt, replacing what used to be purely in-memory retry accounting (see `supervisor.md` §6 for how the loop consumes it).

- **`recordAttemptOutcome(db, opts)`**: The only writer — a single `INSERT` into the append-only `attempt_records` table. A pre-existing `(artifactId, attemptNo)` row throws `RegistryError` rather than being overwritten; this table is never upserted.
- **`getAttemptHistory(db, artifactId)`**: Pure read, rows ordered by `attempt_no` — answers "what happened on attempt N" from the registry alone (FR-010), without scraping process logs.
- **`getPersistedBudgetState(db, artifactId)`**: Pure read that reconstructs what a fresh `FailureBudget` needs on construction: `attemptsUsed` (a `COUNT(*)`) and `playbookSignatureCounts` (a per-`failure_signature` count, non-null signatures only). This is what lets a supervisor restart resume with retry accounting identical to a no-restart run — both the `FailureBudget` and `runAuto`'s own attempt counter are seeded from this same read.

```typescript
// migration/registry/commands/attempts.ts:recordAttemptOutcome (excerpt)
const existing = db
  .prepare("SELECT 1 AS x FROM attempt_records WHERE artifact_id = ? AND attempt_no = ?")
  .get(opts.artifactId, opts.attemptNo);
if (existing) {
  throw new RegistryError(1, `Attempt ${opts.attemptNo} already recorded for artifact ${opts.artifactId}`);
}
```

## Key Takeaways for Agents

*   **Atomic State Transitions:** Most commands (like `setVerification`, `confirmDisposition`, `recordScopeDecision`) perform their mutations inside explicit SQLite transactions (`db.transaction(...)()`) and often write an audit event in the same transaction.
*   **Fail-Closed Validation:** The CLI and underlying commands aggressively validate inputs (e.g., `validateId`, ensuring `durationMs` for verified states) and throw `RegistryError`s, which the CLI translates into non-zero exit codes.
*   **Idempotency and Last-Write-Wins:** Many updates (like `setVerification`) use `ON CONFLICT DO UPDATE SET` to safely handle repeated executions or retries.
*   **Append-Only Where History Matters:** `approval_decisions` and `attempt_records` are the newest examples of a pattern also seen in `events`: when the record *is* the audit trail, writers insert and never update, and a would-be duplicate write throws instead of silently overwriting history.
*   **One Function, Two Callers:** `listPendingApprovals`/`recordApprovalDecision` are called identically by the CLI and by `serve.ts`'s HTTP handlers — when adding a new operator-facing capability that needs both a CLI and a dashboard surface, put the logic in `commands/*.ts` once and keep both entry points thin, rather than letting each reimplement it.
