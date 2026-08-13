# Feature Specification: Hermes-Spec Pipeline Smoke Test

**Feature Branch**: `spec/issue-94`

**Created**: 2026-08-13

**Status**: Draft

**Input**: User description: "[test] hermes-spec pipeline smoke test — Throwaway issue to validate the new /hermes-spec pipeline (branch reuse across phases, ack/done reactions). Will be closed after testing. (GitHub issue #94)"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Specify Phase Produces a Valid Spec on the Issue Branch (Priority: P1)

A maintainer (or the autonomous pipeline agent) triggers the `/hermes-spec` pipeline's specify phase against a GitHub issue. The pipeline clones the repository, creates (or reuses) the per-issue branch `spec/issue-<N>` from the repository's actual default branch, generates a complete feature specification under `specs/`, commits it with a message referencing the issue, pushes the branch, and opens exactly one draft pull request for that branch.

**Why this priority**: This is the entry point of the whole pipeline. If the specify phase cannot produce a valid, pushed spec and a single draft PR, no later phase (clarify, plan, tasks, issues) has anything to build on.

**Independent Test**: Can be fully tested by invoking the specify phase for a throwaway issue and verifying that: (a) branch `spec/issue-<N>` exists on the remote, (b) a spec directory with `spec.md` and a requirements checklist exists on that branch, (c) exactly one draft PR exists for the branch, and (d) the PR body references the source issue.

**Acceptance Scenarios**:

1. **Given** a GitHub issue with a feature description and no existing `spec/issue-<N>` branch, **When** the specify phase runs, **Then** a new branch `spec/issue-<N>` is created from the default branch, a spec is committed and pushed, and one draft PR is opened referencing the issue.
2. **Given** the specify phase has completed, **When** a reviewer inspects the spec directory, **Then** `spec.md` contains no unresolved clarification markers and the requirements checklist records the validation result.

---

### User Story 2 - Branch and PR Reuse Across Phases (Priority: P2)

A maintainer runs subsequent phases (clarify, plan, tasks, issues) for the same issue. Each phase reuses the same `spec/issue-<N>` branch and the same pull request: later phases commit additional artifacts to the same branch, push, and post a short summary comment on the existing PR instead of opening a new one.

**Why this priority**: Branch reuse across phases is one of the two behaviors this smoke test exists to validate. A pipeline that opens a second PR or a divergent branch per phase fragments review and breaks traceability to the source issue.

**Independent Test**: Can be tested by running any follow-up phase for the same issue and verifying that the PR count for `spec/issue-<N>` remains exactly one, that new commits land on the same branch, and that a phase-summary comment appears on the existing PR.

**Acceptance Scenarios**:

1. **Given** an open PR for `spec/issue-<N>`, **When** a later phase completes, **Then** its artifacts are pushed to the same branch and a comment summarizing the phase is posted to the existing PR — no second PR is created.
2. **Given** the issues phase has completed, **When** the generated task issues exist, **Then** the single PR is marked ready for review and its comment lists the created issue URLs.

---

### User Story 3 - Ack/Done Reactions Signal Phase Lifecycle on the Issue (Priority: P3)

A maintainer watching the source issue sees an acknowledgment reaction (or equivalent signal) when the pipeline picks up a phase, and a completion signal when the phase finishes, so issue subscribers can tell pipeline state without reading logs.

**Why this priority**: Reaction signaling is the second behavior this smoke test exists to validate, but the pipeline's core value (spec artifacts on a shared branch) is delivered even if signaling is degraded.

**Independent Test**: Can be tested by triggering a phase and observing the issue's reaction/comment timeline for an acknowledgment at phase start and a completion indication at phase end.

**Acceptance Scenarios**:

1. **Given** a phase is triggered on an issue, **When** the pipeline starts work, **Then** an acknowledgment signal is visible on the issue before the phase completes.
2. **Given** a phase finishes, **When** the pipeline reports, **Then** a completion signal is visible on the issue.

---

### Edge Cases

