# Implementation Plan: Automated Risk Scoring for Legacy Artifacts at Inventory Time

**Branch**: `005-artifact-risk-scoring` | **Date**: 2026-08-16 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/005-artifact-risk-scoring/spec.md`

**Note**: This template is filled in by the `$speckit-plan` command; its definition describes the execution workflow.

## Summary

Add a deterministic, heuristic risk scanner that runs during the Inventory phase
(`migration/guildctl/commands/inventory.ts`'s `scanAndRegister`/`runInventory`),
computing a `risk_score` and reason codes per artifact from three signals —
reflection/dynamic-invocation usage, God methods (excessive method length), and
cyclomatic-complexity hotspots — persisted registry-side in a new
`artifact_risk_assessments` table that structurally mirrors the existing
`artifact_classifications` table (`migration/guildctl/classification.ts`). Thresholds
for each heuristic and the high-risk cutoff are configurable per stack pack via a new
`risk:` block in each pack's `classification.yaml`, with built-in defaults when a pack
doesn't override them. Artifacts scoring above their stack pack's cutoff get a
`risk_confirmations` row and are excluded from the claim pool
(`migration/registry/commands/claim.ts`'s `claimNextTask`/`claimArtifactById`) until an
operator explicitly confirms them — surfaced through a new Plan-phase step,
`confirmHighRiskArtifacts`, that reuses `confirmMappings`'s interactive-prompt /
env-var-bypass shape (`plan.ts`) but enforces the actual gate at the claim boundary
rather than blocking the whole Planner phase, so low-risk work can still be planned
and wave-assigned around pending high-risk artifacts (per User Story 4). Full
technical rationale is in [research.md](./research.md); persisted shapes are in
[data-model.md](./data-model.md); interface contracts are in [contracts/](./contracts/).

## Technical Context

**Language/Version**: TypeScript, compiled via `tsc` (see `migration/tsconfig.json`); Node.js runtime (native `node --test` for tests, no transpilation needed at test time thanks to `tsx`).

**Primary Dependencies**: `better-sqlite3` (registry access), `commander` (CLI), `yaml` (stack pack config parsing) — all already present in `migration/package.json`. No new runtime dependency is introduced (see research.md §2: AST/complexity libraries were evaluated and rejected in favor of the existing text/regex-heuristic idiom already used by `classification.ts` and `audit.ts`).

**Storage**: SQLite registry (`better-sqlite3`, WAL mode), schema defined in `migration/registry_schema.sql` and applied via `migration/registry/db/schema.ts`. Two new tables (`artifact_risk_assessments`, `risk_confirmations`); no changes to existing tables/columns.

**Testing**: Node's built-in test runner via `tsx` — `node --import tsx --test test/*.test.ts`, invoked by `migration/package.json`'s `test` script, in turn invoked by root `npm run test`. Tests live flat under `migration/test/*.test.ts`, use `node:test`/`node:assert/strict`, and exercise a real in-memory `better-sqlite3` database (`new Database(":memory:")` + `applySchema(db)`) with fixture repos copied from `stacks/` — no mocking framework, per existing convention.

**Target Platform**: Linux/macOS developer and CI environments running the `guildctl`/`registry` Node CLIs against a user's legacy-code workspace (this feature does not touch the separate `migration/ui` Vitest-based Mission Control UI package).

**Project Type**: Single TypeScript CLI/library project (`migration/` — registry + guildctl orchestrator), extended, not restructured.

**Performance Goals**: The scanner runs once per artifact per Inventory pass, in-process, over already-read source text (no new file I/O beyond what classification already does) — expected to add low-single-digit-percent wall time to Inventory for typical legacy codebases; no explicit throughput target stated in spec, and none is needed since this is a one-shot batch scan, not a hot path.

**Constraints**: Must not introduce a new npm dependency (research.md §2); must not modify `legacy/` (Principle II — scanner is read-only over legacy source); must not weaken existing claim atomicity guarantees (Principle III) — the new `NOT EXISTS` clause added to `claimNextTask`/`claimArtifactById` must stay inside the existing single-transaction claim logic, not a separate pre-check race-prone step.

**Scale/Scope**: Same order of magnitude as existing classification — every artifact registered during Inventory whose `kind` is source-bearing (at minimum `legacy-source`, matching what `classifyArtifactSource` already scans) gets a risk assessment; no separate scale concern beyond what Inventory already handles today.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design below.*

| Principle | Assessment | Gate |
|---|---|---|
| I. Evidence Over Assertion | Risk scores and reason codes are computed deterministically from source text and persisted as registry rows (`artifact_risk_assessments`), not asserted by an agent. Confirmation decisions (`risk_confirmations`) are durably recorded with `decided_by`/`decided_at`, mirroring the existing evidence-recording discipline for `stack_mappings.confirmed`. | PASS |
| II. Legacy Is Read-Only; `modern/` Is the Only Write Target | The scanner only reads `legacy/` source files (same `fs.readFileSync` pattern `classifyArtifactSource` already uses) and writes exclusively to the registry. No new writes to `legacy/` or `modern/` anywhere in this feature. | PASS |
| III. Registry-Mediated Coordination | All new state (`artifact_risk_assessments`, `risk_confirmations`) lives in the shared SQLite registry. The claim-eligibility check is added inside `claimNextTask`'s existing single transaction, preserving atomic-claim guarantees — no new coordination channel introduced. | PASS |
| IV. Separation of Powers: Builder, Critic, Arbiter | Not directly implicated — risk scoring is a deterministic pre-migration signal, not a build/review/arbitration step. The human confirmation gate is an operator decision point, structurally analogous to `stack_mappings` confirmation (also not part of the Builder/Critic/Arbiter chain). | N/A / PASS |
| V. Tests Before Production Code | This plan phase produces no production code (per hard constraint below); `tasks.md` (a later phase) must sequence new `migration/test/*.test.ts` coverage before/alongside the scanner, schema, and gate implementation, per Constitution §V ("Changes to claims, evidence gates, arbitration, warden scope, or phase control flow MUST ship with regression tests" — this feature touches claim eligibility and a new evidence gate, so it is explicitly in scope for that requirement). | Deferred to tasks.md — flagged, not violated |
| VI. Fail-Closed Automation | An unattended run with `GUILDCTL_AUTO_CONFIRM_RISK` unset never silently claims a high-risk artifact — the claim-gate `NOT EXISTS` check is unconditional and has no bypass path outside the explicit env var (research.md §5). `auto-run`'s existing "continue independent work after one artifact blocks" behavior is preserved: a pending-confirmation artifact simply isn't claimed, other artifacts proceed. | PASS |
| VII. Pluggable Stacks, Neutral Providers | Every threshold (`god_method_max_lines`, `cyclomatic_complexity_limit`, `high_risk_score_cutoff`) and every detection pattern (`method_boundary`, `reflection_patterns`) lives in stack-pack YAML (`classification.yaml`'s new `risk:` block), not hardcoded in core runtime code — directly satisfying FR-007/FR-008 and this principle's "per-stack rules... MUST live in stack packs, not in core runtime code." | PASS |

No violations requiring justification. **Complexity Tracking is not filled in.**

## Project Structure

### Documentation (this feature)

```text
specs/005-artifact-risk-scoring/
├── plan.md              # This file ($speckit-plan command output)
├── research.md          # Phase 0 output ($speckit-plan command)
├── data-model.md         # Phase 1 output ($speckit-plan command)
├── quickstart.md        # Phase 1 output ($speckit-plan command)
├── contracts/           # Phase 1 output ($speckit-plan command)
│   ├── registry-schema.md
│   ├── risk-spec-yaml.md
│   └── cli-surface.md
└── tasks.md             # Phase 2 output ($speckit-tasks command - NOT created by $speckit-plan)
```

### Source Code (repository root)

This is a single existing TypeScript CLI/library project — no new top-level
directories. The feature extends existing modules under `migration/` in place,
following the file organization already established for the classification/audit/plan
seams this feature is built alongside:

```text
migration/
├── registry_schema.sql                     # + artifact_risk_assessments, risk_confirmations (contracts/registry-schema.md)
├── registry/
│   ├── db/schema.ts                        # applySchema — new tables need no ensureColumn guard (both are new tables)
│   └── commands/
│       ├── artifacts.ts                    # registerArtifact — unchanged; risk scoring is a separate pass, not folded in (research.md §1)
│       └── claim.ts                        # claimNextTask, claimArtifactById — + NOT EXISTS risk_confirmations clause (contracts/registry-schema.md)
├── guildctl/
│   ├── classification.ts                   # ClassificationSpec — + risk: block parsing/validation (contracts/risk-spec-yaml.md), OR a small sibling module reusing loadClassificationSpec's file
│   ├── risk.ts                             # NEW — RiskSpec loader/validator, scanner (method-boundary detection, God-method/complexity/reflection heuristics), applyRiskAssessment upsert, mirrors classification.ts's shape
│   ├── audit.ts                            # collectLineMatches — reused/shared by risk.ts's reflection-pattern matching, not duplicated
│   └── commands/
│       ├── inventory.ts                    # scanAndRegister/runInventory — + risk-assessment pass after classification batch, before validateInventoryQuality (research.md §1)
│       └── plan.ts                         # confirmMappings — + new confirmHighRiskArtifacts, called after Phase 2b Planner (research.md §5)
└── test/
    └── *.test.ts                           # new risk-scanner, schema, and gate coverage (quickstart.md "Regression coverage" section)

stacks/
├── java-spring/classification.yaml         # + risk: block (contracts/risk-spec-yaml.md)
└── python/classification.yaml              # + risk: block (contracts/risk-spec-yaml.md)

package/stacks/                             # shipped-pack mirrors — identical risk: blocks (DEVELOPMENT.md parity requirement)
├── java-spring/classification.yaml         # mirror of stacks/java-spring/classification.yaml
└── python/classification.yaml              # mirror of stacks/python/classification.yaml
```

**Structure Decision**: Extend the existing single-project layout in place — no new
package, no new top-level directory, no frontend/backend split (this is a CLI/registry
kit, not a web app). The one new source file is `migration/guildctl/risk.ts`, sized
and shaped like its direct precedent `migration/guildctl/classification.ts`, because
the feature is explicitly instructed to mirror that pattern and because the scoring/
validation/upsert logic is substantial enough (three heuristics, YAML schema
validation, batch upsert) to warrant its own module rather than being folded into
`inventory.ts` or `classification.ts` directly — consistent with how `audit.ts` is
already its own module for the same reason (StackAuditRule matching is a distinct
concern from classification signal matching, even though both are regex-over-source-text).

## Post-Design Constitution Re-Check

*Re-evaluated after Phase 1 (`data-model.md`, `contracts/`, `quickstart.md`) — GATE: must pass before `tasks.md`.*

- **I. Evidence Over Assertion**: confirmed — `data-model.md` Entity 3's state machine
  requires `decided_by`/`decided_at` set together, never a bare status flip; the
  claim-eligibility contract (`contracts/registry-schema.md`) makes confirmation the
  single unconditional gate, no alternate path to bypass it.
- **II. Legacy Is Read-Only**: confirmed — no contract or data-model entity involves a
  write to `legacy/`; the scanner remains read-only, matching `classifyArtifactSource`.
- **III. Registry-Mediated Coordination**: confirmed — the claim-gate SQL addition in
  `contracts/registry-schema.md` is a single `AND NOT EXISTS` clause inside
  `claimNextTask`'s existing transaction, not a new out-of-band check; no new
  coordination mechanism outside the registry was introduced during design.
  Optimistic-concurrency claim semantics are unchanged.
- **IV. Separation of Powers**: still N/A — no builder/critic/arbiter role is
  introduced or altered by risk scoring or confirmation.
- **V. Tests Before Production Code**: `quickstart.md`'s "Regression coverage this
  quickstart maps to" section explicitly enumerates the `migration/test/*.test.ts`
  additions `tasks.md` must sequence ahead of/alongside implementation, satisfying the
  Constitution's requirement that changes to claim/evidence-gate/phase-control-flow
  semantics ship with regression tests.
- **VI. Fail-Closed Automation**: confirmed — `contracts/cli-surface.md`'s
  `GUILDCTL_AUTO_CONFIRM_RISK` contract explicitly documents the unset/non-interactive
  case: pending artifacts stay pending and unclaimable, the process does not hang or
  silently proceed.
- **VII. Pluggable Stacks, Neutral Providers**: confirmed — `contracts/risk-spec-yaml.md`
  keeps every threshold and detection pattern in stack-pack YAML; `migration/guildctl/risk.ts`
  (core runtime) only holds the generic scanning/scoring engine, never a
  language-specific pattern hardcoded outside a stack pack's config.

No new violations surfaced during design. **Gate: PASS.**

## Complexity Tracking

*No entries — Constitution Check reported no violations requiring justification.*
