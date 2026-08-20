# Feature Specification: guildctl Operational Hardening

**Feature Branch**: `012-guildctl-operational-hardening`

**Created**: 2026-08-19

**Status**: Draft

**Input**: User description: "Fix all currently-open bugs/gaps tracked across GitHub issues #150, #151, #153, #154, #155, #156, #157, #158, #159 — manual arbitration approval, verify-harness/stack-command mismatch and blocked-loop, auto --resume crash on blocked status, warden-reverted output falsely marked migrated, stale migration/dist/ paths in CLI and prompt output, preflight max_tokens false failures on reasoning models, guildctl init's unusable default DB path, unbounded verify-subprocess concurrency, and the setup wizard's broken non-TTY fallback."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Operator can manually approve or reject a migrated artifact (Priority: P1)

An operator running the pipeline by hand (outside `auto`/`auto-run`) needs `guildctl arbitrate --approve` and `--reject` to actually work against recorded evidence, instead of failing every time with an unhandled credential error.

**Why this priority**: This is the CLI's documented manual-arbitration entry point. As it stands it is unusable for its stated purpose, which blocks any workflow that isn't fully autonomous.

**Independent Test**: Run `guildctl arbitrate --approve` (and `--reject`) against an artifact with recorded evidence, outside of an `auto` run, and confirm the artifact's status transitions correctly with no uncaught exception.

**Acceptance Scenarios**:

1. **Given** an artifact with fresh, passing evidence recorded, **When** an operator runs `guildctl arbitrate --approve` for it with the credential the CLI now supports supplying, **Then** the artifact transitions to its approved status and the command exits 0 with a clear confirmation message.
2. **Given** an artifact with no valid run/operator credential available, **When** an operator runs `guildctl arbitrate --approve`, **Then** the command prints a clean, actionable error describing the missing credential and exits non-zero — never a raw stack trace.
3. **Given** an artifact whose evidence was produced by the same actor attempting to approve it, **When** arbitration is attempted, **Then** the command refuses the approval (per the existing builder/critic/arbiter separation) with a clear message, not a crash.

---

### User Story 2 - Verify step uses the correct stack command and stops looping on unresolvable failures (Priority: P1)

An operator migrating a non-Node stack (e.g. Java/Spring) needs the verify step to run that stack's configured verify command, and needs the pipeline to stop re-attempting a verify step that a remediation pass has already confirmed cannot succeed in the current environment.

**Why this priority**: A wrong verify command makes every artifact in a non-default stack unverifiable, and the resulting blocked-loop silently burns real provider budget on every retry with no path to resolution.

**Independent Test**: Run `migrate` + verify on an artifact in a stack whose configured verify command differs from the default, confirm the configured command runs (not the default). Separately, force a verify precondition that cannot be satisfied in the environment and confirm the pipeline reaches a terminal, budget-safe state instead of an unbounded blocked/migrated loop.

**Acceptance Scenarios**:

1. **Given** a workspace configured for a stack whose verify command is not the default, **When** an artifact in that stack reaches the verify step, **Then** the stack's own configured verify command runs, not the default command.
2. **Given** a stack's verify tooling is unavailable in the current environment (per that stack's own configuration), **When** verify would otherwise run, **Then** the artifact is marked in a way that reflects "verification unavailable," not looped as blocked.
3. **Given** a remediation pass has already confirmed an artifact's delivered content has no defect and explicitly signaled the loop should not repeat, **When** the supervisor would otherwise re-run the same verify step, **Then** it stops and surfaces the artifact for operator attention instead of re-entering the loop.

---

### User Story 3 - Resuming a blocked artifact fails cleanly instead of crashing (Priority: P2)

An operator retrying a previously blocked artifact via `guildctl auto --artifact <id> --resume` needs either a working resume path or a clear explanation of why resume isn't possible from that state — not an uncaught exception.

**Why this priority**: The prior failure message actively told the operator resuming was safe; getting a stack trace instead breaks trust in the tool's own guidance and interrupts operator workflow.

**Independent Test**: Put an artifact into `blocked` status, run `guildctl auto --artifact <id> --resume`, and confirm the command either resumes successfully or exits with a clean, actionable message — never a raw stack trace.

**Acceptance Scenarios**:

1. **Given** an artifact in `blocked` status, **When** an operator runs `--resume` against it, **Then** the command either proceeds with a valid resume attempt or reports why resume is unavailable, in both cases without an uncaught exception.
2. **Given** the tool's own prior output told the operator a status was "retryable," **When** the operator follows that guidance, **Then** the guidance and the actual accepted resume states are consistent with each other.

