# Implementation Plan: Adversary Agent Role Between Review and the Approval Gate

**Branch**: `017-adversary-agent-gate` | **Date**: 2026-09-01 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/017-adversary-agent-gate/spec.md`

## Summary

Insert a new `adversary-agent.agent.md` pipeline role that runs after `review-agent` passes and before an artifact that will not be gated for human approval is allowed to reach `reviewed`. Given the artifact and the stack's configured verify command, it tries to construct one input/test case that passes the existing test suite but violates the spec's intent. A clean probe changes nothing; a violating (or inconclusive) probe routes the artifact to `needs-rework` the same way review and arbitration already do (`setArtifactStatus` + `appendEvent`), and records the finding under a new reserved `agent_context` slot, `adversary-envelope`, using the exact write/read pattern issue #216 established for its `rejection-envelope` slot (`migration/registry/commands/context.ts`'s upsert-by-`(artifact_id, agent)` semantics, a synthesized `## Summary` section, fail-open write / fail-closed status transition). `recordApprovalDecision` is not reused — it requires the artifact to already be at `pending-approval` and is scoped by #216 to human operator rejections only, a precondition the adversary-agent's pre-gate trigger point can never satisfy. `remediation-agent.agent.md` gains a second, analogous read step (`get-context --agent adversary-envelope`) alongside the one #216 already added, so both origins of a `needs-rework` rejection reach the next attempt through the one remediation flow.

## Technical Context

**Language/Version**: TypeScript (Node.js), compiled via the existing `migration/registry` build (`tsc` → `dist/cli.js`)

**Primary Dependencies**: `better-sqlite3` (existing registry DB driver); no new dependencies

**Storage**: Existing SQLite registry — the `agent_context` table (via `migration/registry/commands/context.ts`), reused as-is under a new reserved `agent` key; no schema change. The arbitration/evidence flow's `events` table is reused for the probe-pass and probe-inconclusive/violation records (FR-005, FR-008b); no new table.

