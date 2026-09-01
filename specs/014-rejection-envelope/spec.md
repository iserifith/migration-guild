# Feature Specification: Rejection Reason Envelope for the Next Remediation Attempt

**Feature Branch**: `014-rejection-envelope`

**Created**: 2026-09-01

**Status**: Draft

**Input**: User description: "#216 — flow rejection reasons back into the next remediation attempt's prompt"

## Clarifications

### Session 2026-09-01

- Q: What should distinguish a stored rejection reason from other contributors' context for the same artifact, so it can never be silently overwritten or confused with theirs? → A: Store it under a dedicated, reserved context key/tag that is never used by real analysis-writing agents, so it occupies its own slot rather than sharing one with any agent's genuine context.
- Q: Which flow(s) must read the stored rejection reason and carry it forward in v1? → A: Remediation only — the existing needs-rework-triggered remediation flow that already requeues artifacts to planned. Having the actual next migrate attempt read context directly is a candidate future extension, not required now.
- Q: If an artifact is rejected once, remediated, and later becomes needs-rework again through an unrelated path with no new rejection, should the old reason still surface, or should it expire/be marked consumed after one use? → A: It still surfaces — no expiry or consumed-marking is introduced; the envelope inherits the existing context store's last-write-wins semantics as-is.
- Q: Should this envelope also be populated for artifacts sent to needs-rework by the automated arbiter path (rejectArtifactWithEvidence), or only human operator rejections through the approval gate (recordApprovalDecision)? → A: Human operator rejections only; the automated-arbiter rejection path is out of scope for v1.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The next attempt on a rejected artifact sees why it was rejected (Priority: P1)

As a pipeline maintainer, when a human operator rejects an artifact through the approval gate with a reason, I want that reason to automatically reach whoever attempts the artifact next, so the retry addresses the actual objection instead of repeating the same mistake blind.

**Why this priority**: This is the entire point of the feature — today the reason is recorded but never relayed, so remediation is not directly informed by what a human already told it was wrong.

**Independent Test**: Reject an artifact through the approval gate with a specific reason. Run remediation on the resulting needs-rework artifact and confirm the reason it surfaces (in its requeue summary/reason and in the context it reads) matches the reason the operator gave, without consulting the approval_decisions table directly.

**Acceptance Scenarios**:

1. **Given** an artifact in the awaiting-decision state, **When** an operator rejects it with a reason, **Then** that reason becomes available as retrievable context for that specific artifact, in addition to the existing durable decision record.
2. **Given** an artifact that was rejected with a reason and is now needs-rework, **When** remediation runs on it, **Then** remediation surfaces the most recent rejection reason and includes it in what it hands off toward the next attempt (e.g. the reason/summary passed when requeuing to planned).
3. **Given** an artifact that has never been rejected, **When** remediation runs on it, **Then** remediation finds no rejection reason and proceeds exactly as it does today (no error, no spurious carry-forward).

---

### User Story 2 - A rejection reason is visibly distinguishable from other stored context (Priority: P2)

As an agent or operator reading an artifact's stored context, I want a rejection reason to be clearly labeled as coming from a human rejection (as opposed to general analysis notes another agent wrote), so I don't mistake one for the other or silently lose either.

**Why this priority**: The existing context store keeps only the latest entry per (artifact, agent) — writing a rejection reason into it naively could silently overwrite unrelated context another agent already stored for that artifact, destroying information this feature isn't meant to touch.

**Independent Test**: Write a context entry for an artifact under an existing agent-context routine, then reject that same artifact with a reason. Confirm both the prior context and the new rejection reason are separately retrievable afterward, and that a reader can tell which is which without inferring it from content alone.

**Acceptance Scenarios**:

1. **Given** an artifact already has stored context from an unrelated agent, **When** the artifact is later rejected with a reason, **Then** the prior context remains retrievable and unaltered.
2. **Given** an artifact has a stored rejection reason, **When** any consumer reads it back, **Then** it is clearly marked as a rejection reason (not general analysis context) and identifies which attempt/decision it came from.
3. **Given** an artifact is rejected more than once across separate cycles, **When** the most recent rejection reason is read, **Then** only the latest one is surfaced as "the" reason to act on (older ones remain in the permanent decision history but do not confuse the next attempt).

---

### Edge Cases