---

### User Story 4 - An artifact whose delivered output was reverted is never recorded as migrated (Priority: P2)

When the filesystem warden reverts an artifact's own claimed-path output as part of restoring unauthorized changes, that artifact must not end up recorded as successfully `migrated` — since nothing was actually delivered.

**Why this priority**: This is a correctness gap in the core evidence chain (Principle I: Evidence Over Assertion) that a downstream review step currently catches by luck rather than by design; closing it at the source prevents any future gap in that safety net from going unnoticed.

**Independent Test**: Trigger a warden revert that removes an artifact's own delivered output during a migrate run, and confirm the artifact's resulting status reflects failed delivery requiring redelivery, never `migrated`.

**Acceptance Scenarios**:

1. **Given** a migrate session whose only claimed-path output is reverted by the warden's restore, **When** the session concludes, **Then** the artifact's status reflects that delivery failed, not that it succeeded.
2. **Given** an artifact previously left in this failed state, **When** the artifact is retried, **Then** it is treated as requiring fresh delivery rather than as already complete.

---

### User Story 5 - Autonomous verify subprocesses are bounded so parallel sessions don't overwhelm the host (Priority: P2)

An operator running multiple autonomous sessions in parallel needs the number of simultaneous verify subprocesses (and their memory footprint) capped, so resource contention doesn't scale unbounded with however many sessions happen to be running.

**Why this priority**: Without a cap, a constrained host can be driven into memory/CPU exhaustion purely by session count, with no way for an operator to bound the blast radius short of manually limiting how many sessions they start.

**Independent Test**: Start more concurrent sessions than the configured concurrency limit, and confirm the number of simultaneously running verify subprocesses never exceeds that limit — excess sessions wait briefly rather than spawning unconditionally.

**Acceptance Scenarios**:

1. **Given** a configured maximum concurrent verify count, **When** more sessions than that maximum attempt to verify at the same moment, **Then** only up to the maximum run verification simultaneously; the rest wait their turn.
2. **Given** the default configuration (no explicit override), **When** an operator runs `auto`/`auto-run` without additional configuration, **Then** a sensible built-in concurrency limit still applies rather than leaving fan-out unbounded.
3. **Given** a verify subprocess for a stack with a configurable memory bound, **When** it runs, **Then** it runs under that bound rather than with unconstrained memory.

---

### User Story 6 - CLI and agent-facing messages point to real paths (Priority: P3)

Operators and agents following a path printed by the CLI or embedded in an agent prompt must land on a path that actually exists, not a stale pre-restructure path.

**Why this priority**: A stale path fails silently for its target audience (a human copy-pasting a command, or an agent executing a self-claim fallback) and erodes trust in every other message the tool prints.

**Independent Test**: Trigger the `plan` dependency-disposition blocked message and the test-writer-agent's self-claim fallback path, and confirm both reference a path that exists in the shipped tool.

**Acceptance Scenarios**:

1. **Given** `plan` is blocked by unconfirmed dependency dispositions, **When** it prints operator guidance, **Then** the command it suggests uses the real, currently-valid path.
2. **Given** an agent following the test-writer-agent's self-claim fallback instructions, **When** it runs the suggested command, **Then** that command's path is valid.
3. **Given** the shipped commands and prompt templates as a whole, **When** checked automatically, **Then** none of them contain the stale path form.

---

### User Story 7 - Provider health check doesn't false-fail against reasoning models (Priority: P3)

An operator running `guildctl preflight`/`doctor` against a healthy reasoning-model provider needs the check to correctly recognize the provider as healthy, instead of reporting a false failure because the model spent its whole token budget on internal reasoning before any visible output.

**Why this priority**: A false failure here blocks operators from ever starting a pipeline run against a working provider, and the misleading "empty completion" message doesn't point them toward the real cause.

**Independent Test**: Run preflight against a reasoning-model provider known to need a larger token budget to produce visible output, and confirm preflight reports the provider as healthy (or gives a message that correctly identifies the token-budget cause, not a generic empty-completion failure).

**Acceptance Scenarios**:

1. **Given** a healthy reasoning-model provider that needs more than a minimal token budget to produce visible output, **When** preflight runs its test completion, **Then** preflight does not report the provider as failing solely due to this budget shape.
2. **Given** a genuinely unhealthy or misconfigured provider, **When** preflight runs, **Then** it still correctly reports failure — the fix must not mask real provider problems.

---

### User Story 8 - A freshly initialized workspace can run autonomous mode without hidden setup (Priority: P3)

