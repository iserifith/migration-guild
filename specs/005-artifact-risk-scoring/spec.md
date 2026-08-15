# Feature Specification: Automated Risk Scoring for Legacy Artifacts at Inventory Time

**Feature Branch**: `005-artifact-risk-scoring`

**Created**: 2026-08-15

**Status**: Draft

**Input**: User description: "Automated risk scoring for legacy artifacts at inventory time (GitHub issue #60): Add a heuristic scanner in the Inventory phase that scores code complexity and ambiguity for each artifact — reflection usage (Class.forName, Method.invoke), dynamic invocations, God methods / excessive method length, cyclomatic complexity hotspots. Artifacts exceeding configurable thresholds get routed to a \"Deconstruct Agent\" or flagged for mandatory human review before the Migrate phase proceeds. The risk score and reason codes should be computed at registration time (alongside inventory.ts scanAndRegister and classification.ts's existing confidence/ambiguous/evidence/signals metadata pattern) and stored so they are registry-visible, so the planner can order/route work based on them. Thresholds must be configurable per stack pack. Routing above-threshold artifacts should reuse existing wave/claim machinery, following the confirmMappings human-in-the-loop precedent in plan.ts for forcing human confirmation."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See risk scores for every inventoried artifact (Priority: P1)

As a migration operator, after running the Inventory phase, I want every registered artifact to carry a computed risk score and a list of reason codes explaining that score, so I can tell at a glance which parts of the legacy codebase are dangerous to migrate mechanically.

**Why this priority**: This is the foundation the rest of the feature depends on. Without a stored, visible risk score there is nothing for the planner to route on and nothing for a human to review. It also delivers standalone value: an operator can eyeball high-risk artifacts before planning even starts.

**Independent Test**: Run Inventory against a legacy codebase containing at least one artifact with reflection calls, one God method (excessive length), and one cyclomatic-complexity hotspot. Confirm the registry shows a non-zero risk score and matching reason codes for each, and a low/zero score with no reason codes for a plain, simple artifact.

**Acceptance Scenarios**:

1. **Given** a legacy artifact that calls `Class.forName` or `Method.invoke`, **When** the Inventory phase registers it, **Then** the artifact's stored risk data includes a reason code identifying reflection usage and a risk score greater than an artifact with no such calls.
2. **Given** a legacy artifact containing a method far longer than the configured threshold, **When** it is registered, **Then** the artifact's risk data includes a "God method" reason code.
3. **Given** a legacy artifact with a method whose branching complexity exceeds the configured cyclomatic-complexity threshold, **When** it is registered, **Then** the artifact's risk data includes a cyclomatic-complexity reason code.
4. **Given** a straightforward legacy artifact with none of the above traits, **When** it is registered, **Then** its risk score is low/zero and its reason-code list is empty.
5. **Given** an operator inspecting the registry after Inventory completes, **When** they query artifact risk data, **Then** they can see the score and reason codes without re-running any scan.

---

### User Story 2 - Configure risk thresholds per stack pack (Priority: P2)

As a stack-pack maintainer, I want to define the God-method length threshold, cyclomatic-complexity threshold, and the score cutoff that counts as "high risk" for my stack, so that risk scoring reflects realistic norms for that language/framework instead of one-size-fits-all numbers.

**Why this priority**: Different legacy stacks have different normal method lengths and complexity baselines. Hardcoded global thresholds would produce noisy false positives or miss real risk in stacks not yet considered, undermining trust in the score from day one. This depends on User Story 1 existing but is separable — a stack pack can ship sensible defaults if the pack doesn't override them.

**Independent Test**: Configure two different stack packs with different thresholds for the same heuristic (e.g., God-method length), run Inventory against fixtures sized between the two thresholds, and confirm the artifact is flagged as high-risk under the stricter pack's threshold and not flagged under the looser pack's threshold.

**Acceptance Scenarios**:

1. **Given** a stack pack that declares custom risk thresholds, **When** Inventory scores artifacts belonging to that stack, **Then** the pack's thresholds are used instead of any default.
2. **Given** a stack pack that declares no risk thresholds, **When** Inventory scores its artifacts, **Then** reasonable built-in default thresholds are applied and scoring still succeeds.
3. **Given** an artifact whose method length sits between two stack packs' differing thresholds, **When** each pack scores an equivalent artifact, **Then** only the pack with the stricter (lower) threshold flags it as a God method.

---

### User Story 3 - Route high-risk artifacts to mandatory human review before migration (Priority: P1)

As a migration operator, I want artifacts whose risk score exceeds the configured high-risk cutoff to be blocked from proceeding into the Migrate phase until a human explicitly confirms them, so that risky, ambiguous code doesn't get mechanically migrated on the strength of an automated guess alone.

