# Quickstart: Validating the Adversary Agent Gate

This guide describes how to prove the feature works end-to-end once implemented (blocked on #216 landing first — see plan.md and spec.md Assumptions). It assumes familiarity with #216's own quickstart for the rejection-envelope mechanism this feature extends.

## Prerequisites

- A migration-guild workspace with the registry initialized and an artifact that has cleared `review-agent` (status on a path toward `reviewed`).
- The stack pack's configured verify command runnable in the workspace (for the clean-probe and violation-found scenarios); optionally, an environment where it is deliberately unusable (for the inconclusive-probe scenario, FR-008a).
- #216's `writeRejectionEnvelope`/`getRejectionEnvelope` helpers and reserved-key convention already present in `migration/registry/commands/context.ts`.

## Scenario 1 — Clean probe, below-cutoff artifact (US1, Scenario 1; FR-003)

1. Prepare an artifact with no known spec-violating edge case, risk-assessed below the stack's high-risk cutoff.
2. Run the pipeline through review and arbitration as today.
3. **Expected**: the artifact reaches `reviewed` exactly as before this feature; no `adversary-envelope` context row is written; no new event is appended for this artifact beyond what already existed pre-feature.

## Scenario 2 — Violation found, below-cutoff artifact (US1, Scenario 2; FR-004, FR-005)

1. Prepare an artifact with a deliberately introduced spec-violating edge case not covered by its existing test suite (e.g. an off-by-one on a migrated boundary), risk-assessed below cutoff.
2. Run the pipeline through review (passes) and into the adversary-agent checkpoint.
3. **Expected**: the artifact transitions to `needs-rework`, not `reviewed`. `node migration/registry/dist/cli.js get-context --id "<id>" --agent adversary-envelope` returns the constructed violating case and the spec intent it violates. The artifact's event history shows an adversary-originated routing event distinguishable from a review or arbiter rejection.

## Scenario 3 — Finding reaches remediation (US2, Scenario 1; FR-011)

1. Starting from the `needs-rework` artifact produced in Scenario 2, invoke the remediation flow (as `remediation-agent.agent.md` already does automatically on `needs-rework`).
2. **Expected**: the requeue reason/summary text passed to `set-artifact-status --status planned` and `append-event --type remediated` includes the adversary finding text, without remediation querying any adversary-agent-specific table directly (only the existing `get-context` surface).

## Scenario 4 — Both a human rejection and an adversary finding coexist (US2, Scenario 2; FR-009, FR-012)

1. On a separate artifact (or a separate cycle of the same one), first produce a human operator rejection through the approval gate with a reason (per #216's own quickstart), then separately produce an adversary-agent finding on a later cycle.
2. Read back both: `get-context --agent rejection-envelope` and `get-context --agent adversary-envelope`.
3. **Expected**: both return their own distinct content, neither overwritten by the other. Running remediation folds both into the requeue text, each distinguishably labeled by origin.

## Scenario 5 — No finding, remediation unaffected (US2, Scenario 3; FR-013)

1. Take a `needs-rework` artifact that reached that status through review or arbitration alone (no adversary-agent involvement, no human rejection).
2. Run remediation.
3. **Expected**: behavior identical to before this feature — no error, no fabricated reason, requeue text unchanged from today's baseline.

## Scenario 6 — Envelope write failure does not block routing (US3, Scenario 1; FR-015)

1. Simulate a filesystem failure at the moment the adversary-envelope write would occur (e.g. an unwritable `migration/artifacts/<slug>/context/` directory) for an artifact the adversary-agent has flagged.
2. **Expected**: the artifact still transitions to `needs-rework` and the routing event is still appended, even though `get-context --agent adversary-envelope` returns no result (or a stale prior result) afterward.

## Scenario 7 — Inconclusive probe fails closed (Edge Cases; FR-008a)

1. Prepare an artifact whose stack has no runnable verify command in the current environment, below cutoff.
2. Run the adversary-agent checkpoint.
3. **Expected**: the artifact transitions to `needs-rework` (not `reviewed`), and `get-context --agent adversary-envelope` returns a reason describing the probe as inconclusive rather than a constructed violating case.

## Scenario 8 — Gate-bound clean pass is visible to the human operator (Edge Cases; FR-008b)

1. Prepare an artifact risk-assessed above the high-risk cutoff, with no spec-violating edge case.
2. Run the pipeline through review, arbitration, and the adversary-agent checkpoint.
3. **Expected**: the artifact still holds at `pending-approval` as today (unchanged gate behavior). Its event history additionally shows an `adversary-probe-passed`-style event; this event does not appear as `acceptance_evidence` and does not satisfy any arbitration precondition.
