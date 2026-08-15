# Feature Specification: Planner-Emitted Dependency Disposition Records

**Feature Branch**: `006-dependency-disposition`

**Created**: 2026-08-16

**Status**: Draft

**Input**: User description: "Proposal: Dependency pruning — planner-emitted dependency disposition records (GitHub issue #61). During the Plan phase, scan dependencies (AST-level) and produce a confirmed disposition per library: keep / replace-with-native (Java 17/21 equivalents) / inline. Prevents dragging legacy dependency bloat into the modernized target. Overlaps the existing dependency-strategy machinery (`approveDependencyStrategy` in `plan.ts`) — the planner should emit a per-library strategy as a confirmed registry artifact rather than silently rewriting. v1 = planner produces confirmed dependency-disposition records. Automatic AST inlining of helper logic is out of scope for v1. The locked dependency set produced here is the input for the version-locked doc RAG proposal."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Every declared dependency gets a planner-emitted disposition record (Priority: P1)

As a migration operator, when the Plan phase runs against a workspace, I want every third-party library used by the in-scope legacy codebase to end up with a recorded disposition — keep, replace-with-native, or inline — stored as a queryable registry artifact, so that the target-side dependency set is an explicit, auditable decision rather than whatever the migration agents happened to produce.

**Why this priority**: This is the entire deliverable of v1. The issue's core complaint is that legacy dependency bloat is silently dragged into the modernized target; a confirmed per-library disposition record is the mechanism that stops that. Without it there is no feature.

**Independent Test**: Run Plan against a legacy codebase whose manifest declares a mix of libraries: one that must be kept (no native equivalent), one with a clear Java 17/21 native equivalent, and one small helper library whose used surface is a handful of utility methods. Confirm the registry afterwards shows one disposition record per library with the correct disposition kind, a rationale, and a target (native replacement or inline note) where required.

**Acceptance Scenarios**:

1. **Given** a legacy workspace with declared third-party dependencies, **When** the Plan phase completes, **Then** every in-scope library has exactly one disposition record in the registry, queryable without re-running any analysis.
2. **Given** a library the planner judges must be kept, **When** its disposition is recorded, **Then** the record shows disposition "keep" with a rationale explaining why no replacement or inlining is appropriate.
3. **Given** a library with a well-known Java 17/21 native equivalent, **When** its disposition is recorded, **Then** the record shows disposition "replace-with-native", names the native replacement, and includes a rationale.
4. **Given** a small helper library whose used surface is limited to a few utility methods, **When** its disposition is recorded, **Then** the record shows disposition "inline" with a rationale; no actual code inlining is performed (out of scope for v1).
5. **Given** a Plan run that has already recorded dispositions, **When** an operator queries the registry, **Then** they can retrieve the full disposition set — one row per library, with disposition, target, rationale, and who/what confirmed it — without re-running the scan.

---

### User Story 2 - Dispositions are confirmed before they lock (Priority: P1)

As a migration operator, I want planner-proposed dispositions to go through the same human-in-the-loop confirmation pattern already used for mapping confirmation and dependency strategies — with a non-interactive auto-approve path for benchmark/CI runs — so that an automated guess about dropping or replacing a library can't silently rewrite the target dependency set.

**Why this priority**: A disposition that silently "removes" a library is exactly the silent-rewrite failure the issue calls out. Tied for P1 with User Story 1 because confirmation is what makes the record a *decision* instead of a suggestion; this mirrors the existing `approveDependencyStrategy` and `confirmMappings` precedents the issue explicitly references.

**Independent Test**: Run Plan interactively against a workspace with at least one replace-with-native proposal. Confirm the operator is prompted to confirm or override the proposal, that the chosen outcome is what lands in the registry, and that a non-interactive run with the explicit auto-approve flag records the planner's proposal with an identifiable automated approver.

**Acceptance Scenarios**:

1. **Given** a planner-proposed disposition awaiting confirmation, **When** the operator confirms it, **Then** the registry record is marked confirmed with the operator's identity and timestamp.
2. **Given** a planner-proposed disposition the operator disagrees with, **When** the operator overrides it (e.g., changes replace-with-native to keep), **Then** the final record reflects the operator's chosen disposition and captures the rationale for the override.
3. **Given** an unattended/benchmark run with the explicit auto-approve option enabled, **When** dispositions are proposed, **Then** they are recorded as confirmed with an identifiable automated actor, mirroring the existing auto-approval precedent.
4. **Given** an unattended run without the auto-approve option, **When** a library lacks a confirmed disposition, **Then** planning does not silently default it — the run surfaces the unresolved disposition set as a blocking readiness item, consistent with existing planning-readiness gating.

---

