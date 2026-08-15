# Implementation Plan: Planner-Emitted Dependency Disposition Records

**Branch**: `006-dependency-disposition` | **Date**: 2026-08-16 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/006-dependency-disposition/spec.md`

**Note**: This template is filled in by the `$speckit-plan` command; its definition describes the execution workflow.

## Summary

Add planner-emitted, human-confirmed dependency disposition records to the Plan
phase: one auditable decision per third-party library — keep (with a locked
target version), replace-with-native (named Java 17/21 platform equivalent), or
inline (used helper surface to be provided in target code; the inlining itself
is out of scope for v1, FR-013). A deterministic, registry-side collector runs
inside `runPlan` before the Planner spawn, building the per-library universe
from `dependency_findings` ∪ build-manifest declarations and seeding proposals
from stack-pack knowledge; the planner agent then refines proposals via a new
`propose-disposition` registry CLI command using AST-level (import/usage)
evidence; and a `confirmMappings`-shaped confirmation step
(`confirmDispositions`, with `GUILDCTL_AUTO_CONFIRM_DISPOSITIONS=1` as the
benchmark bypass) records operator confirm/override decisions after the Planner
phase. Records live in two new registry tables (`dependency_dispositions`,
`dependency_disposition_history`) — deliberately separate from the per-finding
`dependency_strategies` machinery (research.md §1) — with a pending-reproposal
column group implementing FR-011's "confirmed decisions are never silently
overwritten." Confirmed sets are queryable as a deterministic locked dependency
set (FR-009), unresolved dispositions gate planning sign-off via the existing
readiness machinery (FR-007), and migration code-writer prompts receive a
pruned-library guidance suffix (FR-010). Full technical rationale in
[research.md](./research.md); persisted shapes in
[data-model.md](./data-model.md); interface contracts in
[contracts/](./contracts/).

## Technical Context

**Language/Version**: TypeScript, compiled via `tsc`/`tsup` (see `migration/tsconfig.json`, `migration/tsup.config.ts`); Node.js runtime (native `node --test` for tests via `tsx`, no transpilation needed at test time).

**Primary Dependencies**: `better-sqlite3` (registry access), `commander` (registry CLI), `yaml` (stack-pack config parsing) — all already present in `migration/package.json`. No new runtime dependency is introduced (research.md §3/§4: manifest extraction and usage analysis follow the existing regex/heuristic idiom of `audit.ts` and `classification.ts`; AST-parser libraries were evaluated and rejected for the same reasons as in feature 005).

**Storage**: SQLite registry (`better-sqlite3`, WAL mode), schema in `migration/registry_schema.sql` applied via `migration/registry/db/schema.ts`. Two new tables (`dependency_dispositions`, `dependency_disposition_history`) + three indexes; no changes to existing tables/columns, so `applySchema` needs no `ensureColumn` guards.

**Testing**: Node's built-in test runner via `tsx` — `node --import tsx --test test/*.test.ts`, invoked by `migration/package.json`'s `test` script, in turn by root `npm test` (which also runs the `migration/ui` Vitest suite — untouched by this feature). Tests live flat under `migration/test/*.test.ts`, use `node:test`/`node:assert/strict`, and exercise a real in-memory `better-sqlite3` database (`new Database(":memory:")` + `applySchema(db)`) — no mocking framework, per existing convention.

**Target Platform**: Linux/macOS developer and CI environments running the `guildctl`/`registry` Node CLIs against a user's legacy-code workspace (this feature does not touch the `migration/ui` Mission Control package).

**Project Type**: Single TypeScript CLI/library project (`migration/` — registry + guildctl orchestrator), extended, not restructured.

**Performance Goals**: SC-004 — the locked dependency set resolves in a single indexed query in under 5 seconds for a 500-library workspace (trivially met by `ORDER BY library_name` over one table with no joins). The collector runs once per Plan run; usage analysis reads each in-scope source file once (same read pattern as classification/risk scanning) and adds low-single-digit-percent wall time to Plan.

**Constraints**: No new npm dependency (research.md §3/§4); read-only over `legacy/` (Principle II — collector/usage analysis only read source and manifests); no weakening of claim atomicity (Principle III — this feature does not touch the claim path; readiness gating reuses the existing `evaluatePlanningReadiness` seam); fail-closed for unattended runs (Principle VI — no silent confirmation without the explicit env var).

**Scale/Scope**: Per-library per workspace grain; hundreds to low thousands of libraries (SC-004 sizes at 500). History table grows one row per decision change — bounded by operator activity.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design below.*

| Principle | Assessment | Gate |
|---|---|---|
| I. Evidence Over Assertion | Completeness of the disposition set (SC-001) is guaranteed by a deterministic collector writing one registry row per library — not by trusting the planner agent's self-report; the agent only refines rows that already exist. Usage evidence is persisted as `usage_json` on the row, inspectable at confirmation time. Every decision mutation writes a `dependency_disposition_history` snapshot in the same transaction — the sole evidence trail (dispositions are workspace-wide per-library and have no `artifact_id`, so the artifact-scoped `events` table is not used). | PASS |
| II. Legacy Is Read-Only; `modern/` Is the Only Write Target | The collector and usage analysis only READ `legacy/` source and build manifests (same `fs.readFileSync` idiom as `classifyArtifactSource` and the risk scanner). All writes go to the registry. v1 performs no manifest or source modification (FR-013). | PASS |
| III. Registry-Mediated Coordination | All new state lives in first-class registry tables (research.md §1 explicitly rejected an `operator_state` JSON blob). No new coordination channel; disposition decisions are queryable from the registry tables/history. Claim-path semantics untouched (research.md §7 rejected claim-boundary enforcement for this artifact type). | PASS |
| IV. Separation of Powers: Builder, Critic, Arbiter | Not directly implicated — dispositioning is a planning decision point, structurally analogous to `stack_mappings` confirmation and `risk_confirmations` (also outside the Builder/Critic/Arbiter chain). The confirmation actor (operator/benchmark-runner) is distinct from the proposing actor (planner-collector/planner-agent) by construction — proposer ≠ confirmer on every row. | N/A / PASS |
| V. Tests Before Production Code | This plan phase produces no production code. `quickstart.md`'s "Regression coverage" section enumerates the `migration/test/*.test.ts` additions `tasks.md` must sequence ahead of/alongside implementation — this feature changes Plan-phase control flow and a readiness gate, squarely inside §V's "phase control flow MUST ship with regression tests." | Deferred to tasks.md — flagged, not violated |
| VI. Fail-Closed Automation | Unattended runs without `GUILDCTL_AUTO_CONFIRM_DISPOSITIONS` never silently confirm: rows stay pending, the process does not hang, and the end-of-Plan readiness gate blocks sign-off (research.md §5/§7). Missing stack-pack knowledge degrades proposals toward `keep`, never toward silent pruning (research.md §6). Auto-confirmed rows are attributed to `benchmark-runner` (FR-006). | PASS |
| VII. Pluggable Stacks, Neutral Providers | All stack-specific knowledge (manifest locations, library→import-prefix maps, native-equivalent seeds) lives in an optional `dependencies:` block in stack-pack YAML (contracts/disposition-pack-yaml.md). The disposition engine (tables, collector, confirmation, gating, locked-set view) is stack-neutral core runtime. | PASS |

No violations requiring justification. **Complexity Tracking is not filled in.**

## Project Structure

### Documentation (this feature)

```text
specs/006-dependency-disposition/
├── plan.md              # This file ($speckit-plan command output)
├── research.md          # Phase 0 output ($speckit-plan command)
├── data-model.md        # Phase 1 output ($speckit-plan command)
├── quickstart.md        # Phase 1 output ($speckit-plan command)
├── contracts/           # Phase 1 output ($speckit-plan command)
│   ├── registry-schema.md
│   ├── cli-surface.md
│   └── disposition-pack-yaml.md
└── tasks.md             # Phase 2 output ($speckit-tasks command - NOT created by $speckit-plan)
```

### Source Code (repository root)

Single existing TypeScript CLI/library project — no new top-level directories.
The feature extends existing modules under `migration/` in place, following the
file organization established for the classification/audit/risk seams it sits
alongside:

```text
migration/
├── registry_schema.sql                     # + dependency_dispositions, dependency_disposition_history (contracts/registry-schema.md)
├── registry/
│   ├── cli.ts                              # + list-dispositions, propose-disposition, confirm-disposition, locked-dependency-set (contracts/cli-surface.md)
│   └── commands/
│       ├── dispositions.ts                 # NEW — upsertProposedDisposition, confirmDisposition, listDispositions,
│                                           #       getLockedDependencySet, dispositionContextForArtifact (contracts/registry-schema.md)
│       └── modernization.ts                # unchanged — dependency_findings/dependency_strategies remain the per-finding machinery
├── guildctl/
│   ├── dispositions.ts                     # NEW — stack-pack dependencies: block loader + collector (library universe,
│                                           #       manifest extraction, usage analysis, proposal seeding); mirrors classification.ts/risk.ts shape
│   ├── readiness.ts                        # PlanningReadiness + unconfirmedDispositions; formatPlanningBlockMessage + disposition branch;
│                                           # unresolvedDependencyFindings filter + NOT EXISTS confirmed non-keep dispositions
│   └── commands/
│       ├── plan.ts                         # runPlan: + collector pass before Phase 2b Planner; planner prompt + disposition-refinement
│                                           #        instructions; + confirmDispositions after Planner (research.md §2/§5)
│       └── migrate.ts                      # codePrompt + dispositionContextForArtifact suffix (research.md §10)
└── test/
    └── *.test.ts                           # new disposition schema/collector/confirmation/readiness/locked-set coverage
                                            # (quickstart.md "Regression coverage" section)

stacks/
└── java-spring/classification.yaml         # + dependencies: block (contracts/disposition-pack-yaml.md)

package/stacks/
└── java-spring/classification.yaml         # mirror — identical dependencies: block (DEVELOPMENT.md parity requirement)
```

**Structure Decision**: Extend the existing single-project layout in place — no
new package, no new top-level directory. Two new source files
(`migration/registry/commands/dispositions.ts`,
`migration/guildctl/dispositions.ts`) split along the repository's established
boundary: registry commands own persistence + decision semantics (like
`modernization.ts`), guildctl owns workspace scanning + stack-pack knowledge
(like `classification.ts`, `risk.ts`, `audit.ts`). The collector logic is
substantial enough (manifest extraction, usage analysis, proposal seeding, pack
loading) to warrant its own module rather than being folded into `plan.ts` —
the same reason `risk.ts` was not folded into `inventory.ts` in feature 005.

## Post-Design Constitution Re-Check

*Re-evaluated after Phase 1 (`data-model.md`, `contracts/`, `quickstart.md`) — GATE: must pass before `tasks.md`.*

- **I. Evidence Over Assertion**: confirmed — `data-model.md` requires
  `confirmed_by`/`confirmed_at` to be set together in the same statement as any
  status flip (never a bare flip), and every transition snapshots the prior row
  to `dependency_disposition_history` first — the sole decision-evidence trail
  per `contracts/registry-schema.md` ("Decision-evidence trail": no `events`
  rows, since dispositions have no `artifact_id`). Usage evidence
  (`usage_json`) is a stored registry value, not an agent claim.
- **II. Legacy Is Read-Only**: confirmed — no contract or entity involves a
  write to `legacy/` or `modern/`; FR-013 excludes all write-side changes
  (inlining, manifest edits) from v1.
- **III. Registry-Mediated Coordination**: confirmed — the design introduced no
  state outside the registry; the locked dependency set is a derived view over
  registry rows, not a separate store; confirmation and re-proposal invariants
  live inside single transactions in the commands module (same posture as
  `claimNextTask`'s single-transaction invariant enforcement).
- **IV. Separation of Powers**: still N/A — proposer (`planner-collector` /
  `planner-agent` / `operator-policy`) and confirmer (operator /
  `benchmark-runner`) are distinct recorded actors on every row; no
  builder/critic/arbiter role is introduced or altered.
- **V. Tests Before Production Code**: `quickstart.md`'s regression-coverage
  list is explicit and maps every behavior class (schema, collector, upsert
  semantics, validation, readiness, auto-confirm, locked set) to required
  `migration/test/*.test.ts` coverage for the tasks phase.
- **VI. Fail-Closed Automation**: confirmed — `contracts/cli-surface.md`
  documents the unset/non-interactive case precisely (rows pending, warning
  printed, no hang, readiness gate blocks); `contracts/disposition-pack-yaml.md`
  documents graceful degradation to keep-default proposals when pack knowledge
  is absent.
- **VII. Pluggable Stacks, Neutral Providers**: confirmed —
  `contracts/disposition-pack-yaml.md` keeps every stack-specific fact
  (manifest globs, import prefixes, native equivalents) in pack YAML with
  strict loader validation; core runtime holds only the stack-neutral engine.

No new violations surfaced during design. **Gate: PASS.**

## Complexity Tracking

*No entries — Constitution Check reported no violations requiring justification.*
