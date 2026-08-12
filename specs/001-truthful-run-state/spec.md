# Feature Specification: Truthful Run State

**Feature Branch**: `001-truthful-run-state`

**Created**: 2026-07-31

**Status**: Draft

**Input**: User description: "One consolidated feature covering selected slices of issues #49, #50, #52, and #53 for the Migration Guild kit. Theme: a migration run must tell the truth about its own state — what was actually verified, what actually ran, which model/provider/harness was actually used, and where configuration values actually came from. In scope: (1) #49 selected reliability slices only — wrong timeout knob / misleading kill message, dead analyze-context paths with stored-summary fallback, orphan child-process cleanup, and accurate claim/run cleanup reporting; (2) #50 truthful per-artifact completion and bounded verification; (3) #52 resolved-harness/model doctor validation; (4) #53 environment precedence and visibility, where project-local `.env` values win by default, inherited/ambient overrides require explicit opt-in, and divergence is always reported. Excluded: #43 Phase 0 excision, #48 quarantine architecture, #51 as-written absolute/relative diagnosis, and closed issues #40/#44/#45."

**Source issues**: #49 (selected slices), #50, #52, #53 — captured in `/tmp/migration-guild-truthful-run-state-issues.json`.

**Governing document**: `.specify/memory/constitution.md` v1.0.0 — principally I (Evidence Over Assertion), III (Registry-Mediated Coordination), IV (Separation of Powers), VI (Fail-Closed Automation), VII (Pluggable Stacks, Neutral Providers).

## User Scenarios & Testing *(mandatory)*

Primary persona: the **operator** — a person running the kit against a migration workspace, reading its output, and deciding what to do next. Secondary persona: the **kit maintainer**, who must be able to reproduce an operator's run from checked-in artifacts alone.

### User Story 1 - `migrated` stops meaning "maybe compiles" (Priority: P1)

An operator finishes a migration wave and reads recorded state: 271 of 373 artifacts are `migrated`. They then build the modernized tree and get 137 errors. Nothing in the recorded state, the run summaries, or the status output distinguished artifacts whose own output was actually checked from artifacts that an agent merely declared finished — several agents had explicitly stated in their own transcripts that they could not verify their work, and were still recorded as successful.

After this feature, migration status and verification status are two separate recorded facts. Every artifact that reaches `migrated` carries whether its own output was checked, by what method, and when — with an explicit *unverified* state rather than silence. Verification is bounded to the claimed unit and its declared dependencies, so it never waits on a tree-wide successful build, and never blocks an artifact whose neighbours simply have not been migrated yet.

**Why this priority**: this is the direct violation of the project's non-negotiable first principle — status advancing on an agent's self-report. Every other slice in this feature makes a *diagnosis* faster; this one stops the system from asserting something untrue about the work product itself.

**Independent Test**: run a migration wave against a workspace whose overall build cannot succeed, then query status. Delivers value if artifacts still advance, every advanced artifact reports a verification state and reason, and the verified/unverified split is visible without reading logs.

**Acceptance Scenarios**:

1. **Given** an artifact whose own output passes a bounded per-unit check, **When** the agent completes its claim, **Then** the artifact records migration status advanced *and* verification state *verified*, with the method and timestamp.
2. **Given** an artifact whose own output cannot be checked because unrelated artifacts have not been migrated yet, **When** the agent completes its claim, **Then** the artifact advances and records verification state *unverified* with a reason identifying the tree-incomplete condition — not *verified*, and not blocked — and the run summary states that verification state rather than reading as a verified completion.
3. **Given** an artifact whose own output fails its bounded per-unit check, **When** the agent completes its claim, **Then** the artifact records verification state *verification-failed* with the failure detail, and the condition is visible to review and arbitration.
4. **Given** a workspace mid-migration, **When** an operator asks for status, **Then** the output reports counts of verified, unverified, and verification-failed artifacts, and the operator can list the artifacts in each state.
5. **Given** a bounded verification that exhausts its wall-clock budget, **When** the budget elapses, **Then** verification stops, the artifact records *unverified* with reason "budget exhausted", and the agent still closes its claim normally.
6. **Given** an agent whose work requires a change outside its authorized output paths, **When** the attempt closes, **Then** the artifact carries a named blocked condition identifying the out-of-scope path, and does not advance as if complete with the change silently reverted.

---

