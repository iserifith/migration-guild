# Feature Specification: Characterization Test Automation

**Feature Branch**: `002-characterization-test-automation`

**Created**: 2026-08-14

**Status**: Draft

**Input**: User description: "Proposal (issue #58): integrate a step in the Inventory or Plan phase that executes tests against legacy code and captures inputs/outputs as characterization-fixture evidence. These fixtures serve as behavioral snapshots for the Migrate and Arbiter phases, giving Migrate a concrete behavioral target and giving the Arbiter an objective diff instead of pure reviewer judgment. First slice: harvest fixtures for already-tested seams only (legacy code needing a runtime must be harvested from unit/invocation seams, not HTTP)."

**Source issue**: #58 — corrected per owner review comments (see Assumptions): the evidence-type list is a closed set requiring a mechanical extension in three-plus places, `.guild/evidence/` files and registry evidence rows are distinct and require an explicit ingestion call, freshness must reuse the existing evidence-freshness contract rather than invent a new one, and this repo has no bundled sample legacy application.

**Governing document**: `.specify/memory/constitution.md` — principally I (Evidence Over Assertion), III (Registry-Mediated Coordination), IV (Separation of Powers).

## User Scenarios & Testing *(mandatory)*

Primary persona: the **migrate agent**, which needs a concrete behavioral target instead of only forward-written expectations. Secondary persona: the **arbiter**, which needs an objective behavioral diff instead of relying solely on reviewer judgment. Tertiary persona: the **operator**, who triggers fixture capture and inspects what was recorded.

### User Story 1 - Capture a behavioral snapshot from legacy code (Priority: P1)

An operator runs fixture capture against a legacy artifact that already has a passing unit/invocation-level test. The system executes that test seam, records the concrete inputs and outputs the legacy code actually produced, and stores the result as a new `characterization-fixture` evidence record bound to that artifact.

**Why this priority**: without a captured fixture, there is no behavioral ground truth to compare against — every downstream story in this feature depends on this one existing first.

**Independent Test**: point fixture capture at a legacy artifact with an existing passing unit test seam. Delivers value if a `characterization-fixture` evidence record is created, is retrievable for that artifact, and contains the recorded inputs/outputs plus enough identifying data (command, content hash) to know exactly what was captured and from where.

**Acceptance Scenarios**:

1. **Given** a legacy artifact with an already-passing unit/invocation-level test seam, **When** an operator runs fixture capture for that artifact, **Then** a `characterization-fixture` evidence record is created and associated with the artifact.
2. **Given** a captured fixture, **When** an operator inspects it, **Then** it shows the seam that was invoked, the concrete input values, the concrete output values the legacy code produced, and a content hash of that captured output.
3. **Given** a legacy artifact with no passing unit/invocation-level test seam (e.g. it requires a live runtime such as an HTTP server or database), **When** an operator runs fixture capture for that artifact, **Then** capture is skipped for that artifact with a stated reason, rather than failing the whole run or fabricating a fixture.
4. **Given** fixture capture runs twice against the same unchanged legacy seam, **When** an operator compares the two resulting evidence records, **Then** both are recorded (capture does not silently overwrite prior evidence) and each is independently identifiable by its own run and content hash.

---

### User Story 2 - Migrate consults the captured fixture as its behavioral target (Priority: P2)

An agent working the Migrate phase on an artifact that has a captured fixture can retrieve that fixture's recorded inputs/outputs and use them as a concrete target the migrated code must reproduce, instead of relying only on tests written forward from extracted context.

**Why this priority**: this is the first consumer of the fixture and the direct value proposition named in the source proposal — a concrete behavioral target for Migrate.

**Independent Test**: given an artifact with a captured fixture, have the Migrate phase run against it. Delivers value if the migrated output can be checked against the fixture's recorded inputs/outputs and a pass/fail result is produced from that comparison.

**Acceptance Scenarios**:

1. **Given** an artifact with a captured `characterization-fixture`, **When** the Migrate phase produces candidate output for that artifact, **Then** the candidate output can be compared against the fixture's recorded output for the same recorded input, and the comparison result (match / mismatch, with the specific difference) is available.
2. **Given** an artifact with no captured fixture, **When** the Migrate phase runs, **Then** migration proceeds using existing forward-written-test behavior — absence of a fixture is not a blocking condition.

---

### User Story 3 - Arbiter gates on fixture evidence (Priority: P3)

The arbiter reviewing an artifact for approval can see whether a characterization-fixture comparison passed or failed, and that result factors into the same evidence-gated approve/reject decision as other evidence types, using the existing freshness rules rather than a separate check.

**Why this priority**: this closes the loop named in the proposal — an objective diff for the arbiter — but depends on Stories 1 and 2 already existing, and is the natural final consumer.

**Independent Test**: submit an artifact for arbitration where its characterization-fixture comparison failed. Delivers value if arbitration surfaces that failure as evidence rather than requiring the reviewer to independently notice or re-derive it, and if a stale or missing fixture comparison is treated by the same freshness rule already applied to other evidence types.

**Acceptance Scenarios**:

1. **Given** an artifact with a passing characterization-fixture comparison recorded as evidence, **When** the arbiter evaluates approval, **Then** that evidence is available to the approval decision on the same terms as other evidence types.
2. **Given** an artifact with a failing characterization-fixture comparison, **When** the arbiter evaluates approval, **Then** the failure is visible as evidence and does not silently pass.
3. **Given** an artifact whose legacy source changed after its fixture was captured, **When** the arbiter evaluates approval, **Then** the existing evidence-freshness check identifies the fixture as stale using the same content-hash/same-run binding rule already used for other evidence types — not a new or different freshness rule.

---

### Edge Cases

