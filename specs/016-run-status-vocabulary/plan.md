# Implementation Plan: Run Status Vocabulary on the Operator Dashboard

**Branch**: `016-run-status-vocabulary` | **Date**: 2026-09-01 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/016-run-status-vocabulary/spec.md`

**Note**: This template is filled in by the `$speckit-plan` command; its definition describes the execution workflow.

## Summary

Add a derived four-state status label (`working`, `idle`, `waiting-for-approval`, `rejected`) to the Mission Control operator dashboard, computed at read time from data the registry already has: `artifact_claims.state`/`heartbeat_at`/`claimed_at` for `working`/`idle`, and the existing spec-013 US4 pending-approvals/arbitration data paths for `waiting-for-approval`/`rejected`. No schema changes. The "working" recency threshold is a new named constant (5 minutes, per clarification), distinct from `guildctl doctor`'s existing 60-minute dangling-claim threshold. The label is computed in a new pure registry-layer read function, exposed through an existing or lightly-extended dashboard endpoint, and rendered by a small new UI component reusing the existing polling (`pollIntervalMs`) pattern already used by `ApprovalsPanel` and friends — no new polling mechanism.

## Technical Context

**Language/Version**: TypeScript (registry: Node.js/better-sqlite3; UI: React 18 via Vite)

**Primary Dependencies**: `better-sqlite3` (registry reads), React 18, Vitest + Testing Library (UI tests), existing `migration/ui/src/hooks.ts` polling hook infrastructure

**Storage**: Existing SQLite registry (WAL mode) — no schema changes; reads only from `artifact_claims`, `artifacts`, and `arbitration_decisions`

**Testing**: `migration/test` suite (registry-layer function tests, Node's test runner per existing convention) and `migration/ui` Vitest suite (`*.test.tsx`), both run via root `npm test`

**Target Platform**: Existing Mission Control operator dashboard (browser, served by `migration/registry/commands/serve.ts`)

**Project Type**: Web application within the existing monorepo — `migration/registry` (backend read API) + `migration/ui` (frontend)

**Performance Goals**: No new performance target beyond existing dashboard poll cadence; the four-state computation is a single additional derived field per artifact row, not a new query class

**Constraints**: Must not modify claim/heartbeat write behavior (Principle III scope), must not touch `legacy/`/`modern/` trees (N/A — this feature has no migration-workspace footprint), must not duplicate `listPendingApprovals`/`recordApprovalDecision` logic (FR-007/FR-008), must not introduce schema migrations (FR-010)

**Scale/Scope**: Same registry/dashboard scale as existing spec-013 features — single operator dashboard instance per migration workspace, artifact counts in the hundreds-to-low-thousands range typical of this project's registries

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **I. Evidence Over Assertion**: PASS. This feature only reads existing registry-recorded state (claim heartbeats, arbitration decisions); it introduces no new self-reported status and does not weaken any evidence gate.
- **II. Legacy Is Read-Only; `modern/` Is the Only Write Target**: N/A. This feature touches only `migration/registry` and `migration/ui` (kit runtime code), never a migration workspace's `legacy/`/`modern/` trees.
- **III. Registry-Mediated Coordination**: PASS. The four-state label is derived read-only from existing registry claim/heartbeat data; no new claim semantics, no new coordination primitive, no bypass of claim tokens.
- **IV. Separation of Powers: Builder, Critic, Arbiter**: PASS. `rejected` is sourced from existing `arbitration_decisions` rows without altering who may write them; this feature adds no new write path for decisions.
- **V. Tests Before Production Code**: Applies to this feature's own implementation (kit runtime code, governed by the "Kit behavior itself MUST be covered by the `migration/test` suite" clause, not the target-migration tests-before-code clause). Tasks MUST write registry-layer and UI tests before/alongside the corresponding implementation, per existing repo convention (see spec-013 US4 T024/T025 preceding T026-T029).
- **VI. Fail-Closed Automation**: N/A. This feature is dashboard-only display logic, not `auto-run`/executor control flow.
- **VII. Pluggable Stacks, Neutral Providers**: N/A. No stack-specific or provider-specific logic is introduced.

No violations requiring Complexity Tracking justification.

## Project Structure

### Documentation (this feature)

```text
specs/016-run-status-vocabulary/
├── plan.md              # This file ($speckit-plan command output)
├── research.md          # Phase 0 output ($speckit-plan command)
├── data-model.md         # Phase 1 output ($speckit-plan command)
├── quickstart.md        # Phase 1 output ($speckit-plan command)
├── contracts/           # Phase 1 output ($speckit-plan command)
└── tasks.md             # Phase 2 output ($speckit-tasks command - NOT created by $speckit-plan)
```

### Source Code (repository root)

```text
migration/registry/
├── commands/
│   ├── approval.ts        # EXISTING — listPendingApprovals, recordApprovalDecision (reused, not modified)
│   ├── claim.ts            # EXISTING — artifact_claims reads/writes; source of heartbeat_at semantics (read-only reference)
│   └── queries.ts          # EXTEND — new read function computing the four-state label per artifact, alongside existing queryPendingApprovalsForUI-style read functions
├── types.ts                 # EXTEND — new exported RunStatusLabel type / WORKING_THRESHOLD_MS-style constant
└── commands/serve.ts       # EXTEND — expose the new read via an existing or new lightweight endpoint

migration/ui/src/
├── api.ts                   # EXTEND — client fetch for the new endpoint
├── types.ts                  # EXTEND — mirror the new RunStatusLabel DTO type
├── constants.ts              # EXTEND — badge colors/labels for the four-state vocabulary (parallel to existing STATUS_COLORS)
├── hooks.ts                  # EXTEND — a small hook using the existing pollIntervalMs pattern to fetch the new endpoint
├── components/
│   ├── ApprovalsPanel.tsx    # EXISTING — untouched; continues to own waiting-for-approval/rejected UI per FR-007
│   └── RunStatusBadge.tsx    # NEW — shared four-state badge/legend component used wherever an artifact's status is shown
└── App.tsx                   # EXTEND — wire the new hook/badge into the existing dashboard composition

migration/test/                # EXTEND — new registry-layer test(s) for the four-state derivation function
migration/ui/src/components/*.test.tsx  # EXTEND — new UI test(s) for RunStatusBadge and the poll-driven recompute behavior
```

**Structure Decision**: Follows the existing spec-013 US4 layering exactly: a pure registry-layer function (parallel to `listPendingApprovals`) added to `migration/registry/commands/queries.ts` (or a small new `commands/run-status.ts` module if the derivation logic is judged large enough to warrant its own file — left to `/speckit-tasks`/implementation to decide), exposed through `serve.ts`, consumed via `api.ts`/a new hook in `hooks.ts`, and rendered by one new shared UI component (`RunStatusBadge.tsx`) so the four-state vocabulary has one canonical presentation reused by both the existing `ApprovalsPanel` and any per-artifact status display (e.g. `ArtifactList.tsx`/`ArtifactDetail.tsx`). No new top-level project or directory is introduced.

## Complexity Tracking

*No Constitution Check violations — table intentionally omitted.*