### User Story 2 - Preflight fails when the run would fail (Priority: P2)

An operator runs the preflight check before a wave. It reports green on model, harness, and credential. Every agent session then dies within seconds against an inactive-credential rejection. The green ticks did not merely fail to warn — they actively redirected the investigation into recorded state, the claim lifecycle, and the workspace boundary warden, none of which were involved. Each check had asserted a *different object* than the run uses: that a configured string was non-empty, that an adapter program starts, and that a credential variable is set — never that the resolved path can obtain a model response.

After this feature, preflight exercises the same resolution and the same environment a phase run will use, issues one minimal end-to-end request, and asserts on the response. It reports the harness, provider, and model actually resolved, and flags any divergence from what the project configuration declares even when the call succeeds.

**Why this priority**: a misleading green is worse than no preflight. This slice converts the most expensive failure mode — a full drain cycle spent diagnosing the wrong subsystem — into a verdict returned in seconds, before any artifact is claimed.

**Independent Test**: configure a credential that is set but not usable, point the ambient environment at a different model than the project configuration declares, and run preflight. Delivers value if preflight fails, names the credential/provider stage as the cause, and prints the resolved provider and model.

**Acceptance Scenarios**:

1. **Given** a credential that is present but rejected by the provider, **When** the operator runs preflight, **Then** preflight reports a failing verdict naming the authorization stage and the provider-reported reason.
2. **Given** a fully working configuration, **When** the operator runs preflight, **Then** it reports a passing verdict and prints the resolved harness, provider, and model.
3. **Given** a resolved model that differs from the model declared in project configuration, **When** preflight succeeds, **Then** it still reports the divergence, naming the setting, the declared value, and the resolved value.
4. **Given** an operator working air-gapped or budget-constrained, **When** they run preflight in offline mode, **Then** live calls are skipped and the affected results are labelled as unvalidated rather than passing.
5. **Given** a provider that accepts the connection but never responds, **When** preflight's bounded time budget elapses, **Then** preflight reports a failing verdict citing the elapsed budget rather than hanging.
6. **Given** any preflight run, **When** it reports on a credential, **Then** it names the credential setting involved and never prints the credential value.

---

### User Story 3 - The project file wins, and every divergence is spoken aloud (Priority: P3)

An operator's checked-in project environment file declares one provider; a machine-level variable set months ago declares another; the project configuration declares a third model. The run used the machine value. Nothing said so. Two developers with identical checkouts got different providers, and the only trace was a line in a session banner nobody reads.

After this feature, project-local environment values take precedence by default, ambient precedence requires an explicit opt-in, and any variable defined in both places with differing values is always reported — variable name, both values, and the winner — whichever side won and whether or not the opt-in is active. Every phase run additionally announces the provider and model actually in effect at start.

**Why this priority**: this is the mechanism that produced the divergence User Story 2 exists to catch. Fixing precedence makes a checkout self-describing and reproducible across machines; the always-on divergence report means the remaining ambiguity is visible rather than silent.

**Independent Test**: set a variable to one value in the project environment file and a different value in the ambient environment, then run any phase. Delivers value if the project value is used, the divergence line names both values and the winner, and the run start line reports the resolved provider and model.

**Acceptance Scenarios**:

1. **Given** a variable defined in both the project environment file and the inherited environment, **When** a run starts without the ambient opt-in, **Then** the project value is used and a divergence report names the variable, both values, and the project file as winner.
2. **Given** the same setup, **When** the operator explicitly opts in to ambient precedence, **Then** the ambient value is used and the divergence report names the ambient environment as winner.
3. **Given** a diverging variable that carries a credential, **When** the divergence is reported, **Then** the variable is named and the winner stated, and neither value is printed in clear text.
4. **Given** any phase run, **When** it starts, **Then** it reports the resolved provider and model, and states whether they diverge from the project configuration declaration.
5. **Given** two machines with identical checkouts and different ambient environments, **When** each runs the same phase without the opt-in, **Then** both resolve the same provider and model.
6. **Given** an operator arriving from a version with the previous precedence, **When** they consult operator-facing documentation and the maintainer changelog, **Then** both state the precedence rule, the ambient opt-in, and that this is a change in behaviour.

---

### User Story 4 - Kill messages name the real knob, summaries name the real outcome (Priority: P4)