**Why this priority**: This is the enforcement half of the feature and the reason risk scoring exists — a score nobody acts on is just decoration. It's tied for P1 with User Story 1 because the issue's stated intent ("flagged for human review before the Migrate phase") is the actual deliverable; scoring alone doesn't satisfy the proposal.

**Independent Test**: Run Inventory and Plan against a codebase containing one above-threshold artifact and one below-threshold artifact. Confirm the below-threshold artifact proceeds to planning normally, while the above-threshold artifact is held in a pending-confirmation state and only becomes claimable for migration after an operator confirms it (or is skipped if the operator declines).

**Acceptance Scenarios**:

1. **Given** an artifact whose risk score exceeds the stack pack's high-risk cutoff, **When** planning runs, **Then** the artifact is presented to the operator for explicit confirmation before it can be claimed for migration, consistent with the existing mapping-confirmation flow.
2. **Given** an operator confirms a high-risk artifact for migration, **When** the confirmation is recorded, **Then** the artifact becomes claimable through the normal wave/claim machinery like any other artifact.
3. **Given** an operator declines to confirm a high-risk artifact, **When** the decision is recorded, **Then** the artifact does not enter the Migrate phase and its state clearly reflects that it is blocked pending review (or skipped, per operator choice).
4. **Given** an automated/unattended run (no interactive operator available), **When** a high-risk artifact is encountered, **Then** the run does not silently migrate it — it either halts for review or requires an explicit pre-authorized bypass, mirroring the existing auto-confirm precedent for mapping confirmation.
5. **Given** an artifact at or below the high-risk cutoff, **When** planning runs, **Then** it proceeds through the normal flow with no additional confirmation step.

---

### User Story 4 - Planner orders work using risk visibility (Priority: P3)

As a migration operator, I want the planner to be able to see and use risk scores when it orders or groups work into waves, so that low-risk, mechanical artifacts can be planned and migrated first while high-risk artifacts are surfaced for attention rather than blocking the whole run.

**Why this priority**: This is an optimization on top of the core scoring-and-gating behavior (User Stories 1 and 3). The feature is coherent and useful without wave ordering being risk-aware, so it's lower priority, but the issue explicitly calls out "so the planner can order/route on it."

**Independent Test**: Run planning against a mixed-risk artifact set and confirm low-risk artifacts are assigned to earlier waves than unresolved high-risk artifacts, without needing to change the confirmation gate from User Story 3.

**Acceptance Scenarios**:

1. **Given** a set of artifacts with mixed risk scores, **When** the planner assigns waves, **Then** artifacts pending high-risk confirmation are not placed ahead of confirmed lower-risk work that has no dependency requiring otherwise.
2. **Given** a high-risk artifact has been confirmed by an operator, **When** the planner next runs, **Then** it is eligible for wave assignment like any confirmed artifact.

---

### Edge Cases

- What happens when an artifact's source can't be parsed well enough to compute cyclomatic complexity (e.g., malformed or unsupported syntax)? The artifact must still be registered; the affected heuristic contributes no score rather than blocking inventory, and a reason code notes the heuristic couldn't run.
- How does the system handle a stack pack that sets a threshold to an invalid value (e.g., negative length, cutoff below zero)? Configuration validation must reject it with a clear error rather than silently producing nonsensical scores.
- What happens when an artifact is re-scanned after a legacy-side change (not expected, since legacy is read-only, but the registration might be re-run)? The risk score and reason codes must be recomputed and replace the prior stored values, not accumulate.
- What happens to an artifact that was already confirmed under an older, looser threshold, if the stack pack's thresholds are later tightened? Existing confirmations remain valid for that artifact; only newly scored/re-scored artifacts are judged against the new thresholds, so a re-inventory could re-surface it for review if the score changes.
- How does dynamic-invocation detection avoid flooding every artifact with false positives in languages where a particular pattern is idiomatic and low-risk? Reason codes must be specific enough (e.g., which construct, where) that an operator can judge relevance, and stack packs must be able to tune or disable individual heuristics.
- What happens when two operators attempt to confirm or decline the same high-risk artifact concurrently? Only one decision is recorded; the mechanism follows the same conflict handling already used for mapping confirmation.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST compute a risk score and an associated list of reason codes for every artifact at the point it is registered during the Inventory phase.
- **FR-002**: The system MUST detect reflection/dynamic-invocation usage (including at minimum `Class.forName`-style and `Method.invoke`-style calls, and stack-appropriate equivalents) as a contributing risk signal with its own reason code.
- **FR-003**: The system MUST detect "God methods" — methods whose length exceeds a configurable threshold — as a contributing risk signal with its own reason code.
- **FR-004**: The system MUST detect cyclomatic-complexity hotspots — methods whose branching complexity exceeds a configurable threshold — as a contributing risk signal with its own reason code.
- **FR-005**: The system MUST combine individual signal detections into a single overall risk score per artifact using a documented, deterministic method (not left as an unspecified black box).
- **FR-006**: The system MUST persist the risk score and reason codes so they are visible by querying artifact records after Inventory completes, without needing to re-run the scan.
- **FR-007**: The system MUST allow each stack pack to configure its own thresholds for each risk heuristic (God-method length, cyclomatic-complexity limit, and the score cutoff that defines "high risk").
- **FR-008**: The system MUST apply reasonable built-in default thresholds when a stack pack does not specify its own.
- **FR-009**: The system MUST reject stack-pack risk configuration that is structurally invalid (e.g., negative or non-numeric thresholds) with a clear, actionable error at load time.
- **FR-010**: The system MUST prevent an artifact whose risk score exceeds its stack pack's high-risk cutoff from being claimed for migration until a human has explicitly confirmed it, following the same human-in-the-loop confirmation pattern already used for mapping confirmation.
- **FR-011**: The system MUST allow an operator to confirm a high-risk artifact (unblocking it for normal claim/migration) or decline it (leaving it blocked/skipped), and MUST record that decision durably.
- **FR-012**: The system MUST NOT allow unattended/automated runs to silently bypass high-risk confirmation; an explicit, deliberate override mechanism (mirroring the existing auto-confirm precedent) is required for automation to proceed past a high-risk artifact.
- **FR-013**: The system MUST leave artifacts at or below the high-risk cutoff unaffected by the confirmation gate — they proceed through the existing planning/claim flow unchanged.
- **FR-014**: The system MUST make risk score and reason codes available to the planning step so that work ordering/routing can take risk into account.
- **FR-015**: The system MUST recompute and replace (not accumulate) an artifact's risk score and reason codes whenever that artifact is re-registered.
- **FR-016**: The system MUST record, for each risk signal that could not be evaluated (e.g., due to unparseable source), a reason code indicating the signal was skipped rather than silently omitting it or failing the whole registration.

