# Implementation Plan: Rejection Reason Envelope for the Next Remediation Attempt

**Branch**: `014-rejection-envelope` | **Date**: 2026-09-01 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/014-rejection-envelope/spec.md`

## Summary

When a human operator rejects an artifact through the approval gate (`recordApprovalDecision`, `migration/registry/commands/approval.ts`), the rejection reason is durably recorded in `approval_decisions` but never reaches the next attempt at the work. This feature writes that reason into a dedicated, reserved slot of the existing `agent_context` store (`migration/registry/commands/context.ts`) — distinct from any real agent's context slot — and gives the existing remediation flow (`package/agents/remediation-agent.agent.md`, which already triggers on `needs-rework` and already requeues to `planned`) an explicit step to read it and carry it forward into the reason/summary it leaves for the next attempt. No new table, transport, or subsystem; purely additive on top of spec-013.

## Technical Context

**Language/Version**: TypeScript (Node.js), compiled via existing `migration/registry` build (`tsc` → `dist/cli.js`)

**Primary Dependencies**: `better-sqlite3` (existing registry DB driver); no new dependencies

**Storage**: Existing SQLite registry — the `agent_context` table (via `migration/registry/commands/context.ts`), reused as-is; no schema change

**Testing**: Existing Vitest/node test suite under `migration/test/` (pattern: `migration/test/approval-gate.test.ts`, `migration/test/approve-command.test.ts` for the write side; a new focused test file for the envelope)

**Target Platform**: Same CLI/registry runtime as spec-013 (`node migration/registry/dist/cli.js ...`), invoked by pipeline agents (Markdown `.agent.md` procedure files)

**Project Type**: Single project — registry backend (`migration/registry/`) + agent procedure docs (`package/agents/`)

**Performance Goals**: N/A — this is a synchronous, low-volume write on the existing rejection code path and a synchronous read on the existing remediation code path; no new performance surface

**Constraints**: Must not change the `approval_decisions` schema or the public behavior of `recordApprovalDecision`'s existing return value/callers; must not overwrite context written by another contributor for the same artifact (per FR-003); a write failure on the envelope must not fail the rejection itself (per FR-008)

**Scale/Scope**: One artifact at a time, same order of magnitude as existing approval-gate and context traffic; no batch or multi-artifact concerns introduced

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **I. Evidence Over Assertion**: PASS. This feature does not touch evidence or arbitration gating; it only relays an already-recorded human decision's reason. The permanent record of the decision remains `approval_decisions`, unchanged (FR-004, Assumptions).
- **II. Legacy Is Read-Only; `modern/` Is the Only Write Target**: PASS. No writes to `legacy/` or `modern/`. Writes are confined to `migration/artifacts/<slug>/context/` (the existing `agent_context` file destination) and the existing `agent_context` table — both already outside `legacy/`/`modern/`.
- **III. Registry-Mediated Coordination**: PASS — and this feature strengthens it. It formalizes an implicit gap (rejection reason not relayed) using the existing registry-as-bus mechanism (`agent_context`) rather than introducing conversation-based or side-channel coordination. No new claim semantics are introduced; the envelope write happens inside `recordApprovalDecision`'s existing transaction/context, and the read is a plain `getContext` call requiring no claim.
- **VI. Fail-Closed Automation**: PASS, with an explicit exception captured in FR-008: the envelope write is best-effort/non-blocking — if it fails, the rejection decision and status transition (the fail-closed, evidence-bearing part) still complete. This mirrors the existing `commitPromotedArtifact` fail-open pattern in `migration/registry/commands/evidence.ts` (see its doc comment: "fail open... any failure here... must not turn a successful arbitration approval into a crash"), applied symmetrically to rejection. No violation: the safety-critical state (decision record, status transition) remains fail-closed; only the best-effort relay is fail-open, and that asymmetry is precedented in this codebase.

No violations requiring justification in Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/014-rejection-envelope/
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
│   │   ├── approval.ts        # recordApprovalDecision: add envelope write on rejection (FR-001, FR-008)
│   │   └── context.ts         # writeContext/getContext: reused as-is; may gain a small raw-content
│   │                          #   write helper if writeContext's file-based contract doesn't fit
│   ├── cli.ts                 # existing get-context / write-context commands remain the read/write surface
│   └── types.ts               # Agent type / reserved-key constant, if the reserved slot needs a type home
└── test/
    └── rejection-envelope.test.ts   # new: write-on-reject, non-clobber, read-back, no-reason-found paths

package/agents/
└── remediation-agent.agent.md  # add explicit step: read rejection envelope before requeueing needs-rework
```

**Structure Decision**: Single project, additive change inside the existing `migration/registry` backend and `package/agents` procedure docs — the same structure spec-013 used. No new top-level directories.

## Complexity Tracking

*No Constitution Check violations — table intentionally omitted.*