An agent is stopped at its wall-clock ceiling. The message tells the operator to raise a project-configuration ceiling setting. The operator raises it. Nothing changes, because per-phase limits — phase-specific knobs with their own built-in defaults — always take precedence over that setting. Meanwhile the attempt's closing summary reads like an orderly finish: the claim was released, an exit was recorded. It does not say that no files were written, that the artifact's status did not move, and that provider budget was spent and is not coming back.

After this feature, a limit message names the knob that actually governed the limit that fired, its effective value, and where that value came from; the precedence order is inspectable before a run. The closing summary states files written, status transition, claim disposition, and budget consumption in one place, and never labels a no-progress termination with a success-equivalent outcome.

**Why this priority**: both halves are cheap to deliver and remove a recurring class of wasted operator action — tuning a setting that does nothing, and reading a terminated attempt as a completed one.

**Independent Test**: run a phase with a deliberately short per-phase limit and let an agent hit it. Delivers value if the message names the phase knob (not the overridden project-configuration setting) with its effective value and source, and the summary reports zero files written, no status advance, and spent budget.

**Acceptance Scenarios**:

1. **Given** a per-phase limit that overrides the project-configuration ceiling, **When** an agent is terminated at that limit, **Then** the message names the per-phase knob, its effective value, and its source.
2. **Given** the message from the previous scenario, **When** the operator changes the named knob and re-runs, **Then** the observed limit changes accordingly.
3. **Given** any configured workspace, **When** the operator inspects effective limits before a run, **Then** each phase's effective limit and its source are reported, along with the precedence order.
4. **Given** an attempt terminated at a limit that wrote no files, **When** the attempt closes, **Then** the summary states files written = none, artifact status unchanged (from → to identical), claim released and retryable, and that spent provider budget is not recovered.
5. **Given** the same terminated attempt, **When** an operator later queries recorded state without reading logs, **Then** the recorded claim and run reflect the terminal reason, that no outputs were produced, and the artifact's status after cleanup.
6. **Given** an artifact that has accumulated several terminated-without-progress attempts, **When** an operator reviews the workspace, **Then** that repetition is visible as a counted condition rather than something reconstructable only from log timestamps.

---

### User Story 5 - Nothing keeps spending after the kill (Priority: P5)

An agent is terminated at its ceiling. Only the process directly launched receives the signal; the underlying harness binary it started survives, is re-parented, and keeps consuming provider budget — after the claim has already been released and the operator has been told the attempt is over.

After this feature, terminating an attempt terminates everything that attempt started: graceful first, forced after a bounded grace period, then confirmed. Anything that survives is reported as a cleanup failure, and claim release is never presented as proof that spending stopped.

**Why this priority**: the correctness damage is bounded — the claim is already recoverable — but the cost accrues silently and indefinitely, and silent unbounded cost is exactly what the fail-closed principle exists to prevent.

**Independent Test**: force a ceiling termination and inspect running processes afterward. Delivers value if no process started by that attempt is still alive shortly after termination, and any survivor is named in the run output.

**Acceptance Scenarios**:

1. **Given** an agent attempt that started additional processes, **When** the attempt is terminated for any reason, **Then** no process started by that attempt is still running after the grace period.
2. **Given** a process that ignores graceful termination, **When** the bounded grace period elapses, **Then** it is forcibly terminated.
3. **Given** a process that cannot be terminated at all, **When** cleanup completes, **Then** the run reports it as a cleanup failure and identifies the survivor.
4. **Given** any terminated attempt, **When** the run reports the claim as released, **Then** it reports the process-cleanup outcome alongside it, so a released claim is never read as "spending has stopped".

---

### User Story 6 - Agents always receive usable context (Priority: P6)

An agent asks for the analysis context recorded for its artifact and receives a stored location that does not exist on this host — recorded on a different operating system, or pointing into a tree that was never carried over. A usable written summary is sitting in the same record. The agent spends minutes converting separators, hunting for the file, and eventually falls back to reading legacy source — or, in the worst observed case, never produces the deliverable at all before its ceiling.

After this feature, context retrieval always returns something usable when a record exists — the stored file when it can be located here, otherwise the stored summary content — and always labels which of the two it returned.

**Why this priority**: it is the smallest slice and the most contained, but it converts a recurring multi-minute stall at the start of an agent's work into a single deterministic answer.

**Independent Test**: request context for an artifact whose recorded location does not resolve on the current host but whose summary is present. Delivers value if usable summary content is returned and labelled as such, with no path-repair work left to the caller.

