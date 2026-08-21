# Approval Gates & Attempt State

*Module deep-dive — spec `specs/013-approval-gate-attempt-state/spec.md`*

This document explains the human-in-the-loop approval gate for high-risk
artifacts and how durable attempt counters/state interact with it. It covers:

- The registry-side gate: `migration/registry/commands/approval.ts`
- The CLI decision path: `migration/guildctl/commands/approve.ts`
- Attempt-scoped retry history: `migration/registry/commands/attempts.ts`
- The supervisor's handling of held artifacts and attempt recording:
  `migration/guildctl/supervisor/loop.ts`, `.../failures.ts`, `.../queue.ts`
- The dashboard surface (thin dispatcher): `migration/registry/commands/serve.ts`,
  `migration/ui/src/components/ApprovalsPanel.tsx`

---

## 1. Why this exists

Spec 013 ("#173 — Human oversight and attempt-scoped state for the
migrate/review loop") closes two gaps:

1. **Automated judgment was sufficient to complete the riskiest artifacts.**
   Before 013, an approving arbitration verdict promoted an artifact straight
   to `reviewed` no matter its risk score. Now an above-cutoff high-risk
   artifact stops at a new status **`pending-approval`** and only a human
   decision releases it (FR-001..FR-003).
2. **Retry history lived only in process memory.** A restart lost or
   double-counted retry budget. Now every concluded attempt is persisted in
   the append-only `attempt_records` table, and the supervisor's
   `FailureBudget` seeds from it so restart-resumption is exact (FR-008,
   FR-009).

The two mechanisms are deliberately decoupled: the approval gate is a *status*
in the artifact lifecycle; attempt history is a *ledger*. A held artifact does
not consume attempts (FR-005), and scheduling decisions elsewhere read only an
attempt's final recorded outcome.

---

## 2. State model

The artifact lifecycle relevant to this module (`migration/registry/types.ts:40`
adds `"pending-approval"` to the status union):

```
                 arbitrate / runAuto (approveArtifactWithEvidence)
migrated ──────────────────────────────────────► reviewed ──► (git commit, done)
   ▲   │            │
   │   │ low-risk   │ HIGH-risk (gate in scope)
   │   │ (no hold)  ▼
   │   │        pending-approval          ← HELD; never claimable
   │   │            │
   │   │   operator approve      operator reject (+reason required)
   │   └────────────┼──────────────────┐
   │                ▼                  ▼
   └──── needs-rework ◄──────────── (rejection)        reviewed
        (normal remediation loop re-enters migrate/review;
         every subsequent approving verdict on a still-high-risk
         artifact re-enters pending-approval — spec Edge Case:
         "every pass of automated review by an in-scope artifact
         requires a fresh decision")
```

Event types added by 013 (`migration/registry/types.ts:69-71`):
`approval-gated` (held), `approval-approved`, `approval-rejected`.

### Invariants

- **`pending-approval` is never claimable.** It is excluded from every claim
  allow-list (`claimNextTask` skips it; `claimArtifactById` refuses it with a
  clean `RegistryError`). Locked by `migration/test/supervisor-held-approval.test.ts` (T009).
- **Leaving `pending-approval` requires an explicit human decision.** The only
  writer of the exit transitions is `recordApprovalDecision`.
- **Decision records are append-only.** Each decision INSERTs one new
  `approval_decisions` row; nothing edits prior rows.
- **Attempt records are append-only with a uniqueness invariant.**
  `attempt_records` has `UNIQUE (artifact_id, attempt_no)`
  (`migration/registry_schema.sql:372`); `recordAttemptOutcome` throws rather
  than overwrites.
- **`failure_kind IS NULL` iff `outcome = 'succeeded'`** — enforced both in
  `recordAttemptOutcome` (`attempts.ts:68-74`) and by a table CHECK
  (`registry_schema.sql:373`).

---

## 3. Entering the gate: `resolveGateScope` and the arbiter verdict

### `resolveGateScope` — `migration/registry/commands/approval.ts:147`

The scope check is a **pure read** of the stored risk flag:

```ts
const assessment = getRiskAssessment(db, artifactId);
if (!assessment) {
  return { inScope: false, reason: "no risk assessment recorded; below cutoff" };
}
if (Number(assessment.high_risk) === 1) {
  return { inScope: true, reason: `risk_score ${assessment.risk_score} exceeds cutoff ${cutoff}` };
}
```

Design intent (per the doc comment): the `high_risk` flag was already computed
against the stack pack's cutoff at inventory time by
`guildctl/risk.ts scoreArtifact`; the gate only re-derives the cutoff to build
the human-readable reason string. This makes scope resolution side-effect-free
and replayable — asserted by
`migration/test/approval-gate.test.ts` ("pure read — repeated calls return the
same result with no side effects").

A consequence: because scope follows the **stored** risk row at decision time
(not a snapshot frozen earlier), clearing `high_risk` releases a future gate —
tested as "gate scope follows the stored risk row" in `approval-gate.test.ts`.
Per spec Edge Cases, artifacts already held are unaffected by later cutoff
changes; they simply stay held until decided.

### Where the gate fires: `approveArtifactWithEvidence` — `migration/registry/commands/evidence.ts:489`

The gate check lives **inside the same transaction** as the arbiter verdict so
the status write and the `approval-gated` event are atomic with it:

```ts
const gateScope = resolveGateScope(db, opts.artifactId);
if (gateScope.inScope) {
  setArtifactStatus(db, opts.artifactId, "pending-approval");
  appendEvent(db, {
    id: opts.artifactId, type: "approval-gated", agent: opts.arbiter,
    summary: `Held for human approval: ${gateScope.reason}`, ...
  });
  return { decision, gated: true as const };
}
setArtifactStatus(db, opts.artifactId, "reviewed");
return { decision, gated: false as const };
```

Note what happens on the gated path: the arbiter verdict **is still recorded**
(`recordArbitrationDecision` + `arbitration-approved` event happen first) but
the promotion to `reviewed` — and crucially the git commit via
`commitPromotedArtifact` — is **deferred** until the human approves. Only the
non-gated branch commits immediately. That deferral is the whole point: no
high-risk output reaches a committed state on automated judgment alone.

Both surfaces that run arbitration report the outcome honestly instead of
assuming success:

- `guildctl arbitrate` adds `artifactStatus` and `heldForApproval: true` to its
  JSON output when the artifact ended up held
  (`migration/guildctl/commands/arbitrate.ts:89-110`).
- The supervisor's `reportApprovalOutcome`
  (`migration/guildctl/supervisor/loop.ts:443`) re-reads the actual status and
  returns `{ status: "held", heldForApproval: true }` rather than `"complete"`
  — because `pending-approval` means the artifact did **not** finish.

---

## 4. Being held: what the system looks like while waiting

While an artifact sits at `pending-approval`:

- **It holds no lock or claim** (FR-007). Nothing else in the pipeline can
  wedge behind it; the supervisor simply cannot claim the status, and other
  artifacts proceed normally. A crash mid-hold changes nothing — the status is
  durable in SQLite and the artifact stays held.
- **The supervisor treats held as its own outcome**, distinct from blocked /
  failed / complete. `runAuto` short-circuits *before* `requireReview` /
  `startRun` / claim if the artifact is already pending-approval
  (`loop.ts:471-490`):

  ```ts
  if (initialStatusRow?.status === "pending-approval") {
    return { runId: null, attempts: 0, status: "held", heldForApproval: true, reason: "pending-approval" };
  }
  ```

  Note `attempts: 0` — being held consumes **no retry attempt** (FR-005).
- **Queue reporting counts held separately.** `getClaimabilityStats`
  computes `SUM(CASE WHEN a.status = 'pending-approval' ...) AS held_for_approval`
  (`supervisor/queue.ts:164`) and `runAutoQueue`'s completion classification
  includes `heldForApproval > 0` in its `"partial"` condition without ever
  conflating held with blocked (`queue.ts:232`).
- **The operator can see it.** Three renderers over one query:
  - CLI: `guildctl approve --list`
  - HTTP: `GET /api/approvals` → `queryPendingApprovalsForUI`
    (`queries.ts:1006`), which deliberately delegates to the same
    `listPendingApprovals` function — parity locked by
    `migration/test/approval-dashboard-parity.test.ts`
  - UI: `ApprovalsPanel.tsx` badge fed by that endpoint

---

## 5. Deciding: the operator path

### Read side: `listPendingApprovals` — `approval.ts:180`

One JOIN across `artifacts` × `artifact_risk_assessments` × latest
`arbitration_decisions` row (latest by `decided_at DESC, rowid DESC`, mirroring
`getLatestArbitrationDecision`'s ordering). Each `PendingApproval` carries:

- `riskReasonCodes` — parsed defensively; a malformed stored JSON degrades to
  `[]` rather than crashing the list view (`toPendingApproval`, `approval.ts:84-95`)
- `arbitrationVerdictSummary` — the latest arbiter's `reason`, so the operator
  knows what the machine decided and why
- `enteredPendingApprovalAt` — `artifacts.updated_at`, bumped by the
  `pending-approval` transition itself (no separate timestamp column needed)

### Write side: `recordApprovalDecision` — `approval.ts:215`

This is the single choke point for *every* surface (CLI, HTTP dashboard). All
preconditions throw `RegistryError`; the effect lands in one transaction:

```ts
if (status !== "pending-approval") {
  throw new RegistryError(1, "Artifact is not awaiting approval.");       // double-decision guard
}
if (latestArbitration && latestArbitration.arbiter === opts.operator) {
  throw new RegistryError(1, "Approving arbiter cannot record the human decision.");
}
const freshness = checkEvidenceFreshness(db, opts.artifactId);
if (!freshness.ok) { throw new RegistryError(1, freshness.reason); }     // FR-006 stale-output guard
if (opts.decision === "rejected" && (!opts.reason || !opts.reason.trim())) {
  throw new RegistryError(1, "A rejection reason is required.");
}
```

then: one `approval_decisions` INSERT → `setArtifactStatus` to
`reviewed` (approve) or `needs-rework` (reject) → one `approval-approved` /
`approval-rejected` event. After the transaction commits, an approval also
runs `commitPromotedArtifact` — mirroring `evidence.ts`'s own
commit-on-promotion, so a human-approved artifact's outputs land in git too.

Each precondition maps to a spec edge case:

| Guard | Spec edge case |
|---|---|
| status must be exactly `pending-approval` | "operator tries to approve an artifact that is no longer awaiting decision… rejected with a clear error, not silently accepted" — this is the **double-approval guard**; a second decision on the same hold fails loudly |
| arbiter ≠ operator | separation-of-duties (constitution; FR-008) — the agent whose verdict triggered the hold can't be its own approver |
| `checkEvidenceFreshness` | "cannot approve against outdated output… must be detected and blocked" — freshness verifies static/runtime evidence digests still match their output files (`evidence.ts:674`) |
| reject ⇒ reason required | rejection must carry a reason for the rework loop |

The `approval_decisions` table enforces the reject-needs-reason rule even at
the schema level: `CHECK (decision <> 'rejected' OR reason IS NOT NULL)`
(`registry_schema.sql:330`). Operator tokens are stored only as SHA-256 hashes
(`operator_token_hash`, `approval.ts:251-253`) — the raw token never persists.

### CLI wrapper: `runApprove` — `guildctl/commands/approve.ts:30`

The file intentionally contains **no business logic and no SQL** (FR-004):
`--list` delegates to `listPendingApprovals`, decisions delegate to
`recordApprovalDecision`. Two details worth knowing:

- **Ad-hoc run minting.** If the operator supplies neither `--run-id` nor
  `--operator-token`, the command mints a fresh run + credential scoped to
  this invocation (`phase: "approval"`), so `recordApprovalDecision` always has
  run-binding context. Supplying only one of the pair is refused
  (`"--run-id and --operator-token must be supplied together, or neither."`).
  The decision is always recorded under the stable operator id
  `OPERATOR_ID = "guildctl-approve"` — the credential binds the decision to a
  run, never to an operator identity.
- **Pre-validation before delegation.** The missing-`--reason` case is thrown
  here with the registry's own message so the `cli.ts` boundary prints one
  clean stderr line and exits non-zero, rather than a stack trace.

The dashboard path (`serve.ts:149-180`, `POST /api/approvals/<id>/decision`)
is likewise a thin dispatcher around `recordApprovalDecision`, translating
`RegistryError` into clean 4xx bodies — identical record, identical downstream
effect (US4 acceptance scenario 2).

---

## 6. After the decision

- **Approved:** status → `reviewed`, `approval-approved` event, git commit via
  `commitPromotedArtifact`. The artifact proceeds down whatever consumes
  `reviewed`. If it later gets reworked and re-passes review while still
  high-risk, it re-enters `pending-approval` for a *fresh* human decision
  (spec assumption; the old decision row remains as history).
- **Rejected:** status → `needs-rework` with the reason persisted in the
  decision row; the normal remediation loop picks it up from there. No
  special-casing — rejection just re-enters the standard path.

---

## 7. Attempt state: the ledger beside the gate

### Writers: `recordAttemptOutcome` — `registry/commands/attempts.ts:66`

Exactly one INSERT per **concluded** attempt, never an upsert. A pre-existing
`(artifactId, attemptNo)` row throws:

```ts
if (existing) {
  throw new RegistryError(1, `Attempt ${opts.attemptNo} already recorded for artifact ${opts.artifactId}`);
}
```

Validation enforces the NULL-iff-succeeded rule in both directions
(`attempts.ts:68-74`): `failureKind` present on success, or absent on failure,
both throw. Outcomes are `succeeded | failed | budget-exhausted`;
`failure_kind` comes from the closed set classified by
`guildctl/supervisor/failures.ts classifyFailure` (build-failure,
test-failure, agent-timeout, …, unknown) — a mismatch with known categories
still lands as `unknown`, per the spec edge case "categorized as unclassified
rather than dropped".

### Readers

- `getAttemptHistory` (`attempts.ts:103`): rows ordered by `attempt_no ASC` —
  the post-mortem query (FR-010).
- `getPersistedBudgetState` (`attempts.ts:115`): `{ attemptsUsed: COUNT(*),
  playbookSignatureCounts: per-signature COUNTs }` — the seed for restart
  resumption.

### How the supervisor uses it — `guildctl/supervisor/loop.ts`

At `runAuto` startup the budget and counter are both seeded from the ledger:

```ts
// loop.ts:508
const budget = new FailureBudget(maxAttempts, 2, {
  artifactId: opts.artifactId,
  ...getPersistedBudgetState(db, opts.artifactId),
});
// loop.ts:533
let attempts = getPersistedBudgetState(db, opts.artifactId).attemptsUsed;
```

so a restart mid-artifact resumes with accounting identical to a no-restart
run — no attempts silently forgotten, none double-counted (FR-009). Inside the
dispatch loop the counter increments **before each dispatch**
(`loop.ts:687`: `attempts += 1; budget.recordAttempt(...)`), and every terminal
path (worker error, warden violation, verify failure, review rejection, budget
exhaustion, success) calls `recordAttemptOutcome` with `attemptNo: attempts`.
Because the counter is seeded from `COUNT(*)`, a resumed run's next attempt
number can never collide with the `UNIQUE(artifact_id, attempt_no)` constraint.

### Interaction with the gate

They barely touch — by design. `runAuto` returns early with `attempts: 0` for
an already-held artifact before any claim/dispatch, so **waiting on a human
never burns retry budget**. Conversely, attempt recording knows nothing about
approvals; it only observes concluded dispatches. The one place they meet
indirectly: after a rejection sends an artifact to `needs-rework`, its next
remediation pass continues numbering attempts from the persisted count, so the
history reads as one continuous story across rejections.

---

## 8. Edge cases recap

- **Double approval:** second call hits `status !== "pending-approval"` and
  throws `"Artifact is not awaiting approval."`
  (`approval-gate.test.ts:205`, `serve-approvals.test.ts:175`, `approve-command.test.ts:322` all lock this).
- **Expired/stale evidence:** `checkEvidenceFreshness` blocks approval when
  evidence digests no longer match output files or runs diverge — tested via
  the "repair event after latest runtime evidence" scenario
  (`approval-gate.test.ts:296`).
- **Concurrent decisions:** SQLite transaction + status precondition inside
  `db.transaction()` means only one decision can win; the loser sees the
  already-changed status and throws.
- **Crash while held:** status is durable; no claim exists to leak; `runAuto`
  short-circuits cleanly on rediscovery.
- **Restart mid-attempt:** budget re-seeded from `attempt_records`; duplicate
  attempt numbers impossible.
- **Cutoff change mid-hold:** held artifacts unaffected; only future
  inventory/risk scoring uses the new cutoff (scope is evaluated fresh at each
  arbitration pass against the then-current stored flag).

---

## 9. Extension points

- **New decision surfaces:** implement against `listPendingApprovals` +
  `recordApprovalDecision` only. Both existing surfaces (CLI, dashboard) are
  pure dispatchers, and the dashboard-parity test enforces that pattern.
- **Different gating criteria (beyond risk cutoff):** `resolveGateScope` is
  the single predicate; widen `GateScopeResult.reason` consumers accordingly.
  Because scope is a pure read of stored data, adding e.g. dependency-drift
  scoping means extending the assessment lookup, not the callers.
- **Post-decision hooks:** the commit-on-promotion block after the
  transaction in `recordApprovalDecision` (`approval.ts:304-310`) is where
  additional release side effects would go, mirroring `evidence.ts`'s shape.
- **New attempt outcomes/phases:** `phase` defaults to `"migrate"`
  (`attempts.ts:94`) but is caller-supplied; `FailureBudget` seeding already
  generalizes across phases via signature counts.

---

## 10. Test coverage map

| Suite | What it confirms |
|---|---|
| `migration/test/approval-gate.test.ts` | Gate scope purity & correctness; full `recordApprovalDecision` guard set (not-pending, arbiter-self-approval, reject-without-reason, stale evidence); end-to-end high-risk→`pending-approval` vs low-risk→`reviewed`; scope follows stored risk row |
| `migration/test/arbitrate-approve-gate.test.ts` (T008) | `guildctl arbitrate` reports `target_status=pending-approval` / additive `artifactStatus`+`heldForApproval` fields for high vs low risk |
| `migration/test/supervisor-held-approval.test.ts` (T009/T010) | Held artifacts unclaimable; `runAuto`/`runAutoQueue` report `held` distinct from blocked; `heldForApproval` counts in stats |
| `migration/test/approve-command.test.ts` (T012) | CLI approve/reject happy paths, empty `--list`, refusal messages, non-zero exits |
| `migration/test/serve-approvals.test.ts` | Dashboard API parity; POST on non-pending artifact → 4xx with exact gate message |
| `migration/test/approval-dashboard-parity.test.ts` | Dashboard queue ≡ CLI `listPendingApprovals` set |
| `migration/test/attempt-history.test.ts` | Insert/validation rules; duplicate attempt throws; history ordering; budget re-seed blocks at cap after restart |
| `migration/test/attempt-outcome.test.ts` | Outcome classification rules feeding `failure_kind`/signatures |
| `migration/test/auto-canary.test.ts` | End-to-end arbitration events incl. `arbitration-approved`; auto-run cannot self-approve without independent review |
