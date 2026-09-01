# Quickstart Validation: Rejection Reason Envelope

Validates that a human rejection reason flows from the approval gate into what remediation reads and carries forward, end to end, using the existing `guildctl`/registry CLI.

## Prerequisites

- A built registry CLI (`node migration/registry/dist/cli.js ...`), same as spec-013's validation flow.
- An artifact that has reached `pending-approval` (see `specs/013-approval-gate-attempt-state/quickstart.md` for how to get one there via inventory → migrate → arbitrate).

## Scenario 1 — Rejection reason becomes retrievable context (spec US1, FR-001)

```bash
# Reject with a reason (as the existing approval gate already supports):
node migration/registry/dist/cli.js approve \
  --id "<artifact-id>" \
  --decision rejected \
  --reason "Retry hit a null-check regression in the mapper; guard the null branch before resubmitting." \
  --operator "operator-1"

# Confirm the reason is now readable as context, distinct from any other agent's context:
node migration/registry/dist/cli.js get-context --id "<artifact-id>" --agent rejection-envelope
```

**Expected**: the `get-context` output contains the rejection reason text verbatim. If the artifact already had context written by another agent (e.g. `context-agent`), a follow-up `get-context --agent context-agent` for the same artifact still returns that unrelated content unchanged (US2, FR-003).

## Scenario 2 — Remediation carries the reason forward (spec US1, FR-006)

```bash
# The artifact is now needs-rework (rejection's status transition). Run remediation
# per its existing procedure (package/agents/remediation-agent.agent.md), which will:
#   1. see the needs-rework artifact,
#   2. read: node migration/registry/dist/cli.js get-context --id "<artifact-id>" --agent rejection-envelope
#   3. requeue it, folding the reason into its reason/summary text:
node migration/registry/dist/cli.js set-artifact-status \
  --id "<artifact-id>" \
  --status planned \
  --agent remediation-agent \
  --reason "Requeued after remediation review — prior rejection: Retry hit a null-check regression in the mapper; guard the null branch before resubmitting."

node migration/registry/dist/cli.js get-events --id "<artifact-id>" --limit 5
```

**Expected**: the most recent `remediated` event's summary/reason includes the prior rejection's reason text, not just a generic "requeued" message.

## Scenario 3 — No rejection reason, no behavior change (spec US1, FR-007)

```bash
# On an artifact that reached needs-rework without ever going through a human rejection
# (e.g. sent there by some other path), confirm no envelope exists:
node migration/registry/dist/cli.js get-context --id "<other-artifact-id>" --agent rejection-envelope
```

**Expected**: the existing `form: "none"` fallback response, and remediation proceeds with its unmodified reason/summary text — no error, no fabricated reason.

## Scenario 4 — Second rejection supersedes the first (spec US2, FR-004)

```bash
# Reject the same artifact a second time (new cycle) with a different reason, then re-read:
node migration/registry/dist/cli.js approve --id "<artifact-id>" --decision rejected --reason "Second issue: missing null check on the response DTO." --operator "operator-1"
node migration/registry/dist/cli.js get-context --id "<artifact-id>" --agent rejection-envelope
```

**Expected**: only the second reason is returned; the first is no longer surfaced here (though it remains permanently in `approval_decisions` history via the existing `list-approvals`/decision-history commands, unchanged by this feature).