- What happens when a legacy artifact's only available test seam is non-deterministic (e.g. depends on current time, random values, or ordering)? Capture should record what actually ran rather than fail silently, and the non-determinism should be visible to whoever consumes the fixture rather than causing spurious mismatches to be trusted as ground truth.
- How does the system handle a legacy seam whose test requires network, database, or other runtime dependencies unavailable in the capture environment? This is out of scope for the first slice (see Assumptions) — capture must skip and state why, not attempt a partial or fabricated capture.
- What happens when fixture capture is run for an artifact that already has a fixture from a prior run? The prior evidence record is preserved; a new one is added rather than mutating history in place (see Story 1, Scenario 4).
- What happens when the recorded fixture output contains large or binary data? The evidence type's fields for command, exit code, and content hash follow the same conventions as the existing `runtime` evidence type; the specific size handling is an implementation detail out of scope for this specification.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST support a distinct `characterization-fixture` evidence type, recorded in the same evidence store used by other evidence types (test-command, build-command, static-check, review-verdict, benchmark-result, runtime).
- **FR-002**: The system MUST provide a way to execute an already-passing unit/invocation-level test seam against legacy code and capture the concrete inputs and outputs that seam produced.
- **FR-003**: A captured fixture MUST be explicitly recorded as evidence associated with the target artifact — capture producing an artifact on disk alone, without an explicit recording step, does not satisfy this requirement.
- **FR-004**: The system MUST identify, for each captured fixture, the seam invoked, the concrete input, the concrete output, and a content hash of the captured output.
- **FR-005**: When a legacy artifact has no available unit/invocation-level test seam (e.g. it requires a live runtime), the system MUST skip capture for that artifact and state the reason, rather than fail the overall capture run or fabricate a fixture.
- **FR-006**: The system MUST allow the Migrate phase to retrieve a previously captured fixture for a given artifact and compare candidate migrated output against the fixture's recorded output, producing a match/mismatch result with the specific difference on mismatch.
- **FR-007**: Absence of a captured fixture for an artifact MUST NOT block the Migrate phase from proceeding.
- **FR-008**: The Arbiter's evidence-gated approval decision MUST be able to consider characterization-fixture evidence on the same terms as other evidence types.
- **FR-009**: Characterization-fixture evidence MUST be subject to the same freshness rule already applied to other evidence types (content hash of the actual output matching, plus same-run binding) — this feature MUST NOT introduce a second, different freshness mechanism.
- **FR-010**: Re-running capture for an artifact that already has fixture evidence MUST add a new evidence record rather than overwrite or delete the prior one.

### Key Entities

- **Characterization fixture**: A recorded behavioral snapshot of legacy code — the seam invoked, the concrete input supplied, the concrete output actually produced, and a content hash of that output. Represented as a new evidence type in the existing acceptance-evidence store, not as a standalone artifact type.
- **Test seam**: An existing, already-passing unit or invocation-level test entry point into legacy code, through which a fixture can be captured without requiring a live runtime (HTTP server, database, etc.).
- **Fixture comparison result**: The outcome of comparing a Migrate-phase candidate output against a captured fixture's recorded output — match, or mismatch with the specific difference — consumed by both the Migrate phase (as a target) and the Arbiter (as evidence).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For any legacy artifact with an existing passing unit/invocation-level test, an operator can capture a characterization fixture for it and retrieve that fixture's recorded input/output in a single operation.
- **SC-002**: 100% of captured fixtures are individually inspectable — showing seam, input, output, and content hash — without reading raw logs.
- **SC-003**: For artifacts with a captured fixture, the Migrate phase's output is checked against a concrete recorded behavioral target rather than only forward-written expectations, for 100% of such artifacts.
- **SC-004**: When a characterization-fixture comparison fails, that failure is visible in the arbitration evidence for 100% of cases — it is never possible for a failed comparison to be silently absent from an approval decision.
- **SC-005**: Zero characterization-fixture evidence records are treated as fresh once their underlying legacy output has changed — staleness is caught by the existing freshness rule with no exceptions carved out for this evidence type.

## Assumptions

- **Schema change is mechanical, not architectural**: adding `characterization-fixture` requires extending the closed evidence-type enumeration and its associated allowlists/executable-type lists in the existing evidence store — a small, mechanical change in the type definition and a small number of call sites, not a schema redesign. (Corrects the source proposal's claim of "no schema surgery needed.")
- **Two distinct storage layers**: the filesystem evidence directory (where fixture files may be written) and the registry's evidence table (which the Arbiter actually reads) are separate. A fixture is not visible to arbitration until it is explicitly recorded into the registry evidence table — writing a file alone is not sufficient. (Corrects the source proposal's implication that dropping a file under the evidence directory is enough.)
- **Freshness reuses the existing contract**: this feature binds to the evidence-freshness rule already established for other evidence types (content hash of the actual output matching, plus same-run binding) rather than defining its own timestamp-based or otherwise different freshness scheme.
- **No bundled sample legacy application**: this repository is a generic migration framework with no shipped legacy codebase to migrate. This specification is written against "legacy code" in the abstract; validation and any example fixtures used during development must use whatever legacy code a given migration workspace supplies, not a specific named application. (Corrects the source proposal's fabricated reference to "legacy JForum," which does not exist in this repository.)
- **First-slice scope excludes runtime-dependent capture**: legacy code whose only available tests require a live runtime (e.g. HTTP, database) is out of scope for this feature; only already-tested unit/invocation seams are harvested. Runtime-dependent capture is a candidate for a future slice, not this one.
- **Independent of other evidence proposals**: this feature is scoped and delivered independently of other in-flight evidence-related proposals (e.g. the already-merged evidence-freshness/drift-gate foundation); it consumes that existing foundation rather than re-specifying it.