An operator who runs `guildctl init` followed by `guildctl auto`/`auto-run` using only documented defaults needs that to work, or needs the documentation to clearly state the extra step required — not a failure with no prior warning.

**Why this priority**: Silently failing on the very first autonomous run undermines the tool's own "works out of the box" promise and wastes an operator's first attempt.

**Independent Test**: Run `guildctl init` with no extra flags, then `guildctl auto`, and confirm either it now works, or the documentation an operator would have already read explains the exact extra step needed before this point.

**Acceptance Scenarios**:

1. **Given** a workspace scaffolded by `guildctl init` with default settings, **When** an operator runs `guildctl auto`/`auto-run` for the first time, **Then** either it succeeds, or the operator has already been told — via documentation they'd naturally read first — exactly what to change and why.

---

### User Story 9 - Setup wizard's non-interactive fallback behaves as documented (Priority: P3)

An operator running the setup wizard with closed or piped stdin (headless/CI usage) needs the documented "prompts resolve to defaults" behavior to actually happen, instead of the wizard silently exiting successfully with no workspace created.

**Why this priority**: A documented safe fallback that silently does nothing is worse than no fallback at all — a scripted install currently reports success while producing no usable output, with nothing indicating anything went wrong.

**Independent Test**: Run the setup wizard with stdin closed (`< /dev/null`) and separately with piped batched answers, with no CLI flags, and confirm a workspace is actually produced (using documented defaults), or that the wizard fails loudly rather than exiting 0 with nothing done.

**Acceptance Scenarios**:

1. **Given** stdin is closed or non-interactive and no flags are supplied, **When** the setup wizard runs, **Then** it produces a scaffolded workspace using default answers, or exits with a non-zero status and a clear message — it must never exit 0 having created nothing.
2. **Given** piped input that only partially answers the wizard's prompts, **When** the wizard reaches a prompt with no more buffered input, **Then** it resolves that prompt to its documented default rather than hanging indefinitely or exiting silently.
3. **Given** the documentation describing this fallback, **When** an operator reads it, **Then** it accurately describes the behavior the wizard actually exhibits.

### Edge Cases

- What happens when an operator supplies a run/operator credential to `arbitrate` that belongs to a different, unrelated run?
- How does the system handle a verify concurrency limit set to a value smaller than the number of artifacts already mid-verification when the new limit takes effect?
- What happens when the warden reverts *some but not all* of an artifact's claimed-path output (partial revert) rather than all of it?
- How does the blocked-loop hard-stop distinguish "remediation confirmed no defect, stop looping" from "remediation hasn't finished yet, keep waiting"?
- What happens when both `--legacy-path`/`--legacy-url` flags and non-TTY stdin are present at the same time during setup?

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The CLI MUST allow an operator to manually approve or reject a migrated artifact from recorded evidence, supplying whatever run/operator credential the underlying approval mechanism requires, without needing an `auto`/`auto-run` session to already be in progress.
- **FR-002**: Any credential or state error raised while approving or rejecting an artifact manually MUST be presented to the operator as a clean, actionable message, never as an uncaught exception or raw stack trace.
- **FR-003**: The verify step for an artifact MUST run the verify command configured for that artifact's active stack, not a hardcoded default command.
- **FR-004**: When a stack's verify tooling is documented as unavailable in the current environment, the verify step MUST report that as an explicit "unavailable" outcome, not as a `blocked` state.
- **FR-005**: The autonomous supervisor MUST stop re-attempting a verify step for an artifact after a remediation attempt has confirmed no content defect exists and signaled the loop should not repeat, surfacing the artifact for operator attention instead.
- **FR-006**: Attempting `--resume` against an artifact whose status does not support resuming MUST NOT crash with an uncaught exception; it MUST either succeed or report a clean, actionable message describing why resume isn't possible from that state.
- **FR-007**: Any status message that describes a state as retryable/resumable MUST be consistent with which states `--resume` actually accepts.
- **FR-008**: When the filesystem warden reverts an artifact's own claimed-path delivered output during a restore, the migrate step MUST NOT record that artifact as successfully migrated; it MUST be left in a state requiring redelivery.
- **FR-009**: The system MUST enforce a configurable maximum on the number of verify subprocesses running at once across concurrent sessions, with a sensible built-in default when unconfigured.
- **FR-010**: Sessions that cannot immediately acquire capacity to verify MUST wait rather than spawning an unbounded number of simultaneous verify subprocesses.
- **FR-011**: Verify subprocesses for stacks that support a memory bound MUST run under a configured memory limit.
- **FR-012**: All operator-facing CLI messages and agent-facing prompt templates MUST reference paths that exist in the shipped tool; none may reference the stale pre-restructure path form.
- **FR-013**: The system MUST include an automated check that fails if the stale path form reappears in any shipped command or prompt template.
- **FR-014**: The provider health check MUST NOT report a healthy reasoning-model provider as failing solely because it produced no visible output within a minimal token budget; it MUST use, or fall back to, a budget sufficient to observe real output, or otherwise identify this specific failure shape distinctly from a generic empty-completion failure.
- **FR-015**: The provider health check MUST continue to correctly report failure for providers that are genuinely unreachable or misconfigured.
- **FR-016**: A workspace created by the default initialization flow MUST either support running autonomous mode without additional undocumented configuration, or the documentation an operator reads before running autonomous mode MUST explicitly state the additional required configuration and how to supply it.
- **FR-017**: The setup wizard MUST NOT exit successfully while producing no scaffolded workspace when given non-interactive (closed or non-TTY) stdin and no CLI flags; it MUST either complete using documented default answers or fail with a non-zero exit and a clear message.
- **FR-018**: When the setup wizard receives piped input that runs out before all prompts are answered, each remaining prompt MUST resolve to its documented default rather than hanging or being silently skipped.
- **FR-019**: Documentation describing the setup wizard's non-interactive behavior MUST accurately match its actual behavior after this fix.

