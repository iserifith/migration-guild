# Feature Specification: Human Approval Gate and Attempt-Scoped Retry History for the Migrate/Review Loop

**Feature Branch**: `013-approval-gate-attempt-state`

**Created**: 2026-08-21

**Status**: Draft

**Input**: User description: "#173 — Human oversight and attempt-scoped state for the migrate/review loop"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - High-risk artifacts wait for a human decision before completing (Priority: P1)

As a migration operator, I want artifacts whose risk score exceeds the high-risk cutoff to stop and wait for my explicit decision after they pass automated review, so that no high-risk output (payment handling, auth, crypto-touching code) ever reaches a completed state on automated judgment alone.

**Why this priority**: This is the core problem: today, an automated verdict is sufficient to complete even the riskiest artifacts. Closing this gap is the entire point of the feature.

**Independent Test**: Run the pipeline over a fixture containing one above-cutoff artifact and one below-cutoff artifact, both of which pass automated review. Confirm the below-cutoff artifact reaches its terminal completed state unattended, while the above-cutoff artifact stops in a held, awaiting-decision state with its output and the automated review outcome visible, and only advances after an explicit operator decision.

**Acceptance Scenarios**:

1. **Given** an above-cutoff artifact that has passed automated review, **When** the completion step would normally fire, **Then** the artifact instead enters a held, awaiting-decision state and is not marked complete.
2. **Given** an artifact in the awaiting-decision state, **When** an operator approves it, **Then** the artifact completes and the decision (who, when, what) is preserved permanently.
3. **Given** an artifact in the awaiting-decision state, **When** an operator rejects it with a reason, **Then** the artifact returns to rework with the reason preserved, and follows the normal remediation path.
4. **Given** an artifact at or below the high-risk cutoff that passes automated review, **When** the completion step fires, **Then** it completes exactly as today — no waiting, no prompt.
5. **Given** an unattended/automated run, **When** an above-cutoff artifact reaches the decision point, **Then** it is held (never auto-approved), the run continues with other available work, and the held artifact is reported distinctly in the run summary as awaiting a human, not as failed or blocked.

---

### User Story 2 - Operator can record approve/reject decisions without a graphical interface (Priority: P1)

As a migration operator, I want a command-line way to see what's awaiting my decision and to approve or reject it, so that the gate is actionable immediately, without depending on a separate interface being built first.

**Why this priority**: The gate from User Story 1 has no value if there's no way to act on it. A command-line decision path is the minimum viable way to unblock the gate and can ship independently of any dashboard work.

**Independent Test**: With one artifact awaiting decision, list pending decisions from the command line, approve one by identifier, and confirm it completes; reject another with a reason and confirm it returns to rework.

**Acceptance Scenarios**:

1. **Given** one or more artifacts awaiting decision, **When** the operator lists pending decisions, **Then** each is shown with enough context (what it is, why it was flagged high-risk, the automated review outcome) to decide without consulting another tool.
2. **Given** an artifact awaiting decision, **When** the operator issues an approve or reject command, **Then** the same underlying decision-recording logic runs regardless of what surface triggered it (so a future graphical surface reuses it rather than duplicating it).

---

### User Story 3 - Retry and failure history for a migration attempt survives and is queryable after the fact (Priority: P1)

As a pipeline maintainer debugging a flaky migration, I want each retry attempt's failure reason and how much of its retry budget it used to be recorded durably and attributable to that specific attempt, so that I can reconstruct what happened without scraping logs, and so that a restart of the process doesn't lose or double-count that history.

**Why this priority**: This is the concrete gap behind "phases aren't independently debuggable" — attempt history currently lives only in the memory of the running process. It's foundational for post-mortems and is independent of, but complementary to, the approval gate.

**Independent Test**: Run a fixture artifact that fails twice and succeeds on the third attempt. Query the retry history afterward and confirm each attempt's outcome and failure reason is attributable to its own attempt number, and that the count of attempts and remaining budget match reality. Separately, kill and restart the process mid-artifact and confirm retry budget accounting afterward is neither reset nor double-counted.

**Acceptance Scenarios**:

1. **Given** a migration attempt that fails, **When** the failure is recorded, **Then** its cause and which attempt it belongs to are durably stored, not just held in the running process.
2. **Given** an artifact that has gone through several attempts, **When** an operator or maintainer requests its retry history, **Then** the attempts are shown in order, each with its own outcome, and the total matches the artifact's current attempt count.
3. **Given** a process restart occurring mid-artifact, **When** the artifact is picked up again, **Then** its retry budget accounting reflects everything that happened before the restart — no attempts silently forgotten, none double-counted.
4. **Given** a scheduling or prioritization decision elsewhere in the pipeline, **When** that decision is made, **Then** it does not depend on any in-progress attempt's internal working detail — only on an attempt's final recorded outcome.

---

### User Story 4 - Pending decisions are visible in the operator dashboard (Priority: P2)

As a migration operator, I want artifacts awaiting a decision to appear in the existing visual dashboard alongside their output and review outcome, with approve/reject controls, so that I don't have to drop to the command line once the gate is in regular use.

**Why this priority**: Valuable for day-to-day ergonomics once the gate (User Story 1) and the command-line path (User Story 2) exist, but the feature is fully functional without it — this is a convenience layer, not the mechanism.

**Independent Test**: With one artifact awaiting decision, open the dashboard and confirm it appears in a clearly labeled section with its context; approve it from the dashboard and confirm the same outcome as the command-line path.

**Acceptance Scenarios**:

1. **Given** at least one artifact awaiting decision, **When** the operator opens the dashboard, **Then** a clearly labeled section lists each one with why it was flagged, its output, and the automated review outcome.
2. **Given** the operator approves or rejects from the dashboard, **When** the decision is submitted, **Then** the outcome is identical to the command-line path (same record, same downstream effect).
3. **Given** nothing is awaiting decision, **When** the operator opens the dashboard, **Then** the section is empty but clearly present, not an error.

---

### Edge Cases

- What happens if an artifact is rejected, reworked, and re-passes automated review — does it re-enter the awaiting-decision state, or is the prior rejection considered final? (Assumption: it re-enters; every pass of automated review by an in-scope artifact requires a fresh decision.)
- What happens if the risk cutoff configuration changes while artifacts are already awaiting decision? (Assumption: artifacts already awaiting decision are unaffected; only future automated-review passes use the new cutoff.)
- What happens if an operator tries to approve an artifact that is no longer awaiting decision (already decided, or reset by a later run)? (Must be rejected with a clear error, not silently accepted.)
- What happens if the process crashes while an artifact is awaiting decision? (The artifact must remain awaiting decision — it holds no exclusive lock or claim that could wedge other work.)
- What happens if the automated review outcome an operator is approving against is stale by the time they decide (e.g., the artifact's underlying output changed after review)? (Must be detected and blocked — an operator cannot approve against outdated output.)
- What happens when a retry's failure reason doesn't match any known category? (Must still be recorded, categorized as unclassified rather than dropped.)

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST support a distinct "awaiting decision" state for artifacts, reachable only after an artifact has passed automated review and been identified as high-risk (or otherwise in-scope for the gate), and leaving that state only via an explicit human approve or reject decision.
- **FR-002**: The system MUST evaluate whether an artifact is in-scope for the gate (by risk cutoff, at minimum) at the moment automated review passes, and divert in-scope artifacts to the awaiting-decision state instead of completing them automatically.
- **FR-003**: Every human decision MUST be recorded permanently with who made it, when, what was decided, and — for rejections — the reason. Decision records MUST NOT be edited or deleted after the fact; a later re-decision creates a new record rather than altering the old one.
- **FR-004**: Both a command-line path and (in a later increment) a dashboard path MUST drive the identical underlying decision logic — no surface may implement its own separate approve/reject behavior.
- **FR-005**: Unattended/automated pipeline runs MUST treat the awaiting-decision state as something that does not consume a retry attempt and does not stall other work; the run's summary MUST report held artifacts distinctly from failures.
- **FR-006**: An operator MUST NOT be able to approve an artifact whose underlying output has changed since the automated review it is being approved against; the system MUST detect and block this.
- **FR-007**: A process crash or restart MUST NOT leave an artifact stuck unable to reach the awaiting-decision state, and MUST NOT require the awaiting-decision state to hold any exclusive lock that could block other artifacts' progress.
- **FR-008**: The system MUST durably record, for each retry attempt of the migrate phase, its outcome and failure classification (when it failed), attributable to that specific attempt number.
- **FR-009**: Retry budget accounting for the migrate phase MUST be reconstructable from durable records alone, such that a process restart mid-artifact resumes with accounting identical to what it would have been without the restart (no attempts lost, none double-counted).
- **FR-010**: Retry attempt history MUST be queryable after the fact (attempt-by-attempt outcome and failure classification) without requiring access to process logs.
- **FR-011**: Scheduling and prioritization decisions elsewhere in the pipeline MUST depend only on an attempt's final recorded outcome, never on an in-progress attempt's internal working state.
- **FR-012**: The system MUST NOT silently auto-approve an in-scope high-risk artifact under any run mode, including fully unattended/autonomous runs.

### Key Entities

- **Approval Decision**: Who decided, which artifact, approve or reject, reason (required on reject), when. Permanent, append-only; a re-decision adds a new record rather than replacing the old one.
- **Gate Scope**: The rule determining which artifacts require a human decision — at minimum, the existing risk-score cutoff; extensible later without being required for v1.
- **Attempt Record**: One migration retry attempt's outcome and failure classification, tied to its artifact and attempt number, retained even after the artifact's final status is known.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In an unattended run over a fixture with one above-cutoff and several below-cutoff artifacts, the run completes all other work, reports exactly one artifact awaiting decision, and zero high-risk artifacts complete without a recorded human decision.
- **SC-002**: An operator can go from "run reports an artifact awaiting decision" to "artifact approved and completed" using only the command line, in under one minute.
- **SC-003**: For a three-attempt flaky fixture, 100% of the retry history (each attempt's outcome and failure reason) is reconstructable from durable records alone, with no reliance on logs.
- **SC-004**: A process killed and restarted mid-artifact resumes retry-budget accounting with zero discrepancy against a run of the same fixture with no restart.
- **SC-005**: Every artifact that reaches a completed state after being flagged high-risk has a full, gap-free trail: automated-review pass → awaiting-decision entry → human decision → completion.

## Assumptions

- Scope for the durable attempt-history requirement (User Story 3) is the migrate phase only, where the retry/repair loop actually exists today; other phases are out of scope for this feature.
- The command-line decision path (User Story 2) ships before, and independently of, the dashboard path (User Story 4) — they are not required to land together.
- Gate scope for v1 is the existing risk-score cutoff only; additional pattern-based scoping (e.g., by artifact kind or role) is a future extension, not required here.
- Any operator with pipeline access may record a decision; role-based authorization of who is allowed to approve is out of scope for this feature.
- Batch approval (deciding many artifacts at once) and notification/alerting on new awaiting-decision artifacts are out of scope for v1; an operator checking the run summary or dashboard is sufficient.
- This feature does not change what the automated review or automated arbiter itself decides — it only gates what happens after an approving verdict for in-scope artifacts.