### User Story 3 - Disposition set is consumed downstream as the locked dependency target (Priority: P2)

As a migration operator, I want the confirmed disposition set to be the authoritative input the migration agents and the follow-up doc-RAG work consume — replace-with-native and inline dispositions steering codegen away from re-declaring pruned libraries, and the kept set (with locked versions) feeding version-locked documentation retrieval — so that the planning decision actually shapes the modernized output.

**Why this priority**: This is why the records exist, but v1's deliverable is the records themselves. Wiring every consumer is separable: the issue explicitly states the locked dependency set is the *input for* the version-locked doc RAG proposal (a separate feature), and migration agents honoring dispositions builds on the record set existing first.

**Independent Test**: After a Plan run with one replace-with-native and one inline disposition, confirm (a) the migration agent's planning context for affected artifacts includes the disposition (i.e., "do not re-declare library X; use native Y" / "do not re-declare library Z; its helper will be provided inline"), and (b) the kept-library set with resolved target versions is retrievable from the registry in a form the doc-RAG proposal can consume.

**Acceptance Scenarios**:

1. **Given** a confirmed replace-with-native disposition for a library, **When** a migration agent prepares work on an artifact that used that library, **Then** the agent's context identifies the native replacement so generated code does not re-introduce the pruned dependency.
2. **Given** a confirmed keep disposition, **When** the target dependency set is queried, **Then** the library appears with a locked target version.
3. **Given** the full confirmed disposition set, **When** an operator (or a downstream tool) requests the locked dependency set, **Then** a complete, deterministic list — kept libraries with locked versions, replaced libraries with their native replacements, inlined libraries flagged as such — is returned without re-running analysis.

---

### Edge Cases

