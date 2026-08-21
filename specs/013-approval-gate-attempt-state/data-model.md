# Phase 1 Data Model: Approval Gate and Attempt-Scoped Retry History

All additions are additive to `migration/registry_schema.sql` — no existing column is removed or narrowed, and no existing row is rewritten by applying the schema. This preserves the constitution's requirement that claim/lease/evidence semantics stay unchanged (III) and satisfies FR-007 (a crash or restart must not leave the schema in an inconsistent state).

## 1. `artifacts.status` — new value `pending-approval`

Extends the existing CHECK constraint (currently: `pending, planned, analyzed, in-progress, tests-written, migrated, reviewed, needs-rework, completed, blocked, skipped`) with one new value: `pending-approval`.

**Transitions** (extends the existing status graph; only the new edges are listed):

| From | To | Trigger |
|---|---|---|
| `migrated` | `pending-approval` | Arbiter records an approving verdict for a gate-scoped artifact (instead of the existing `migrated → reviewed` edge, which still fires unchanged for out-of-scope artifacts) |
| `pending-approval` | `reviewed` | Human approval decision recorded |
| `pending-approval` | `needs-rework` | Human rejection decision recorded (reason required) |

**Invariants**:
- `pending-approval` is reachable only from `migrated`, never directly from `analyzed`, `in-progress`, `tests-written`, or any other status (FR-001).
- An artifact in `pending-approval` holds no active row in `artifact_claims` with `state = 'active'` — the claim that produced the `migrated` status is already released/completed by the time the arbiter verdict fires, same as today's `migrated → reviewed` path (FR-007).
- `artifact_claims.attempt_no` and lease/heartbeat semantics are entirely unaffected — this is a status-graph addition, not a claims-table change.

## 2. `approval_decisions` (new table)

```
CREATE TABLE IF NOT EXISTS approval_decisions (
    decision_id    TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    artifact_id    TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    operator       TEXT NOT NULL,
    decision       TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
    reason         TEXT,                    -- required (enforced in application code) when decision = 'rejected'
    arbitration_decision_id TEXT REFERENCES arbitration_decisions(decision_id) ON DELETE SET NULL,
    superseded_by  TEXT REFERENCES approval_decisions(decision_id) ON DELETE SET NULL,
    decided_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_approval_decisions_artifact ON approval_decisions(artifact_id);
CREATE INDEX IF NOT EXISTS idx_approval_decisions_decision ON approval_decisions(decision);
```

Mirrors the shape and immutability posture of the existing `arbitration_decisions` table (same PK generation pattern, same "row per decision" append-only style). `arbitration_decision_id` links each human decision back to the specific arbiter verdict it is deciding on top of, which is what makes FR-006's freshness re-check and the audit trail (SC-005: "automated-review pass → awaiting-decision entry → human decision → completion") reconstructable by a join, not by timestamp-proximity guessing.

**Invariants**:
- Append-only: application code (`registry/commands/approval.ts`) never issues `UPDATE`/`DELETE` against this table. A re-decision (FR-003, re-entry per research.md §2) inserts a new row; the prior row for that gate-entry is optionally linked via `superseded_by` for readability but is never mutated.
- `reason` MUST be non-null when `decision = 'rejected'` — enforced in the same application-layer function that writes the row (consistent with how existing tables like `arbitration_decisions.reason` are always-required at the SQL layer without a CHECK expressing cross-column conditionality, which SQLite CHECK constraints support but the codebase's existing convention is app-layer enforcement for this exact reject-reason pattern per `rejectArtifactWithEvidence`).
- The identity in `operator` MUST NOT equal the `arbiter` value on the referenced `arbitration_decisions` row for the same artifact (research.md §1) — enforced in `recordApprovalDecision`, not at the SQL layer (no cross-table CHECK in SQLite).

## 3. `attempt_records` (new table)

```
CREATE TABLE IF NOT EXISTS attempt_records (
    artifact_id     TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    attempt_no      INTEGER NOT NULL,
    phase           TEXT NOT NULL DEFAULT 'migrate',
    outcome         TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'budget-exhausted')),
    failure_kind    TEXT CHECK (failure_kind IN (
                        'build-failure', 'test-failure', 'agent-timeout', 'review-rejection',
                        'filesystem-violation', 'claim-violation', 'stack-mismatch',
                        'pack-defect', 'provider-error', 'unknown'
                    )),                       -- NULL when outcome = 'succeeded'
    failure_signature TEXT,                   -- normalized signature, see classifyFailure/normalizeFailureSignature
    budget_delta    INTEGER NOT NULL DEFAULT 1,
    started_at      TEXT NOT NULL,
    finished_at     TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (artifact_id, attempt_no)
);

CREATE INDEX IF NOT EXISTS idx_attempt_records_artifact ON attempt_records(artifact_id);
CREATE INDEX IF NOT EXISTS idx_attempt_records_outcome ON attempt_records(outcome);
```

`(artifact_id, attempt_no)` as primary key directly joins to `artifact_claims.attempt_no`, per FR-009 and research.md §5 — `attempt_records` references the sequencing anchor rather than replacing it, matching the source problem statement's explicit constraint.

**Invariants**:
- Exactly one row per `(artifact_id, attempt_no)` — a second write for the same pair is a logic error (two claims somehow sharing an attempt number), so `recordAttemptOutcome` uses `INSERT` (not upsert) and surfaces a `RegistryError` on a primary-key collision rather than silently overwriting, preserving FR-008's "durably record" guarantee against accidental loss.
- Rows are never deleted by pipeline operation (research.md §6) — retained for post-mortem even after the artifact's own claim/lease rows may have been cleaned up elsewhere.
- `failure_kind`/`failure_signature` are populated only when `outcome != 'succeeded'`; enforced in application code (`recordAttemptOutcome`), not a SQL CHECK, to keep the constraint readable and consistent with the codebase's existing conditional-field convention (see `approval_decisions.reason` above).
- Scheduling/prioritization code (`supervisor/loop.ts`, `supervisor/queue.ts`) MUST read only the final `outcome` column when making claim-eligibility decisions — never `failure_signature` or any other in-row detail — per FR-011. This is a code-review-enforced invariant (Phase 1 contract test asserts no such read exists), not a schema-level one.

## Key Entities (restated from spec.md, mapped to schema)

| Spec entity | Schema representation |
|---|---|
| Approval Decision | `approval_decisions` row |
| Gate Scope | Not a stored entity — computed at decision time from the existing `resolveRiskSpec`/`highRiskScoreCutoff` (`migration/guildctl/risk.ts`) applied to the existing `artifact_risk_assessments.high_risk` column; no new table, per the spec's Assumption that v1 gate scope is risk-cutoff-only |
| Attempt Record | `attempt_records` row |

## Relationship diagram (textual)

```
artifacts (status: migrated → pending-approval → reviewed|needs-rework)
    │                              │
    │ 1:N                         │ 1:N
    ▼                              ▼
arbitration_decisions ◄──────── approval_decisions
    (existing)          FK        (new; arbitration_decision_id)

artifacts
    │ 1:N (via artifact_id, attempt_no)
    ▼
artifact_claims (existing, attempt_no source of truth)
    │ joins on (artifact_id, attempt_no)
    ▼
attempt_records (new)
```
