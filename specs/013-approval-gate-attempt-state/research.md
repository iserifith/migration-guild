# Phase 0 Research: Approval Gate and Attempt-Scoped Retry History

No `NEEDS CLARIFICATION` markers were left in the Technical Context — the project's language, storage, and testing conventions are fully determined by the existing `migration/` codebase. The research below resolves design decisions the spec deliberately left to planning (per its Assumptions section) plus one gap surfaced during the Constitution Check.

## 1. Who may record a human approval decision

**Decision**: Any actor presenting a valid run operator credential or CLI-local operator identity may record an approval decision, **except** the arbiter identity that produced the approving verdict being gated — that specific identity MUST be rejected, mirroring the existing `assertApprovalEvidenceIsIndependent` / arbiter-independence check in `evidence.ts`.

**Rationale**: The spec's Assumptions explicitly put *role-based* authorization out of scope ("any operator with pipeline access may record a decision"), but Constitution Principle IV ("the party that produces work MUST NOT be the party that certifies it") already forbids the arbiter from being both verdict-author and human-approver for the same artifact — an automated arbiter identity approving its own gated verdict would be exactly the self-certification loop the constitution forbids. This is a narrow floor on top of the spec's assumption, not a contradiction of it: broad operator identity is fine, but the specific producing arbiter is not "any operator" for this purpose.

**Alternatives considered**:
- *No independence check at all* — rejected: would let an automated arbiter's own identity "approve" the human gate programmatically, defeating the feature's purpose.
- *Full role-based approval permissions* — rejected: spec explicitly defers this; adding it now expands scope without a stated need.

## 2. Re-entry behavior on rework

**Decision**: An artifact that is rejected at the approval gate, reworked, and re-passes automated review re-enters `pending-approval` — every approving-verdict pass by an in-scope artifact requires its own fresh decision. Confirmed via the spec's Edge Cases section (already resolved there as an assumption); research here only confirms it maps cleanly onto existing state machinery.

**Rationale**: `migration/registry_schema.sql`'s existing status CHECK constraint already permits `needs-rework → migrated → ...` cycles (the repair loop is not currently bounded to one pass), so re-entry is a natural consequence of the state machine rather than new special-casing. Evidence freshness (FR-006) independently guards against approving stale output on any pass.

**Alternatives considered**:
- *First rejection is final* — rejected: contradicts the repair loop's whole purpose and the spec's explicit edge-case resolution.

## 3. Evidence freshness re-check at human-decision time

**Decision**: Reuse `checkEvidenceFreshness` (already called by `approveArtifactWithEvidence` in `evidence.ts`) at the moment a human decision is recorded, not only at the moment the artifact entered `pending-approval`. If evidence went stale between entering the gate and the human decision (e.g., a concurrent process touched the artifact — should not happen under normal claim discipline, but is possible under manual registry intervention), the approval MUST be rejected with the same `RegistryError` shape operators already see elsewhere.

**Rationale**: FR-006 requires this explicitly. Reusing the existing function (rather than writing a second freshness check) keeps a single source of truth for "is this evidence still good," consistent with Constitution Principle I ("evidence MUST be content-bound... stale evidence MUST NOT satisfy a gate").

**Alternatives considered**:
- *Only check freshness once, at gate-entry* — rejected: spec's FR-006 and edge case explicitly require the check at approval time, not just entry time.

## 4. Attempt outcome vocabulary for `attempt_records`

**Decision**: Reuse the existing `FailureKind` vocabulary from `migration/guildctl/supervisor/failures.ts` (`build-failure`, `test-failure`, `agent-timeout`, `review-rejection`, `filesystem-violation`, `claim-violation`, `stack-mismatch`, `pack-defect`, `provider-error`, `unknown`) verbatim as the failure-classification column's domain, plus a top-level `outcome` column (`succeeded` | `failed` | `budget-exhausted`) distinct from the failure-kind detail.

**Rationale**: The spec's edge case "what happens when a retry's failure reason doesn't match any known category" is already answered by the existing `unknown` fallback in `classifyFailure` — no new taxonomy is needed, just a durable home for the existing one. Splitting `outcome` from `failure_kind` keeps a successful attempt's row shape identical to a failed one's (outcome = succeeded, failure_kind = null) rather than overloading one enum.

**Alternatives considered**:
- *Free-text failure reason only, no fixed vocabulary* — rejected: defeats FR-010's "queryable... attempt-by-attempt outcome and failure classification" success criterion; a fixed vocabulary is what makes it queryable rather than just readable.
- *New taxonomy independent of `classifyFailure`* — rejected: would fork the classification logic that already exists and is exercised by tests; reuse is strictly simpler and satisfies "why this priority" framing of US3 (closing the persistence gap, not redesigning classification).

## 5. Migration path for `FailureBudget` from in-memory `Map` to persisted table

**Decision**: `FailureBudget` continues to exist as the in-process object supervisor code calls against during a single run (no call-site churn required elsewhere in `loop.ts`), but its `attempts`/`playbooks` maps are backed by reads from and writes to `attempt_records` rather than being purely in-memory — i.e., budget consumption is persisted synchronously as each attempt concludes, and on construction (including after a restart) the budget is seeded by querying existing `attempt_records` rows for the artifacts in play rather than starting from empty maps.

**Rationale**: This satisfies FR-009 ("retry budget accounting... reconstructable from durable records alone... resumes with accounting identical to what it would have been without the restart") while minimizing blast radius: `loop.ts`'s existing call sites (`budget.recordAttempt(...)`, `budget.remaining(...)`, etc. — exact method names to confirm during implementation) keep their signatures; only the storage backing changes. This is squarely a persistence fix, not a redesign of failure-budget policy, matching the spec's stated intent.

**Alternatives considered**:
- *Replace `FailureBudget` entirely with direct registry queries at every call site* — rejected for this increment: larger diff, more call-site risk, no functional difference from the read-through/write-through approach; can be revisited later if `FailureBudget` as a class stops earning its keep.
- *Snapshot budget state to a single JSON blob on shutdown, restore on startup* — rejected: doesn't satisfy "durably record... for each retry attempt" (FR-008) as a queryable per-attempt record; also reintroduces a "did we shut down cleanly" hazard the constitution's Fail-Closed principle warns against (a crash, not just a clean shutdown, must not lose accounting).

## 6. Scratch/attempt data retention

**Decision**: `attempt_records` rows are never deleted by normal pipeline operation (no cascade-delete on lease expiry, no cleanup job in this feature). They are retained indefinitely, same lifecycle as `arbitration_decisions` and `events`.

**Rationale**: Directly required by the spec ("Attempt Record... retained even after the artifact's final status is known") for post-mortem value; matches existing append-only tables' retention posture (no existing table in `registry_schema.sql` is pruned by the pipeline itself).

**Alternatives considered**:
- *Time-boxed retention/pruning* — rejected: out of scope, no spec requirement, and would need its own success criteria and operator controls this feature doesn't define.
