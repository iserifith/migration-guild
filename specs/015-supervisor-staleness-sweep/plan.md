# Implementation Plan: Always-On Supervisor Staleness Sweep

**Branch**: `015-supervisor-staleness-sweep` | **Date**: 2026-09-01 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/015-supervisor-staleness-sweep/spec.md`

## Summary

`runAutoQueue` in `migration/guildctl/supervisor/queue.ts` currently calls `reapDeadRuns(db)` and `reconcileStaleClaims(db, "guildctl-auto-run")` exactly once, before its `while` loop starts claiming and processing artifacts. This feature adds a periodic re-invocation of that same reap/reconcile pair at loop-iteration boundaries — measured by elapsed wall-clock time since the last sweep, defaulting to 10 minutes and overridable via an environment variable — so a claim or run that goes stale mid-`auto-run` session is caught and released without an operator manually running `guildctl doctor` or `guildctl repair`. Findings from periodic sweeps are merged into the existing `recoveredArtifacts` result field and reported distinctly from the startup sweep in operator-facing output. Standalone `guildctl auto` is out of scope. A sweep failure is caught and logged as non-fatal; the loop keeps processing.

## Technical Context

**Language/Version**: TypeScript (Node.js 22), compiled/run via `tsx`/`tsup` per existing `migration/guildctl` conventions

**Primary Dependencies**: `better-sqlite3` (registry access), existing `migration/registry/commands/runs.ts` (`reapDeadRuns`) and `migration/registry/commands/claim.ts` (`reconcileStaleClaims`) — no new dependencies

**Storage**: Existing SQLite registry (WAL mode) accessed via the `Database.Database` handle already threaded through `runAutoQueue`; no schema changes

**Testing**: `node --import tsx --test migration/test/*.test.ts` (existing suite, run via `npm --prefix migration test`); extend `migration/test/auto-queue.test.ts` with new sweep-timing cases and inject a fake/controllable clock, following the existing pattern of injecting `executeArtifact`/`preflight` dependencies for hermetic tests

**Target Platform**: Same Node.js CLI process guildctl already runs in (Linux/macOS operator machines and CI); no new runtime targets

**Project Type**: Single project — CLI/registry tool (`migration/guildctl` + `migration/registry`), no frontend component touched

**Performance Goals**: Sweep must add negligible overhead to the loop — it runs only when the configured interval has elapsed (default every 10 minutes), and each sweep is the same handful of indexed SQL queries `reapDeadRuns`/`reconcileStaleClaims` already run once today, so no new performance budget is introduced

**Constraints**: Single-threaded, single-writer loop — the sweep MUST run synchronously between artifact iterations (never concurrently with an in-flight `executeArtifact` call), and MUST NOT throw in a way that aborts the queue (FR-007); interval configuration must follow the existing env-var convention (`GUILDCTL_STALL_MINS`-style), not a new CLI flag

**Scale/Scope**: Bounded to `runAutoQueue`'s existing loop in `migration/guildctl/supervisor/queue.ts`; touches its result-shape consumers (`migration/guildctl/commands/auto-run.ts` rendering) only insofar as sweep findings need to be visible in output; no changes to `guildctl auto` (single-artifact path), `doctor.ts`, or `monitoring.ts`

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **I. Evidence Over Assertion** — N/A to this feature's own correctness gates (it doesn't touch artifact evidence/arbitration), but the sweep itself must not fabricate recovery: it only reports what `reapDeadRuns`/`reconcileStaleClaims` actually changed in the registry. PASS.
- **II. Legacy Is Read-Only; `modern/` Is the Only Write Target** — Not applicable; this feature touches only `migration/guildctl` and `migration/registry` runtime code, never `legacy/`/`modern/` trees. PASS.
- **III. Registry-Mediated Coordination** — Directly reinforces this principle: "Claims MUST be recoverable without human intervention: lease expiry, run-ID cleanup, owner-ID cleanup, and stale-run reconciliation all release work back to the pool." This feature makes that recovery happen continuously during a session instead of only at its start. PASS.
- **IV. Separation of Powers** — Not applicable; no evidence/arbitration changes. PASS.
- **V. Tests Before Production Code** — Applies via the Development Workflow gate below ("Changes to claims, evidence gates, arbitration, warden scope, or phase control flow MUST ship with regression tests"). This feature changes supervisor loop control flow, so it MUST ship with `migration/test` coverage (extending `auto-queue.test.ts`) before/alongside the implementation. PASS, contingent on tasks including test coverage.
- **VI. Fail-Closed Automation** — Directly constrains the design: a sweep failure must be treated like other non-fatal supervisor conditions and reported, not silently swallowed, and it must never cause `auto-run` to dispatch another artifact on bad state. It also must not violate "Output MUST be silence-first" — sweep findings should be part of the run's existing reporting surface, not new streamed noise on every clean sweep (FR-006: no output when nothing stale is found). PASS, contingent on FR-006/FR-007 being honored in implementation.
- **VII. Pluggable Stacks, Neutral Providers** — Not applicable; no stack-pack, provider, or harness code touched. PASS.

No violations requiring Complexity Tracking justification.

## Project Structure

### Documentation (this feature)

```text
specs/015-supervisor-staleness-sweep/
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
├── guildctl/
│   ├── supervisor/
│   │   └── queue.ts              # runAutoQueue: add periodic sweep inside the while loop
│   ├── commands/
│   │   └── auto-run.ts           # renderSummary/output: surface periodic-sweep findings
│   └── config.ts                 # add sweep-interval env var resolution (or co-locate in queue.ts)
├── registry/
│   └── commands/
│       ├── runs.ts               # reapDeadRuns — reused as-is, no changes expected
│       └── claim.ts              # reconcileStaleClaims — reused as-is, no changes expected
└── test/
    └── auto-queue.test.ts        # extend with periodic-sweep timing/behavior tests
```

**Structure Decision**: Single project (existing `migration/guildctl` + `migration/registry` CLI/registry tool). All changes are localized to the supervisor queue loop and its immediate output/config surface; no new top-level directories, no changes to `package/` (this is Guild kit runtime code, not shipped Agent artifacts, per the constitution's Repository Source-of-Truth Boundaries) unless a maintainer determines the env var needs documenting in `package/` docs — deferred to task-time judgment call, tracked as a task rather than a plan-level structural decision.

## Complexity Tracking

*No Constitution Check violations — section not applicable.*