- What happens if the artifact is rejected again before remediation ever reads the first reason? (The next remediation read must reflect the latest rejection reason; earlier reasons remain permanently queryable via the existing approval decision history, just not what remediation acts on.)
- What happens if remediation runs on a needs-rework artifact that reached that status through a path other than a human rejection (e.g. an automated arbiter rejection)? (No rejection reason is found via this envelope; remediation proceeds exactly as it does today — this feature only covers the human approval-gate rejection path.)
- What happens if an artifact is rejected once, remediated, and later becomes needs-rework again through an unrelated path with no new rejection? (The old reason still surfaces on the next remediation read — no expiry or consumed-marking is introduced; this matches the existing context store's last-write-wins behavior and is an accepted tradeoff, not a defect.)
- What happens if writing the rejection reason into context fails (e.g. filesystem issue)? (The rejection decision itself must still be recorded and the artifact must still transition to needs-rework; the envelope write is additive and must not become a new failure mode for rejection.)
- What happens when the reason text is very long or contains characters that could break the context file's expected format? (It must still be stored and read back faithfully as the operator wrote it.)

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: When a human operator rejection decision is recorded through the approval gate, the system MUST make that rejection's reason retrievable as context scoped to that specific artifact, in addition to the existing permanent decision record. Rejections recorded through the automated-arbiter path are out of scope for this requirement.
- **FR-002**: The stored rejection reason MUST occupy a dedicated, reserved context slot that is never used by any real context-writing agent, so a reader can tell it is a rejection reason purely from where it was read, without inferring it from prose content.
- **FR-003**: Writing a rejection reason into context MUST NOT overwrite or discard context already stored for that artifact by another contributor, because it never shares that contributor's slot.
- **FR-004**: When more than one rejection has occurred for an artifact, the system MUST make the most recent rejection reason the one surfaced as current; older rejection reasons remain permanently available through the existing decision history, not through this envelope.
- **FR-005**: The system MUST provide a way for the remediation flow to check, before it hands a needs-rework artifact off for its next attempt, whether a rejection reason exists for that artifact, and to retrieve it if so.
- **FR-006**: When remediation requeues a needs-rework artifact that has a stored rejection reason, it MUST carry that reason forward into the information it leaves for the next attempt (e.g. the reason/summary it records when returning the artifact to planned).
- **FR-007**: When remediation requeues a needs-rework artifact that has no stored rejection reason, it MUST proceed exactly as before this feature — no error, no fabricated reason.
- **FR-008**: A failure while writing a rejection reason into context MUST NOT prevent the rejection decision itself from being recorded or the artifact from transitioning to needs-rework.
- **FR-009**: The rejection reason, once stored, MUST be readable back exactly as the operator wrote it (no truncation, no corruption of arbitrary text content).

### Key Entities

- **Rejection Envelope Entry**: The most recent human rejection reason for one artifact, stored as retrievable context distinct from other contributors' context for that artifact; sourced from an existing approval decision, not a new permanent record of its own — the permanent record remains the approval decision itself.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For every artifact rejected through the approval gate with a reason, that reason is retrievable as context for that artifact within the same operation that recorded the rejection — no separate manual step required.
- **SC-002**: In 100% of remediation runs against a needs-rework artifact that carries a stored rejection reason, the reason appears in what remediation hands off toward the next attempt.
- **SC-003**: In 100% of remediation runs against a needs-rework artifact with no stored rejection reason (including pre-existing needs-rework artifacts from before this feature shipped), remediation completes with the same behavior as before this feature, with no error attributable to the absence of a reason.
- **SC-004**: Context previously stored for an artifact by another contributor is still fully retrievable, unchanged, after that artifact is subsequently rejected with a reason.

## Assumptions

- Scope is the human approval-gate rejection path only (the `recordApprovalDecision` flow introduced in spec 013 US2); flowing the automated migrate-phase retry-attempt failure reasons (spec 013 US3) through the same envelope is a candidate future extension, not required here.
- The existing per-artifact context store (one durable entry per contributor, latest write wins) is reused as the transport for this envelope; no new database table, transport, or subsystem is introduced.
- "Remediation" for the purposes of this feature is the existing remediation flow that already triggers on needs-rework artifacts and already requeues them to planned for the next attempt; this feature adds a read/carry-forward step to that existing flow rather than introducing a new flow.
- Only the most recently stored rejection reason needs to be surfaced to the next attempt; the full rejection history remains permanently queryable through the existing approval decision record, which this feature does not change.
- A rejection reason that is never consulted (e.g. the artifact is abandoned, or reworked through some path that doesn't invoke remediation) is not required to be cleaned up or expired by this feature.