### Key Entities

- **Artifact Risk Assessment**: Represents the computed risk profile of one inventoried artifact — an overall numeric score, a list of reason codes (each identifying which heuristic fired and enough detail to act on it), and a link back to the artifact it describes. Conceptually alongside the existing classification metadata (module, role, framework, confidence, evidence, signals) already computed at registration time.
- **Risk Threshold Configuration**: Represents the per-stack-pack configurable limits — God-method length limit, cyclomatic-complexity limit, and high-risk score cutoff — plus the defaults used when a stack pack doesn't override them.
- **High-Risk Confirmation Decision**: Represents an operator's recorded confirm/decline decision for a specific high-risk artifact, gating whether that artifact may be claimed for the Migrate phase.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After running Inventory on a legacy codebase, 100% of registered artifacts have a stored risk score and reason-code list retrievable without re-scanning.
- **SC-002**: In a test codebase with known-risky constructs (reflection, God methods, complexity hotspots) planted alongside known-simple artifacts, the scanner correctly flags at least 95% of the planted risky constructs with a matching reason code and produces zero reason codes for at least 95% of the planted simple artifacts.
- **SC-003**: No artifact scoring above a stack pack's high-risk cutoff reaches the Migrate phase's claim pool without a recorded human confirmation decision — verified across all test runs, including automated/unattended runs.
- **SC-004**: Operators can change a stack pack's risk thresholds and see the effect (different artifacts flagged/unflagged) on the next Inventory run without any code change, in under the time it takes to edit one configuration file and re-run Inventory.
- **SC-005**: A run that hits a high-risk artifact under full automation halts or is explicitly and deliberately unblocked — it never proceeds past that artifact silently, in 100% of tested cases.

## Assumptions

- "Registry-visible" means retrievable through the same registry mechanism (database/records) that already exposes artifact and classification data — not a separate report or file.
- The human-in-the-loop confirmation gate for high-risk artifacts is modeled on the existing mapping-confirmation precedent (interactive prompt with an explicit non-interactive override flag for automated benchmark/CI use), rather than inventing a new review UI.
- A dedicated "Deconstruct Agent" (a distinct downstream agent specialized in decomposing high-risk artifacts) is a possible future routing target mentioned in the originating proposal, but is out of scope for this spec; this spec covers scoring, threshold configuration, and the mandatory human-confirmation gate. Routing to a specialized agent type can be layered on later using the same risk data.
- Wave/planning ordering by risk (User Story 4) is a lower-priority enhancement; the core deliverable is that risk data exists, is stored, and gates migration — not that it fully reorders waves.
- Reflection/dynamic-invocation detection is heuristic (pattern/AST-based), not a full static-analysis guarantee; it aims for practically useful signal, not exhaustive proof of absence.
- Existing artifacts and stack packs with no risk configuration continue to function; default thresholds ensure the feature doesn't break existing workflows when adopted.