**Acceptance Scenarios**:

1. **Given** a context record whose file exists on this host, **When** context is requested, **Then** the file is returned, labelled as a located file, with a location that resolves as written on this host.
2. **Given** a context record whose file cannot be located here but whose summary is present, **When** context is requested, **Then** the stored summary content is returned and labelled as a summary fallback.
3. **Given** a context record written on a different operating system whose underlying file is present here, **When** context is requested, **Then** it resolves without the caller performing any location conversion.
4. **Given** an artifact with neither a locatable file nor a stored summary, **When** context is requested, **Then** the response states that explicitly and names the documented fallback, rather than returning a location that does not exist.
5. **Given** the agent guidance shipped with the kit, **When** an agent follows it to obtain context, **Then** it is told to consume the returned context directly and is not asked to repair, convert, or search for stored locations itself.

---

### Edge Cases

- **Verification budget exhausted mid-check**: recorded as *unverified* with reason, claim still closed, no retry loop.
- **Whole tree cannot build for reasons unrelated to the claimed artifact**: artifact still advances; verification recorded *unverified* with the tree-incomplete reason. Advancement is never gated on tree-wide success, because advancement is what eventually makes the tree build.
- **Agent blocked by a change outside its authorized output paths** (for example a dependency declaration in a build file it may not write): the blockage is reported as a named condition identifying the out-of-scope path, instead of the change being silently reverted while the artifact still advances. Broadening write authorization is explicitly not the remedy.
- **Preflight run with no credential configured at all**: fails on the resolution stage and says which value is missing — it does not fall through to a live call.
- **Preflight in offline mode**: passes structurally but labels live-dependent results as unvalidated; it must not report a plain green.
- **Provider reachable but the resolved model is unknown to it**: preflight fails on model availability, distinctly from an authorization failure.
- **Ambient opt-in enabled but no divergence exists**: nothing to report beyond the normal resolved provider/model line.
- **A diverging variable holds a credential**: named and attributed, values redacted.
- **Project environment file absent entirely**: ambient values apply as before; the resolved provider and model are still reported at run start.
- **Termination while the agent is between processes**: cleanup still confirms no survivors and reports success with zero survivors.
- **Survivor process that cannot be terminated** (permission or platform limit): reported as a cleanup failure with the survivor identified; the claim is still released so the work stays recoverable.
- **Context record whose summary is empty rather than absent**: treated as no summary — the explicit no-context response applies.
- **Limit fired is the inactivity limit rather than the ceiling**: the message names the inactivity knob and its source, under the same rule.
- **Operator sets a per-phase knob below the enforced minimum**: the effective value actually applied is reported, not the requested one.
- **Neither a warden snapshot nor a usable git diff is available**: the attempt records `files_written_source = unavailable` and an explicitly undetermined file count; it MUST NOT present a false zero as evidence that no files were written.

## Requirements *(mandatory)*

### Functional Requirements

#### A. Truthful completion and bounded verification *(source: issue #50)*

- **FR-001**: System MUST record a verification state for each artifact that is a distinct fact from its migration status, taking exactly one of: *verified*, *unverified*, or *verification-failed*.
- **FR-002**: System MUST record, with each verification state, the method used, the time it was determined, and — for *unverified* and *verification-failed* — a machine-readable reason. An artifact with no verification attempt MUST read as *unverified*, never as blank or absent.
- **FR-003**: Verification MUST be scoped to the claimed artifact's own output plus its directly declared dependencies. System MUST NOT require a tree-wide successful build as a precondition for advancing an artifact.
- **FR-004**: Verification MUST run within a bounded, configurable wall-clock budget whose effective value is reported. When the budget elapses, verification MUST stop, the artifact MUST record *unverified* with reason "budget exhausted", and the agent MUST still close its claim.
- **FR-005**: Verification MUST NOT perform unbounded filesystem searches, and MUST NOT read or search outside the workspace.
- **FR-006**: When verification cannot complete because other artifacts are not yet migrated, System MUST record *unverified* with a reason identifying that condition, MUST NOT record *verified*, and MUST NOT block the artifact from advancing.
- **FR-007**: When an agent reports it could not verify its own output, the run outcome MUST NOT read as a verified completion; the run summary MUST state the artifact's verification state.
- **FR-008**: Operators MUST be able to obtain counts of verified, unverified, and verification-failed artifacts, and to list the artifacts in each state, from status output.
- **FR-009**: Verification state and reason MUST be visible to the review and arbitration stages, which MUST be able to treat *unverified* and *verification-failed* as triageable conditions.
- **FR-010**: When an agent's work is blocked by a required change outside its authorized output paths, System MUST report that blockage as a named condition on the artifact identifying the out-of-scope path, rather than reverting the change silently while still allowing the artifact to advance as if complete.