### Key Entities

- **Artifact**: A unit of migration work tracked in the registry, with a status (e.g. `migrated`, `blocked`, `reviewed`) that gates downstream work; central to stories 1–5.
- **Evidence**: A registry-recorded record of a verification or review outcome for an artifact, required before arbitration may approve it.
- **Run Operator Credential**: A credential scoping who may perform privileged status transitions (like arbitration approval) for a given run.
- **Verify Slot**: A bounded resource representing permission to run one verify subprocess at a time, leased and released similarly to an artifact claim.
- **Stack Configuration**: Per-stack settings (verify command, tooling availability, memory bounds) that must be respected rather than defaulted.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An operator can manually approve or reject an artifact from the CLI on the first attempt, without consulting source code, in a scenario where automated approval isn't running.
- **SC-002**: Zero uncaught exceptions/raw stack traces are surfaced to the operator across the arbitration, resume, and setup-wizard flows covered by this feature, for any of the input states described in the acceptance scenarios.
- **SC-003**: A non-default-stack artifact's verify step runs the correct configured command in 100% of verify attempts, with no `npm test`-against-non-Node-workspace failures.
- **SC-004**: An artifact that a remediation pass has confirmed defect-free stops re-entering the blocked verify loop within one supervisor cycle after that confirmation, instead of looping indefinitely.
- **SC-005**: No artifact is ever left recorded as `migrated` when its claimed-path output was reverted by the warden — verified by a regression test reproducing the revert scenario.
- **SC-006**: Under a load of more concurrent sessions than the configured verify concurrency limit, the number of simultaneously running verify subprocesses never exceeds that limit, measured across the full run.
- **SC-007**: An automated check across shipped commands and prompt templates finds zero occurrences of the stale path form.
- **SC-008**: Preflight against a known-healthy reasoning-model provider reports success, while preflight against a known-unhealthy provider still correctly reports failure.
- **SC-009**: A workspace built purely from `guildctl init` defaults either runs `auto`/`auto-run` successfully, or an operator following GETTING-STARTED.md/README.md in order encounters the required extra step before hitting the failure, not after.
- **SC-010**: A headless setup wizard run (closed stdin, no flags) produces a scaffolded workspace using default answers, or exits non-zero with a clear message — never exit 0 with nothing produced.

## Assumptions

- These nine issues are independent fixes across different subsystems; none of them depends on another being implemented first, so they can ship and be verified separately even though they're specified together.
- "Clean, actionable CLI error" means: no raw stack trace reaches the operator's terminal by default, and the message states what went wrong and, where applicable, what the operator can do next.
- Existing evidence/claim/warden semantics (Principles I–IV in the project constitution) are not being redesigned here — these are fixes that make the system actually enforce what those principles already require, not changes to the principles themselves.
- Reasonable built-in defaults (verify concurrency limit, preflight token budget) are acceptable without requiring operator configuration, consistent with the rest of the CLI's already-configurable, sensible-default posture.
- "Documented default" for setup-wizard prompts means the default already shown in the wizard's own prompt text (e.g. `[1]`), not a new default introduced by this feature.
