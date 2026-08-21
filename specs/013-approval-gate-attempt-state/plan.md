# Implementation Plan: Human Approval Gate and Attempt-Scoped Retry History for the Migrate/Review Loop

**Branch**: `013-approval-gate-attempt-state` | **Date**: 2026-08-21 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/013-approval-gate-attempt-state/spec.md`

**Note**: This template is filled in by the `$speckit-plan` command; its definition describes the execution workflow.

## Summary

Two additive, independent pieces of registry-mediated state:

1. **Approval gate** — a new `pending-approval` artifact status, entered only from `migrated` on an approving arbiter verdict for a gate-scoped (default: high-risk) artifact, and left only via a new append-only `approval_decisions` table driven by one shared registry function, exposed first through a `guildctl approve` CLI command (Mission Control UI wiring deferred to a follow-up).
2. **Attempt-scoped retry history** — a new `attempt_records` table, keyed by `(artifact_id, attempt_no)` and joined to the existing `artifact_claims.attempt_no` sequencing anchor, into which the migrate phase's existing `classifyFailure`/`FailureBudget` bookkeeping (`migration/guildctl/supervisor/failures.ts`) persists instead of living only in an in-process `Map`.

Both pieces slot into the existing evidence/arbitration pipeline (`migration/registry/commands/evidence.ts`, `migration/guildctl/commands/arbitrate.ts`) and the existing supervisor loop (`migration/guildctl/supervisor/loop.ts`) without altering claim/lease semantics, the arbiter's verdict logic, or wave scheduling.

## Technical Context

**Language/Version**: TypeScript (Node.js), compiled/run via `tsx`/`tsup` per existing `migration/` toolchain

**Primary Dependencies**: `better-sqlite3` (registry), Node's built-in `node:test` + `node:assert/strict` (tests), existing `guildctl` CLI command framework, React + Vite (Mission Control UI, `migration/ui/`) — UI work is out of scope for this plan's initial increment (US4/P2)

**Storage**: SQLite registry (`migration/registry_schema.sql`), WAL mode, accessed exclusively through `migration/registry/commands/*`

**Testing**: `node:test` files under `migration/test/` (pattern matches existing `arbitrate-manual-approval.test.ts`, `attempt-outcome.test.ts`); `npm test` runs both the `migration` suite and the Mission Control UI suite and MUST pass per the constitution's Development Workflow gate

**Target Platform**: Linux/macOS/Windows CLI tool (`guildctl`) operating against a local or shared registry file; no new deployment target

**Project Type**: Single project — CLI + registry library, existing structure (`migration/registry`, `migration/guildctl`, `migration/ui`)

**Performance Goals**: N/A beyond existing registry transaction latency (single-digit ms per SQLite write); no new performance-sensitive path

**Constraints**: Must not alter claim/lease/evidence semantics (constitution III, I); must not let the arbiter self-certify (constitution IV); must not weaken any existing gate (constitution Governance §Enforcement — a MAJOR amendment otherwise)

**Scale/Scope**: Same order of magnitude as existing registry tables (hundreds to low-thousands of artifacts per run, single-digit attempts per artifact)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **I. Evidence Over Assertion** — PASS. The gate sits strictly downstream of an existing approving arbiter verdict backed by fresh runtime evidence (FR-006 requires re-checking evidence freshness at human-decision time, mirroring `checkEvidenceFreshness` in `evidence.ts`). No new self-report path is introduced.
- **II. Legacy Is Read-Only; `modern/` Is the Only Write Target** — PASS. Neither feature touches the filesystem warden's write-target rules; both are pure registry-state additions.
- **III. Registry-Mediated Coordination** — PASS. `pending-approval` and attempt records live in the registry, not in conversation or process memory (this *is* the fix for the attempt-history half). FR-007 explicitly requires the awaiting-decision state to hold no exclusive claim, preserving crash-recovery-without-human-intervention.
- **IV. Separation of Powers: Builder, Critic, Arbiter** — PASS, and reinforced. The human decision is a **fourth**, distinct checkpoint after builder/critic/arbiter, not a substitute for any of them (spec's explicit non-goal: "does not alter the verdict"). Must verify design does not let the same identity that produced or arbitrated an artifact also record its human approval — flagged as a design constraint for Phase 1 data model, not currently covered by an existing gate.
- **V. Tests Before Production Code** — PASS (not applicable to gate mechanics; migrate-phase test-first discipline is unchanged). New kit behavior (approval transitions, attempt persistence) MUST ship with `migration/test` regression coverage per the Development Workflow gate — planned in Phase 1 contracts and carried into `/speckit-tasks`.
- **VI. Fail-Closed Automation** — PASS, and reinforced. FR-012 ("MUST NOT silently auto-approve... including fully unattended/autonomous runs") is a direct restatement of this principle for the new state; auto-run's existing halt-on-systemic-error behavior is unchanged since `pending-approval` is a held-but-healthy state, not an error.
- **VII. Pluggable Stacks, Neutral Providers** — PASS. Gate scope (risk cutoff) reuses the existing stack-pack-resolved `resolveRiskSpec`/`highRiskScoreCutoff` mechanism (`migration/guildctl/risk.ts`); no new stack-specific or provider-specific logic is introduced.

No violations requiring Complexity Tracking justification.

**Post-Phase 1 re-check**: The one open item flagged above under Principle IV (same-identity self-approval) is now closed by design: `recordApprovalDecision`'s preconditions (contracts/registry-commands.md) explicitly reject an `operator` matching the artifact's approving `arbiter` identity, per research.md §1. No other principle is affected by the Phase 1 data model or contracts — `approval_decisions` and `attempt_records` are both purely additive, append-only tables with no impact on claim/lease/evidence/warden mechanics. Gate remains PASS on all seven principles.

## Project Structure

### Documentation (this feature)

```text
specs/013-approval-gate-attempt-state/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md        # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── contracts/           # Phase 1 output (/speckit-plan command)
│   └── registry-commands.md
└── tasks.md              # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
migration/
├── registry_schema.sql                    # + pending-approval status value, approval_decisions,
│                                           #   attempt_records tables (additive, no destructive migration)
├── registry/
│   └── commands/
│       ├── evidence.ts                    # approveArtifactWithEvidence(): gate-scope check + divert
│       ├── approval.ts                    # NEW: recordApprovalDecision(), listPendingApprovals(),
│       │                                   #   shared by CLI and (later) UI endpoint
│       └── attempts.ts                    # NEW: recordAttemptOutcome(), getAttemptHistory()
├── guildctl/
│   ├── commands/
│   │   ├── arbitrate.ts                   # verdict→status mapping: divert to pending-approval when in-scope
│   │   └── approve.ts                     # NEW: `guildctl approve <artifact-id> [--reject --reason ...]`
│   │                                       #   and `guildctl approve --list`
│   ├── risk.ts                            # reused unchanged: resolveRiskSpec / highRiskScoreCutoff
│   └── supervisor/
│       ├── failures.ts                    # classifyFailure/FailureBudget: persist via attempts.ts
│       │                                   #   instead of (or alongside, during transition) in-memory Map
│       └── loop.ts                        # claim eligibility excludes pending-approval; run summary
│                                           #   reports held-for-approval distinctly from blocked
└── test/
    ├── approval-gate.test.ts              # NEW: US1 acceptance scenarios
    ├── approval-cli.test.ts               # NEW: US2 acceptance scenarios
    └── attempt-records.test.ts            # NEW: US3 acceptance scenarios (incl. restart resumption)

migration/ui/                              # US4 (P2) — no changes in this increment; approvals UI
                                            #   panel is a follow-up plan once US1–US3 land
```

**Structure Decision**: Single existing project (`migration/registry` + `migration/guildctl` + `migration/test`), extended in place following the established pattern of one registry-schema addition + one `registry/commands/*.ts` module + one `guildctl/commands/*.ts` CLI entry point + one `migration/test/*.test.ts` file per prior features (e.g. `risk.ts`/`risk_confirmations` for #005). No new top-level directories. The Mission Control UI (`migration/ui/`) is untouched in this increment per the spec's Assumptions (CLI ships before, and independently of, the dashboard).

## Complexity Tracking

*No Constitution Check violations — table not needed.*