**Testing**: Existing Vitest/node test suite under `migration/test/` (pattern: `migration/test/approval-gate.test.ts`, and #216's planned `migration/test/rejection-envelope.test.ts`; a new focused test file for the adversary envelope and routing)

**Target Platform**: Same CLI/registry runtime as spec 013 and #216 (`node migration/registry/dist/cli.js ...`), invoked by pipeline agents (Markdown `.agent.md` procedure files)

**Project Type**: Single project — registry backend (`migration/registry/`) + agent procedure docs (`package/agents/`)

**Performance Goals**: N/A — one adversarial probe per artifact per pipeline pass (stateless, per Clarifications), a synchronous low-volume registry write/read; no new performance surface

**Constraints**: Must not alter `recordApprovalDecision`'s preconditions, behavior, or scope (FR-017); must not touch or overwrite any other contributor's `agent_context` row for the same artifact, including `rejection-envelope` (FR-009); an envelope write failure must not prevent the `needs-rework` routing and event (FR-015); the adversary-agent step MUST run for every artifact reaching this point regardless of risk tier (FR-006) — it precedes, and is independent of, the human approval gate

**Scale/Scope**: One artifact at a time, same order of magnitude as existing review/arbitration traffic; no batch or multi-artifact concerns introduced

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **I. Evidence Over Assertion**: PASS. The adversary-agent's pass/fail outcome is itself recorded as an event (FR-005, FR-008b), not a self-report absorbed silently; a clean probe is not treated as new approval evidence and does not feed arbitration (FR-008b makes this explicit), so it cannot be mistaken for verifier-generated runtime evidence.
- **II. Legacy Is Read-Only; `modern/` Is the Only Write Target**: PASS. No writes to `legacy/` or `modern/`. Writes are confined to `migration/artifacts/<slug>/context/adversary-envelope.md` (the same destination pattern `writeContext`/`writeRejectionEnvelope` already use) and the existing `agent_context`/`events` tables.
- **III. Registry-Mediated Coordination**: PASS. The adversary-agent's finding and routing decision are recorded in the registry (`agent_context`, `events`, `artifacts.status`), not held in conversation. No new claim semantics: the probe runs within the same claimed work the reviewing/arbitrating agent already holds, and the routing write reuses `setArtifactStatus`/`appendEvent`, the same primitives `rejectArtifactWithEvidence` and `recordApprovalDecision` already use for an equivalent transition.
- **IV. Separation of Powers: Builder, Critic, Arbiter**: PASS, and this feature strengthens it. The adversary-agent is a third, independent check distinct from the critic (`review-agent`) and the arbiter (`approveArtifactWithEvidence`) — it does not certify its own probe target, and per FR-006 it cannot be skipped by risk tier the way the human gate's engagement already can be. It does not replace or weaken the arbiter's gate: FR-008b explicitly forbids treating a clean adversarial probe as approval evidence.
- **V. Tests Before Production Code**: PASS — not directly engaged; this feature does not change how migrated code or its tests are produced, only adds a probe step after both already exist. The feature's own registry-layer change ships with regression tests per the existing `migration/test/` convention (Development Workflow gate), mirroring #216's `rejection-envelope.test.ts` plan.
- **VI. Fail-Closed Automation**: PASS. The Clarifications session resolved the inconclusive-probe case explicitly fail-closed (FR-008a): an adversary-agent that cannot run its probe at all routes the artifact to `needs-rework` rather than silently letting it through — the opposite of `review-agent`'s existing "compile checks are optional" tolerance, and deliberately so, because this feature exists specifically to close the below-cutoff "complete unattended" gap. The envelope *write* itself remains fail-open (FR-015), consistent with the precedented asymmetry in `commitPromotedArtifact` and #216's `writeRejectionEnvelope` — only the best-effort relay detail is fail-open; the safety-critical routing decision is fail-closed.
- **VII. Pluggable Stacks, Neutral Providers**: PASS. The adversary-agent's probe is driven by "the stack's configured verify command," the same stack-neutral interface `review-agent` and `guildctl verify` already use; no stack-specific logic is introduced into core runtime code.

No violations requiring justification in Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/017-adversary-agent-gate/
├── plan.md              # This file ($speckit-plan command output)
├── research.md          # Phase 0 output ($speckit-plan command)
├── data-model.md        # Phase 1 output ($speckit-plan command)
├── quickstart.md        # Phase 1 output ($speckit-plan command)
├── contracts/           # Phase 1 output ($speckit-plan command)
└── tasks.md             # Phase 2 output ($speckit-tasks command - NOT created by $speckit-plan)
```

### Source Code (repository root)

```text
migration/
├── registry/
│   ├── commands/
│   │   ├── context.ts         # gains writeAdversaryEnvelope/getAdversaryEnvelope (or equivalent),
│   │   │                      #   mirroring #216's writeRejectionEnvelope/getRejectionEnvelope
│   │   │                      #   under the "adversary-envelope" reserved key (FR-007, FR-008)
│   │   ├── evidence.ts        # approveArtifactWithEvidence: below-cutoff branch gains the
│   │   │                      #   adversary-agent checkpoint before setArtifactStatus(..., "reviewed")
│   │   │                      #   (FR-001, FR-006); gate-bound branch gains the probe-pass event
│   │   │                      #   (FR-008b) before pending-approval hold
│   │   └── approval.ts        # unchanged (FR-017) — read, not modified, to confirm non-interference
│   ├── cli.ts                 # existing get-context/write-context/append-event surface reused;
│   │                          #   no new CLI subcommand anticipated (mirrors #216's contract)
│   └── types.ts                # reserved-key constant, if a shared literal home is warranted
└── test/
    └── adversary-envelope.test.ts   # new: write-on-finding, write-on-inconclusive, non-clobber
                                      #   against rejection-envelope and other agents' context,
                                      #   read-back, no-finding-found, gate-bound pass-event paths

package/agents/
├── adversary-agent.agent.md    # new: the adversarial-probe role itself (FR-001–FR-004, FR-008a)
└── remediation-agent.agent.md  # gains second envelope-read step: get-context --agent
                                 #   adversary-envelope, folded alongside rejection-envelope (FR-010–FR-012)
```

**Structure Decision**: Single project, additive change inside the existing `migration/registry` backend and `package/agents` procedure docs — the same structure spec 013 and #216 used. No new top-level directories. This feature's registry-layer work is designed to land as a follow-on to #216 (blocked on it per the spec's Assumptions), reusing #216's `context.ts` additions rather than re-deriving them.
