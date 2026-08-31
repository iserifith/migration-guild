# Feature Specification: Adversary Agent Role Between Review and the Approval Gate

**Feature Branch**: `017-adversary-agent-gate`

**Created**: 2026-09-01

**Status**: Draft

**Input**: User description: "#217 — insert an adversarial probe role between review-agent and the point where a below-risk-cutoff artifact would otherwise reach `reviewed` unattended, building on the rejection-envelope relay mechanism from #216"

## Clarifications

### Session 2026-09-01

- Q: What literal identifier should the adversary-agent's reserved context slot use, so it's distinct from issue #216's `rejection-envelope` slot? → A: `adversary-envelope` — mirrors #216's `<origin>-envelope` naming pattern.
- Q: When the adversary-agent cannot construct a stack-appropriate probe at all (e.g. the verify command is missing or unusable), should the artifact be held back from `reviewed` (fail closed) or allowed to proceed with the gap only recorded for visibility (fail open)? → A: Fail closed — an inconclusive probe routes the artifact to `needs-rework` the same as a found violation, with the inconclusive reason recorded in place of a finding.
- Q: For a high-risk, gate-bound artifact that the adversary-agent probes and does NOT flag, should that clean-probe outcome be surfaced to the human operator as additional decision context, or stay purely a fail-path check with no signal on a pass? → A: Surface it — record a lightweight "adversary probe passed" event so the human operator's context at the gate includes that the adversarial check ran and found nothing, without treating it as a new form of evidence/approval.
- Q: Does the adversary-agent get its own retry/attempt-state accounting (mirroring spec 013 US3's migrate-attempt tracking), or does it run as a single stateless pass each time an artifact reaches this pipeline point? → A: Stateless single pass — no new attempt-count state; each time an artifact reaches this point after clearing review, the adversary-agent probes it once and the outcome is that cycle's result.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A below-cutoff artifact gets one adversarial probe before it completes unattended (Priority: P1)

As a pipeline maintainer, when an artifact's risk assessment is below the high-risk cutoff and so will never reach a human at the approval gate, I want an adversarial agent to actively try to break it — construct one input or test case that passes the existing test suite but violates the spec's intent — before the pipeline lets it complete, so a below-cutoff artifact isn't just diagnosed by a friendly critic and then trusted blind.

**Why this priority**: This is the entire point of the feature — today `review-agent` diagnoses against the spec but never actively tries to defeat the artifact's own tests, and a below-cutoff artifact that clears review and arbitration proceeds straight to `reviewed` with no adversarial check at all.

**Independent Test**: Take an artifact whose migrated behavior has a deliberately introduced spec-violating edge case that its existing test suite does not cover (e.g., an off-by-one on a migrated boundary). Run the adversary-agent against it and confirm it constructs a case that exposes the violation and the artifact does not reach `reviewed` as a result.

**Acceptance Scenarios**:

1. **Given** an artifact that has passed `review-agent` and is not in scope for the human approval gate, **When** the adversary-agent runs and finds no spec-violating case that passes the existing test suite, **Then** the artifact proceeds to `reviewed` exactly as it does today.
2. **Given** the same starting point, **When** the adversary-agent constructs an input/test case that passes the existing test suite but violates the spec's intent, **Then** the artifact is routed to `needs-rework` instead of `reviewed`, and the finding (the constructed case and why it violates intent) is recorded against the artifact.
3. **Given** an artifact that IS in scope for the human approval gate (above the risk cutoff), **When** it proceeds through the pipeline, **Then** the adversary-agent step still runs before the gate (a high-risk artifact is not exempted from the adversarial probe merely because a human will also see it), and its outcome is independent of and does not replace the human decision.

---

### User Story 2 - An adversary finding reaches the next remediation attempt through the existing rejection-relay flow (Priority: P1)

As a pipeline maintainer, when the adversary-agent sends an artifact back to `needs-rework`, I want the next remediation attempt to see *why* — the constructed adversarial case and the spec intent it violated — carried forward automatically, the same way a human rejection reason already is (issue #216), so remediation doesn't repeat the same mistake blind and so the project doesn't end up with two disconnected rejection-reason relay mechanisms.

**Why this priority**: Without this, an adversary-agent finding is only as useful as whoever happens to read the raw event log; #216 already solved "carry a rejection reason to the next attempt" for human rejections, and duplicating that mechanism instead of reusing it would fragment the pipeline's one remediation flow into two.

**Independent Test**: Force the adversary-agent to find a violation on an artifact, confirm its finding becomes retrievable context scoped to that artifact, then run remediation on the resulting `needs-rework` artifact and confirm the finding text appears in what remediation hands off toward the next attempt, without remediation consulting any adversary-agent-specific record directly.

**Acceptance Scenarios**:

1. **Given** an artifact the adversary-agent has sent to `needs-rework` with a recorded finding, **When** remediation runs on it, **Then** remediation surfaces that finding and includes it in the reason/summary it leaves for the next attempt.
2. **Given** an artifact that was separately rejected by a human operator through the approval gate (#216) and also, on a different cycle, found by the adversary-agent, **When** remediation reads both, **Then** each is retrievable as its own distinct entry — neither silently overwrites the other — and a reader can tell an adversary finding apart from a human rejection reason without inferring it from prose content alone.
3. **Given** an artifact that has never been flagged by the adversary-agent, **When** remediation runs on it, **Then** remediation finds no adversary finding and proceeds exactly as it does today (no error, no spurious carry-forward).

---

### User Story 3 - An adversary-agent finding does not silently vanish if it can't be recorded (Priority: P3)

As a pipeline maintainer, if recording an adversary finding into retrievable context fails for some reason (e.g. a filesystem issue), I want the artifact to still be routed to `needs-rework` — the safety-critical outcome — rather than the recording failure accidentally letting a known-bad artifact continue toward `reviewed`.

**Why this priority**: Lower priority than the core probe-and-route behavior, but it determines whether a plumbing failure in the best-effort relay can ever silently defeat the adversarial check itself, which would undermine the whole feature's purpose.

**Independent Test**: Simulate a failure while writing the adversary finding into context and confirm the artifact still transitions to `needs-rework` and an event is still recorded, even though the detailed finding context write failed.

**Acceptance Scenarios**:

1. **Given** the adversary-agent has found a spec-violating case, **When** recording that finding as retrievable context fails, **Then** the artifact still transitions to `needs-rework` and a `needs-rework`-triggering event is still appended.
2. **Given** the same failure, **When** an operator later inspects the artifact's event history, **Then** the event record alone (independent of the context write) is sufficient to know the artifact was sent back by the adversary-agent, even if the detailed finding text is unavailable.

---

### Edge Cases

- What happens if the adversary-agent runs on an artifact that `review-agent` already sent to `needs-rework`? (The adversary-agent only runs on artifacts that passed review and are proceeding toward `reviewed`; an artifact already at `needs-rework` from review is out of scope for this step — it re-enters the normal remediation flow without an adversarial probe until it clears review again.)
- What happens if the adversary-agent cannot construct a stack-appropriate test case at all (e.g. the stack's configured verify command is missing or unusable)? (The step fails closed: the artifact is routed to `needs-rework` the same as a found violation, and the recorded reason states the probe was inconclusive rather than describing a constructed case — see Clarifications. This intentionally does not follow `review-agent`'s "compile checks are optional, never required" tolerance pattern, because a below-cutoff artifact with an unrunnable adversarial check would otherwise complete unattended with zero adversarial signal, which is the exact gap this feature exists to close.)
- What happens if an artifact is flagged by the adversary-agent more than once across separate cycles? (Only the most recent finding is what remediation acts on — matching the existing context store's last-write-wins semantics that #216 already established; earlier findings remain in the permanent event history.)
- What happens if the adversary-agent's finding and a human rejection reason exist for the same artifact at the same time? (Both remain independently retrievable; remediation folds in both, distinguishably, rather than one overwriting the other — see User Story 2, Scenario 2.)
- What happens to a high-risk artifact that both the adversary-agent flags and a human would otherwise decide on? (The adversary-agent's probe runs before the gate regardless of risk tier — see User Story 1, Scenario 3 — so a flagged high-risk artifact is routed to `needs-rework` the same as a flagged below-cutoff one, and never reaches the human decision point with a known adversarial finding unaddressed.)

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST introduce a new pipeline step (the adversary-agent) that runs after an artifact has passed the existing review step and before that artifact is allowed to reach the `reviewed` status.
- **FR-002**: The adversary-agent's task MUST be narrowly scoped to constructing one input or test case that passes the artifact's existing, stack-configured verification (test) command while violating the spec's intent — not a general re-review of the artifact.
- **FR-003**: When the adversary-agent finds no such case, the artifact MUST proceed toward `reviewed` exactly as it does today, with no change in outcome attributable to this feature.
- **FR-004**: When the adversary-agent constructs a spec-violating case, the artifact MUST be routed to `needs-rework` instead of `reviewed`.
- **FR-005**: The adversary-agent's finding MUST be recorded in a way that a human or agent can later determine that the artifact was sent to `needs-rework` because of an adversarial finding, distinct from a review finding, an arbiter rejection, or a human operator rejection.
- **FR-006**: The adversary-agent step MUST run for every artifact reaching this point in the pipeline regardless of whether that artifact is in scope for the human approval gate — an artifact being high-risk (gate-bound) MUST NOT exempt it from the adversarial probe.
- **FR-007**: The adversary-agent's finding, when produced, MUST be made retrievable as context scoped to that specific artifact, using the same underlying retrievable-context mechanism, storage convention, and last-write-wins-per-slot semantics that issue #216 established for the human-rejection reason relay — reused, not duplicated as a second parallel mechanism.
- **FR-008**: The adversary-agent's finding MUST occupy its own dedicated, reserved context slot — identifier `adversary-envelope` — distinct from the `rejection-envelope` slot #216 reserved for human operator rejection reasons, so a reader can tell an adversary finding apart from a human rejection reason purely from where it was read, without inferring it from prose content.
- **FR-008a**: When the adversary-agent's probe is inconclusive (it could not run at all against the artifact's stack), the artifact MUST still be routed to `needs-rework`, and the `adversary-envelope` slot MUST record that the probe was inconclusive (and why), distinct from recording an actual constructed violating case.
- **FR-008b**: When the adversary-agent probes a high-risk, gate-bound artifact and finds no violation, the system MUST record a lightweight event noting the adversarial probe ran and passed, so a human operator deciding at the approval gate has that context available; this pass record MUST NOT be treated as approval evidence or otherwise feed the evidence/arbitration gate mechanics.
- **FR-009**: Writing an adversary finding into context MUST NOT overwrite or discard context already stored for that artifact by any other contributor (a real analysis agent, a human rejection reason, etc.), because it never shares another contributor's slot.
- **FR-010**: The system MUST provide a way for the remediation flow to check, before it hands a `needs-rework` artifact off for its next attempt, whether an adversary finding exists for that artifact, and to retrieve it if so — following the same read step #216 already added to remediation for the human-rejection reason, extended to also check the adversary finding's slot.
- **FR-011**: When remediation requeues a `needs-rework` artifact that has a stored adversary finding, it MUST carry that finding forward into the information it leaves for the next attempt (its requeue reason/summary text), the same way it already does for a human rejection reason (#216).
- **FR-012**: When remediation requeues a `needs-rework` artifact that has both a stored human rejection reason and a stored adversary finding, it MUST fold both into the requeue reason/summary text, distinguishably, rather than surfacing only one.
- **FR-013**: When remediation requeues a `needs-rework` artifact that has neither a stored human rejection reason nor a stored adversary finding, it MUST proceed exactly as it does today — no error, no fabricated reason.
- **FR-014**: The routing of an artifact to `needs-rework` on an adversary finding MUST reuse the same status-transition and event-recording primitives the pipeline already uses for review and arbitration rejections, rather than introducing a new status value or a second, parallel approval/rejection gate.
- **FR-015**: A failure while recording an adversary finding into retrievable context MUST NOT prevent the artifact from transitioning to `needs-rework` or prevent the routing event from being recorded (fail-open write, fail-closed routing decision — mirroring the precedent #216 established for the human-rejection-reason write).
- **FR-016**: The adversary finding, once stored, MUST be readable back exactly as produced (no truncation, no corruption of arbitrary text content describing the constructed case).
- **FR-017**: This feature's design MUST NOT alter the existing human approval-gate flow (`recordApprovalDecision`) or its preconditions, scope, or behavior as established by spec 013 and issue #216 — the adversary-agent step is additive and precedes the gate, it does not modify it.

### Key Entities

- **Adversary Finding**: The most recent adversarial probe result for one artifact that failed the probe — either a constructed input/test case and the spec intent it violates, or an inconclusive-probe reason when the probe could not run (FR-008a) — stored under the reserved `adversary-envelope` context slot, distinct from any other contributor's context for that artifact, including a human rejection reason. Sourced from the adversary-agent's probe outcome; the routing event (artifact sent to `needs-rework`) is the permanent record, and this finding is the best-effort detail relayed alongside it, not a replacement for it.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For every below-risk-cutoff artifact that passes review, an adversarial probe runs before that artifact can reach `reviewed` — none skip this step because of their risk tier.
- **SC-002**: For every artifact the adversary-agent flags, the artifact reaches `needs-rework` instead of `reviewed`, in 100% of cases, regardless of context-recording success or failure.
- **SC-003**: In 100% of remediation runs against a `needs-rework` artifact that carries a stored adversary finding, that finding appears in what remediation hands off toward the next attempt.
- **SC-004**: In 100% of remediation runs against a `needs-rework` artifact with no stored adversary finding, remediation completes with the same behavior as before this feature, with no error attributable to the absence of a finding.
- **SC-005**: Context previously stored for an artifact by another contributor (a real analysis agent, or a human rejection reason under #216) is still fully retrievable, unchanged, after that artifact is subsequently flagged by the adversary-agent.
- **SC-006**: An operator or agent reading an artifact's `needs-rework` history can distinguish, without reading prose, whether it was sent back by review, by the arbiter, by a human operator rejection, or by the adversary-agent.

## Assumptions

- This issue is analysis-only / spec-only in the sense the originating gap analysis intended: this specification, its plan, and its tasks describe the target design, but implementation is out of scope for this decomposition.
- Full implementation of this feature is blocked on issue #216 (branch `014-rejection-envelope`) landing first: #216's retrievable-context write/read helpers and reserved-slot convention (`migration/registry/commands/context.ts`, and the envelope helpers added to `migration/registry/commands/approval.ts`) are the foundation this feature's adversary-finding slot reuses. This spec, plan, and tasks are written now against #216's already-finished (but not yet merged) design so they are ready to implement as soon as #216 lands.
- Direct reuse of #216's human-rejection code path (`recordApprovalDecision`) for the adversary-agent's own rejection is not possible: that function requires the artifact to already be at the post-gate `pending-approval` status and is scoped by #216's own clarification to human operator rejections only, and the adversary-agent's probe runs strictly pre-gate, on artifacts that in the below-cutoff case never reach `pending-approval` at all. This feature instead reuses the same underlying retrievable-context mechanism and convention under its own reserved slot, and reuses the same status-transition/event-recording primitives already used elsewhere in the pipeline for routing an artifact to `needs-rework`.
- The adversary-agent's reserved context slot is `adversary-envelope` (FR-008, Clarifications) — a distinct identifier from #216's `rejection-envelope` slot for human rejection reasons.
- The adversary-agent runs as a stateless single pass each time an artifact reaches this pipeline point after clearing review (Clarifications); it does not introduce its own retry/attempt-count state akin to spec 013 US3's migrate-attempt tracking. A future extension could add such accounting, but it is out of scope here.
- "Remediation" for the purposes of this feature is the same existing remediation flow #216 already extended (triggers on `needs-rework`, requeues to `planned`); this feature adds a second, analogous read/carry-forward step to that same flow rather than introducing a new flow.
- The adversary-agent's test-case-construction approach (what makes a probe "narrow" versus a general re-review) is a prompt/procedure-design concern for the agent's own instructions, not a registry or data-model concern; this spec constrains its trigger point, scope, and outcome routing, not its internal reasoning process.
- An adversary finding that is never consulted (e.g. the artifact is abandoned, or reworked through a path that doesn't invoke remediation) is not required to be cleaned up or expired by this feature — matching the same accepted tradeoff #216 already established for human rejection reasons.