#### B. Preflight that validates the resolved path *(source: issue #52)*

- **FR-011**: Preflight MUST validate the resolved provider base URL, model, credential variable, and launch environment a phase run will use, through the same `resolveAgentLaunch()` function as the runner; when the selected harness requires an adapter, adapter reachability MUST also be checked during resolution.
- **FR-012**: Preflight MUST issue one minimal model request directly through the resolved provider base URL/model using the resolved launch environment and assert on a non-empty response. Proving that an adapter program starts MUST NOT count as a passing model or harness check; adapter fidelity beyond reachability is intentionally outside this hermetic provider-mapping probe.
- **FR-013**: Preflight MUST report the resolved harness, provider, and model that a run would use.
- **FR-014**: When any resolved value differs from the corresponding value declared in project configuration, preflight MUST report the divergence — naming the setting, the declared value, and the resolved value — including when the live check succeeds.
- **FR-015**: Preflight MUST return a failing verdict, not a passing or warning verdict, whenever the resolved path cannot obtain a model response — including unreachable endpoint, rejected or inactive credential, exhausted quota, and unknown model.
- **FR-016**: A failing preflight MUST name the stage that failed (resolution, authorization, model availability, or response) and include the provider-reported reason when one is available.
- **FR-017**: The live portion of preflight MUST complete within a bounded time budget, defaulting to at most 30 seconds, and MUST return a failing verdict if that budget elapses.
- **FR-018**: Preflight MUST offer an explicit offline mode that performs no live calls, and MUST label every live-dependent result as unvalidated when that mode is used.
- **FR-019**: Preflight MUST redact credential values in all output while still naming the credential setting involved.

#### C. Environment precedence and visibility *(source: issue #53)*

- **FR-020**: Values defined in the project-local environment file MUST take precedence over inherited/ambient environment values by default.
- **FR-021**: Operators MUST be able to opt in explicitly to ambient precedence. Absent that explicit opt-in, ambient values MUST NOT override project-local values.
- **FR-022**: Whenever a variable is defined both in the project-local environment file and in the inherited environment with differing values, System MUST report the variable name, both values, and which source won — regardless of which won and regardless of whether the opt-in is active.
- **FR-023**: Divergence reporting MUST redact the values of variables carrying credentials or secrets, while still naming the variable and stating which source won.
- **FR-024**: At the start of every phase run, System MUST report the resolved provider and model actually in effect.
- **FR-025**: When the resolved provider or model differs from the project configuration declaration, the run-start report MUST state that divergence.
- **FR-026**: The precedence rule, the ambient opt-in, and the fact that this changes previous behaviour MUST be stated in operator-facing documentation and recorded in the maintainer changelog.

#### D. Accurate limits and honest run outcomes *(source: issue #49, slices a and d)*

- **FR-027**: When an agent is terminated for exceeding a limit, the message MUST name the specific knob that governed the limit that fired, its effective value, and the source of that value (per-phase setting, environment override, project configuration, or built-in default). The environment override tier includes `GUILDCTL_AGENT_CEILING_SECONDS` for ceiling limits and `GUILDCTL_INACTIVITY_TIMEOUT_SECONDS` for inactivity limits.
- **FR-028**: The knob named in a termination message MUST be one that changes the observed limit when the operator changes it. System MUST NOT direct an operator to a setting that resolution precedence overrides.
- **FR-029**: Effective per-phase limits, their sources, and the precedence order between them MUST be inspectable before a run and documented in operator-facing documentation.
- **FR-030**: The closing summary of every agent attempt MUST state in one place: how many files were written, the artifact status transition (from → to), the claim disposition, and whether provider budget was consumed. When neither a warden snapshot nor a usable git diff is available, it MUST state that the file count is undetermined and record `files_written_source = unavailable`; a false zero count is non-conforming.
- **FR-031**: An attempt terminated without producing files and without advancing status MUST NOT carry a success-equivalent outcome label. The summary MUST distinguish "the work was safely released and can be retried" from "the agent attempt succeeded".
- **FR-032**: The summary of a terminated attempt MUST state explicitly that provider budget consumed by that attempt is not recovered.
- **FR-033**: Claim and run records written during cleanup MUST reflect the terminal reason, whether outputs were produced, and the artifact's status after cleanup, such that those questions are answerable from recorded state without reading logs.
- **FR-034**: Repeated terminated-without-progress attempts on the same artifact MUST be visible to operators as a counted, queryable condition.

