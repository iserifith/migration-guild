# Quickstart: Validating the Approval Gate and Attempt-Scoped Retry History

Validation scenarios below map directly to the spec's User Stories and Success Criteria. Run against a disposable fixture registry, not the repo root — per the constitution's Repository Source-of-Truth Boundaries, migration phases MUST NOT run against this repository; use a fresh workspace with `package/mock/` fixtures, e.g. under `migration-guild-test-workspaces/<dated-subfolder>/` per existing test-workspace convention.

## Prerequisites

- `npm test` passes on `main`/base branch before starting (baseline green).
- A workspace initialized from `package/mock/legacy-customer-utils` (or an equivalent fixture containing at least one artifact that scores above the stack pack's `high_risk_score_cutoff`).
- Schema applied with the new `pending-approval` status value and `approval_decisions`/`attempt_records` tables (`applySchema` picks these up automatically once `registry_schema.sql` is updated — no manual migration step for a fresh registry).

## Scenario 1 — US1: high-risk artifact stops before completion (SC-001)

```bash
guildctl run inventory
guildctl run plan
guildctl run migrate --wave 1
guildctl run review --wave 1
guildctl status
```

**Expected**: the low-risk artifact(s) in the fixture reach `reviewed`/`completed` unattended. The above-cutoff artifact shows status `pending-approval` in `guildctl status`, not `reviewed`. Querying `arbitration_decisions` for that artifact shows an `approved` verdict recorded — the gate, not the arbiter, is what's holding it.

## Scenario 2 — US2: CLI approve/reject path (SC-002)

```bash
guildctl approve --list
# → shows the held artifact with risk reason codes and arbiter verdict summary

guildctl approve <artifact-id>
guildctl status
# → artifact now reviewed/completed; approval_decisions has one row for it
```

Reject path, using a second held fixture artifact (or re-running Scenario 1 against a second above-cutoff artifact):

```bash
guildctl approve <artifact-id> --reject --reason "needs manual crypto review"
guildctl status
# → artifact now needs-rework; approval_decisions row has decision=rejected, reason populated
```

**Expected timing**: both commands complete in well under a minute of operator interaction (SC-002 is about interaction time, not command runtime).

## Scenario 3 — US1 edge case: unattended run never auto-approves (FR-012)

```bash
guildctl auto-run --unattended
```

**Expected**: the run completes all claimable work, halts nothing systemically, and the run summary reports the above-cutoff artifact under a distinct "held for approval" count — never silently approved, never reported as `blocked`/failed.

## Scenario 4 — US3: attempt history survives a restart (SC-003, SC-004)

Using a fixture artifact rigged (via the existing flaky-fixture harness pattern already used by `migration/test`) to fail twice and succeed on the third migrate attempt:

```bash
guildctl run migrate --artifact <flaky-artifact-id>
# (mid-run) kill -9 the guildctl process after attempt 1 completes but before attempt 2 starts
guildctl run migrate --artifact <flaky-artifact-id>   # resume
```

**Expected**:
- Querying attempt history (`getAttemptHistory` via a debug/status command, or directly via the registry for validation purposes) shows 3 rows for the artifact, attempt_no 1–3, each with its own outcome/failure_kind.
- The retry budget consumed after the restart equals what a non-interrupted run of the same fixture would show — no attempt double-counted, none lost (SC-004).
- No log-scraping was required to answer "what happened on attempt 2" — the `attempt_records` row alone answers it (SC-003).

## Scenario 5 — Audit trail completeness (SC-005)

For any artifact taken through Scenario 1 + Scenario 2's approve path, confirm via registry query that the full chain is gap-free:

```
arbitration_decisions (approved) → artifacts.status pending-approval (implicit, via status history/events)
  → approval_decisions (approved) → artifacts.status reviewed/completed
```

Every link should be traceable by `artifact_id` join with no missing intermediate step.

## Cleanup

Delete the disposable test-workspace subfolder used for validation; nothing in this feature touches the repository root or any shared fixture beyond the ephemeral workspace's own registry file.