- What happens when a library is declared but never actually used by any in-scope artifact (dead declaration)? The planner still emits a disposition record for it carrying a usage/scan-limitation note — the default kind is `keep` (the collector never invents a removal; per FR-012, missing evidence degrades toward `keep`, never toward silent pruning), and the operator decides any non-keep outcome explicitly at confirmation time, where the rationale documents the dead-declaration evidence. Nothing is silently dropped from the target set.
- What happens when a library has no Java 17/21 native equivalent and no reasonable inline candidate? The disposition must be keep; the planner must not invent a replacement to avoid a "keep" outcome.
- What happens when the same library is used across multiple modules with different appropriate dispositions (e.g., trivial use in one module, deep use in another)? The disposition model must represent the decision at a granularity that handles this — worst case, the conservative disposition (keep) wins and the rationale notes the split, rather than forcing one module's answer onto all.
- What happens when a re-run of Plan re-scans dependencies after dispositions were already confirmed? Confirmed dispositions must not be silently overwritten; a changed proposal (e.g., a newly detected native equivalent) surfaces as an updated proposal requiring re-confirmation, and the prior confirmed record remains until replaced by a new confirmed one.
- How are version conflicts in the kept set handled (the same library resolvable to different target versions)? The locked set must resolve one version per kept library, with the conflict and resolution recorded in the disposition rationale.
- What happens when dependency scanning cannot parse part of the build manifest or source? The affected libraries are still recorded with an "unresolved scan" note rather than failing the whole Plan run, and they surface in planning-readiness gating until a human dispositions them.
- What happens in an automated run where the operator has pre-declared disposition policy (e.g., "always keep library X")? Pre-declared operator policy should be honored as the confirmation source rather than the planner's proposal, and the record shows that provenance.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: During the Plan phase, the system MUST identify every third-party library used by the in-scope legacy artifacts — from build manifests and source-level (AST) usage — and produce a proposed disposition for each.
- **FR-002**: Each disposition MUST be one of exactly three kinds: **keep** (library carries into the target with a locked version), **replace-with-native** (library is dropped in favor of a named Java 17/21 (or stack-appropriate) native/platform equivalent), or **inline** (library is dropped; its used helper surface will be provided inline in target code — the inlining itself is NOT performed by this feature).
- **FR-003**: Each disposition record MUST carry: the library identity (name/coordinates and current version), the disposition kind, the replacement target where applicable (native equivalent name, or inline note), a human-readable rationale, the proposing actor (planner), the confirming actor, and confirmation timestamp.
- **FR-004**: Disposition records MUST be persisted in the registry as first-class, queryable artifacts — retrievable after Plan completes without re-running any scan, consistent with how dependency findings/strategies are stored today.
- **FR-005**: Disposition proposals MUST pass through an explicit confirmation step modeled on the existing mapping-confirmation and dependency-strategy-approval precedents, including operator override (the operator's chosen disposition and rationale replace the proposal).
- **FR-006**: Unattended/automated runs MUST NOT silently confirm dispositions; an explicit auto-approve option (mirroring the existing benchmark auto-approval precedent) is required, and such confirmations MUST be attributed to an identifiable automated actor.
- **FR-007**: Planning MUST treat libraries lacking a confirmed disposition as unresolved readiness items — blocking full planning sign-off (consistent with existing unresolved dependency-finding gating) — while allowing independent confirmed work to proceed.
- **FR-008**: The system MUST resolve and record a single locked target version per kept library, recording any version-conflict resolution in the rationale.
- **FR-009**: The confirmed disposition set MUST be retrievable as a complete, deterministic locked dependency set (kept libraries + locked versions, replaced libraries + native targets, inlined libraries flagged) suitable as input for the version-locked doc-RAG proposal.
- **FR-010**: Migration-agent context for an artifact whose libraries have replace-with-native or inline dispositions MUST surface those dispositions so generated target code does not re-declare pruned dependencies.
- **FR-011**: Re-running Plan MUST NOT silently overwrite confirmed dispositions; changed proposals require re-confirmation, and the previously confirmed record remains in effect until a new confirmation replaces it.
- **FR-012**: Libraries that are declared but unused, or whose usage cannot be fully scanned, MUST still receive disposition records (with the scan limitation noted), rather than being silently dropped from or silently carried into the target set.
- **FR-013**: Actual inlining of helper logic, AST-level code transformation, and removal of libraries from manifests are OUT OF SCOPE for v1 — this feature produces confirmed records only; the write-side changes are downstream work.

### Key Entities

- **Dependency Disposition Record**: One confirmed decision per third-party library — library identity (name, current version), disposition kind (keep / replace-with-native / inline), replacement target (native equivalent or inline note), locked target version (for keeps), rationale, proposing actor, confirming actor, confirmation timestamp, and supersession link when a re-run replaces a prior decision.
- **Locked Dependency Set**: The derived, deterministic view of all confirmed dispositions for a workspace — the kept libraries with locked versions plus the pruned libraries with their disposition outcomes — consumed by migration agents and the future version-locked doc-RAG feature.
- **Disposition Confirmation Decision**: The operator (or explicitly-authorized automation) confirm/override decision on a proposed disposition, following the existing mapping-confirmation precedent.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After a Plan run on any in-scope workspace, 100% of third-party libraries used by in-scope artifacts have exactly one current disposition record retrievable from the registry without re-scanning.
- **SC-002**: No library reaches the target dependency set without a confirmed disposition — in 100% of test runs, including unattended runs, libraries lacking confirmation appear as unresolved readiness items rather than being silently kept or silently dropped.
- **SC-003**: Validated by a deterministic benchmark test (task T031) that plants 10 known cases (4 with obvious native equivalents, 3 minimal-use helpers, 3 must-keep libraries) and asserts the planner proposes the expected disposition kind for at least 9 of the 10, with every miss still resolved through the confirmation step. The "at least 90%" criterion is realized as "≥9 of 10 planted cases".
- **SC-004**: An operator can retrieve the complete locked dependency set (kept + versions, replaced + native targets, inlined + flags) in a single query in under 5 seconds for a workspace of 500 libraries.
- **SC-005**: The locked dependency set produced by this feature is consumable unchanged by the follow-up version-locked doc-RAG work — i.e., every kept library entry carries a resolved, locked target version, in 100% of cases.

## Assumptions

- "Registry artifact" means stored in the same SQLite registry that already holds dependency findings and dependency strategies — reusing that machinery (extended as needed) rather than introducing a new store. The existing `dependency_strategies` table supports upgrade/replace/remove; this feature's keep/replace-with-native/inline vocabulary is assumed to extend or supersede that strategy vocabulary per-library, with the exact storage mapping decided in the plan phase.
- The confirmation UX is assumed to follow the existing `confirmMappings` / `approveDependencyStrategy` precedent (interactive prompt plus a non-interactive auto-approve flag for benchmark/CI), not a new review UI.
- "AST-level scan" is interpreted as: the planner identifies actual source-level usage of each declared library (imports/usage analysis) to inform dispositions — it does NOT transform code. Dead declarations and minimal-use libraries are detectable this way without full program analysis.
- The doc-RAG integration is a downstream feature: v1's obligation is to produce a well-formed locked dependency set, not to implement the RAG consumer.
- The disposition granularity is per-library per workspace; module-level divergence is handled by conservative resolution (keep) with a noted rationale, unless the plan phase finds a clean per-module model.
- Java 17/21 native equivalents are the primary target stack for "replace-with-native", per the issue; other stacks use stack-appropriate platform equivalents via stack-pack knowledge.
- Automatic inlining of helper logic is explicitly out of scope for v1 per the issue's scope notes.