#### E. Complete termination of agent process trees *(source: issue #49, slice c)*

- **FR-035**: Terminating an agent attempt MUST terminate every process that attempt started, not only the process launched directly.
- **FR-036**: Termination MUST request graceful shutdown first and escalate to forced termination after a bounded grace period.
- **FR-037**: After termination, System MUST confirm that no process from that attempt remains running, and MUST identify any that do.
- **FR-038**: A surviving process MUST be reported as a cleanup failure rather than omitted, and MUST NOT be treated as an acceptable outcome.
- **FR-039**: When a run reports a claim as released, it MUST report the process-cleanup outcome alongside it, so that a released claim is never readable as evidence that provider spending has stopped.

#### F. Always-usable agent context *(source: issue #49, slice b)*

- **FR-040**: When a context record exists for an artifact, context retrieval MUST return usable context: the stored file when it can be located on the current host, otherwise the stored summary content.
- **FR-041**: Context retrieval MUST label which form it returned — located file or summary fallback — so the caller never has to infer it.
- **FR-042**: Stored context locations MUST be interpreted portably across host operating systems, so that a record written on one host resolves on another whenever the underlying file is present.
- **FR-043**: When neither a locatable file nor a non-empty stored summary exists, retrieval MUST say so explicitly and name the documented fallback, rather than returning a location that does not exist.
- **FR-044**: Agent guidance shipped with the kit MUST direct agents to consume the returned context directly, and MUST NOT require agents to repair or convert stored locations themselves.

### Key Entities

- **Artifact Verification Record**: for one artifact — verification state (*verified* / *unverified* / *verification-failed*), method, determination time, and reason. Distinct from, and never a substitute for, the artifact's migration status.
- **Verification Scope**: the claimed artifact's own output plus its directly declared dependencies; the unit a bounded check is allowed to cover. Explicitly not the whole modernized tree.
- **Attempt Outcome**: for one agent attempt — files written, artifact status transition, claim disposition, terminal reason, whether provider budget was consumed, and process-cleanup result.
- **Effective Limit**: for one phase — the limit that will actually be enforced, its value, its source, and its position in the precedence order.
- **Attempt Process Set**: every process an agent attempt started, tracked well enough that termination and survivor confirmation can cover all of them.
- **Resolved Runtime Configuration**: the harness, provider, and model a run will actually use, as opposed to the values declared in project configuration.
- **Environment Value Divergence**: one variable defined in more than one source with differing values — variable name, each source's value (redacted where secret), and the winning source.
- **Agent Context Record**: for one artifact and agent — a stored location and a stored summary, either of which may be the usable one on a given host.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of runs whose resolved credential, provider, or model cannot serve a request are stopped by preflight before any artifact is claimed, with a verdict returned within 30 seconds.
- **SC-002**: When a run is unusable because of provider, credential, or model state, preflight output names that stage as the cause in 100% of cases — an operator is never sent to recorded state, the claim lifecycle, or workspace-boundary subsystems for a provider-side failure.
- **SC-003**: Given identical checkouts and differing ambient environments, two machines resolve the same provider and model in 100% of runs unless ambient precedence is explicitly opted in.
- **SC-004**: 100% of variables defined in both the project environment file and the inherited environment with differing values are reported with both values and the winner; 0 secret values appear unredacted in any output.
- **SC-005**: 0 artifacts hold a completed migration status without an accompanying verification state, and an operator can obtain the verified / unverified / verification-failed split for a workspace from a single status query.
- **SC-006**: Per-artifact verification completes within its configured budget in at least 95% of attempts and exceeds it in 0%; 0 verification attempts read or search outside the workspace.
- **SC-007**: In a workspace whose tree-wide build cannot succeed, 0 artifacts are blocked from advancing solely because other artifacts are not yet migrated.
- **SC-008**: For 100% of phase-and-limit combinations, the knob named in a termination message changes the observed limit when the operator changes it.
- **SC-009**: 0 processes started by a terminated attempt remain running after the grace period; 100% of exceptions are named in that run's output.
- **SC-010**: An operator can determine whether an attempt wrote files, advanced artifact status, and consumed provider budget from the closing summary alone, in 100% of attempts, without opening logs or querying recorded state.
- **SC-011**: For artifacts holding a context record, context retrieval returns usable content in 100% of requests, and time spent acquiring context drops to under 30 seconds per attempt (from the several minutes observed on hosts where stored locations did not resolve).
- **SC-012**: Across a full wave, the number of attempts that consume provider budget while producing neither files nor a status advance is reported per artifact, so repeat waste is identifiable without log forensics.