- The source issue is already closed (as with this throwaway smoke-test issue): the pipeline MUST still complete the specify phase normally, since issue state does not change the validity of branch/PR mechanics.
- A `spec/issue-<N>` branch or PR already exists from a prior partial run: the phase MUST reuse them rather than duplicate them.
- The repository default branch is not `main` (this repository uses `dev`): the pipeline MUST discover the default branch programmatically and branch from it.
- No human is available to answer clarification questions: the agent MUST make the best-supported choice, record it as an explicit assumption, and continue rather than blocking.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The pipeline MUST create (or reuse, if already present) a single branch named `spec/issue-<N>` per source issue, branched from the repository's current default branch as reported by the hosting platform.
- **FR-002**: The specify phase MUST generate a feature specification under `specs/` following the repository's spec template, with a quality checklist at `<feature-dir>/checklists/requirements.md`, and MUST record the feature directory in `.specify/feature.json`.
- **FR-003**: The specify phase MUST commit its artifacts with a message referencing the source issue and push the branch to the remote.
- **FR-004**: The pipeline MUST maintain exactly one pull request per issue branch: it MUST open one draft PR when none exists, and MUST NOT open a second PR or delete the branch in any later phase.
- **FR-005**: Later phases (clarify, plan, tasks, issues) MUST post a short summary comment on the existing PR describing what the phase produced.
- **FR-006**: On completion of the issues phase, the pipeline MUST mark the PR ready for review and include the created task-issue URLs in its PR comment.
- **FR-007**: The pipeline MUST signal phase acknowledgment and phase completion on the source issue (via reactions or an equivalent visible signal).
- **FR-008**: When running autonomously with no human available, the pipeline MUST resolve ambiguity with reasonable defaults, document each such choice as an explicit assumption in the produced artifact, and continue without blocking.

### Key Entities *(include if feature involves data)*

- **Source Issue**: The GitHub issue that carries the feature description and triggers the pipeline; identified by number; the branch and PR names derive from it.
- **Feature Specification**: The versioned artifact set (`spec.md`, `checklists/requirements.md`, `.specify/feature.json` pointer) produced by the specify phase and extended by later phases.
- **Phase Run**: One execution of one pipeline phase against one issue; produces commits on the issue branch and exactly one summary signal (PR comment and/or issue reaction).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A full specify run for a throwaway issue completes end to end (clone → branch → spec → commit → push → draft PR) with zero manual intervention.
- **SC-002**: After all phases run, exactly one pull request exists for the issue's branch and the branch still exists on the remote (0 duplicate PRs, 0 deleted branches).
- **SC-003**: The produced specification passes its own quality checklist with no unresolved clarification markers on the first autonomous run.
- **SC-004**: Every phase leaves a visible trace (PR comment or issue reaction) such that a reviewer can reconstruct phase order and outcomes from the issue and PR alone, without access to agent logs.

## Assumptions

- **Assumption (autonomous clarification)**: The issue is explicitly a throwaway smoke test ("Will be closed after testing"), so the "feature" being specified is the pipeline behavior under test itself rather than a product capability; specifying the pipeline behavior is the best-supported interpretation and avoids inventing unrelated product scope.
- **Assumption (autonomous clarification)**: The source issue (#94) is already closed at specify time; per the edge case above, the phase proceeds normally because branch/PR mechanics are independent of issue open/closed state.
- **Assumption (autonomous clarification)**: "Ack/done reactions" are validated at the level of visible signals on the issue/PR timeline; the exact reaction emoji set is an implementation detail left to the plan phase.
- The pipeline authenticates with a token that has permission to create branches, push, open PRs, and comment on the repository.
- The repository already contains Spec Kit scaffolding (`.specify/`) and the speckit-specify skill, which this phase follows.
- The smoke test adds specification artifacts only; no application source code is created or modified, consistent with the repository constitution's separation of spec phases from implementation.
- The throwaway branch and PR for this test may be cleaned up (branch deleted only after the whole test concludes) by maintainers outside the pipeline's own behavior, since the issue states the test artifacts are disposable.