## Assumptions

- **Settled product decision — environment precedence**: project-local environment file values win by default; ambient precedence requires an explicit opt-in; divergence is always reported regardless of winner or opt-in state. This was decided before specification and is not reopened here.
- Operators are the primary audience for every output described. Kit maintainers are secondary and are served by the same records being reproducible from a checkout.
- "Verification" for an artifact means a bounded, per-unit check of that artifact's own output, using whatever check the workspace's stack pack defines. The specific check is a stack concern, not a core concern, consistent with the constitution's pluggable-stacks principle.
- A mid-migration modernized tree is expected not to build. Any requirement that would gate advancement on tree-wide success is therefore invalid by construction, since advancement is what eventually makes the tree build.
- Existing coordination machinery — recorded migration state, atomic claims with tokens and leases, evidence records, the arbitration gate, and the workspace boundary warden — remains in place. This feature adds recorded facts and corrects reporting; it does not replace those mechanisms.
- Claim recoverability outranks cleanup completeness: a claim is still released when process cleanup fails, so that work never deadlocks; the cleanup failure is reported separately.
- The bounded preflight budget default of 30 seconds is derived from the observed cost of an equivalent manual check (roughly 8 seconds) with margin for slow providers.
- Existing per-phase limit knobs and the project-configuration ceiling setting both remain available. This feature fixes which one is named and makes the precedence discoverable; it does not change which knobs exist. The environment override tier uses `GUILDCTL_AGENT_CEILING_SECONDS` and `GUILDCTL_INACTIVITY_TIMEOUT_SECONDS`; malformed timeout input normalizes to the built-in default before enforcement rather than propagating `NaN`.
- Any behaviour visible to agents in installed workspaces — context retrieval responses, close-out expectations, verification reporting — is shipped through the kit's packaged agent artifacts, so those artifacts are updated as part of delivering this feature.
- Changes to claim, evidence, run-lifecycle, or phase control-flow semantics ship with regression tests in the kit's own test suite, per the constitution's development workflow.

## Out of Scope

Explicitly excluded from this feature. These are separate concerns and MUST NOT acquire requirements here:

- **Issue #43** — Phase 0 excision.
- **Issue #48** — quarantine architecture.
- **Issue #51** — as-written absolute/relative path diagnosis.
- **Issues #40, #44, #45** — already closed.
- **A separate post-`migrated` verify stage as its own pipeline phase.** Verification here is bounded and per-artifact within the existing phase; a new pipeline stage is a different design.
- **Toolchain provisioning** — baking build toolchains into demo images, or otherwise guaranteeing toolchain presence in agent environments.
- **Materializing or re-exporting stored context trees** after a host move. This feature makes retrieval survive a missing tree; it does not rebuild the tree.
- **Broadening agent write authorization to build files.** The blocked-by-out-of-scope-path condition is reported (FR-010); granting blanket write access is not the remedy and is excluded.
- **Any change to the set of migration statuses themselves.** Verification is recorded alongside status, not by adding new status values.

## Dependencies

- The recorded-state store must be able to hold the new verification and outcome facts and expose them to status, review, and arbitration consumers.
- The harness resolution layer must be usable by preflight in exactly the form a run uses it, including the environment the agent will receive.
- Packaged agent artifacts (agents, skills, prompts, instructions shipped to workspaces) must be updated wherever agent-visible behaviour changes.
- Operator-facing documentation and the maintainer changelog must record the environment-precedence behaviour change and the limit-precedence rules.
- Verifying installed behaviour requires a workspace outside this repository, per the constitution's source-of-truth boundaries; this repository is the kit's source, not a migration workspace.
