# Implementation Plan: Truthful Run State

**Branch**: `001-truthful-run-state` | **Date**: 2026-07-31 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-truthful-run-state/spec.md`

**Note**: This template is filled in by the `$speckit-plan` command; its definition describes the execution workflow.

## Summary

A migration run must tell the truth about its own state. This feature adds six recorded facts and
corrects the reporting around them, without adding a pipeline phase, a migration status, or a gate.

1. **Verification becomes a fact distinct from status** (FR-001–FR-010). A new
   `artifact_verifications` table records *verified* / *unverified* / *verification-failed* with
   method, time, and a machine-readable reason. The check itself is declared by the workspace's stack
   pack, scoped to the claimed artifact's own outputs plus one hop of declared dependencies, and
   bounded by a configurable wall-clock budget. An artifact never blocks on a tree-wide build.
2. **Preflight validates the resolved path** (FR-011–FR-019). `guildctl preflight` resolves the
   harness, provider, and model through the *same* resolver the runner uses, issues one minimal live
   request, and asserts on the response — replacing three checks that today assert on a different
   object than the run uses.
3. **Project `.env` wins and divergence is always spoken** (FR-020–FR-026). An explicit loader
   snapshots the ambient environment, applies project-file precedence by default, and reports every
   diverging variable with both values, the winner, and secrets redacted.
4. **Limit messages name the knob that fired** (FR-027–FR-029). One limit resolver returns a
   descriptor; the termination message and a new `guildctl limits` command both read from it, so the
   named knob is by construction the one that governed.
5. **Closing summaries state the real outcome** (FR-030–FR-034). New columns on `runs` carry files
   written, status transition, claim disposition, budget consumption, and cleanup result; a
   no-progress termination can no longer wear a success-equivalent label.
6. **Termination reaches the whole process tree** (FR-035–FR-039) and **context retrieval always
   returns something usable** (FR-040–FR-044).

Technical approach, in one line: extract shared resolvers (launch, limit, context) so that reporting
cannot drift from behaviour, record the new facts in the existing registry, and keep every
stack-specific and provider-specific decision behind the interfaces the constitution already
defines. Full rationale in [research.md](./research.md).

## Technical Context

**Language/Version**: TypeScript 6.x on Node.js (types pinned to `@types/node` 25.5.0), compiled with
`tsc`/`tsup`; packaged harness adapters are plain ESM `.mjs`.

**Primary Dependencies**: `better-sqlite3` 12.8.0 (registry), `commander` 12.1.0 (CLI), `dotenv`
17.4.0 (environment loading), `yaml` 2.8.1 (stack packs). All pinned with explicit `overrides` in
`migration/package.json`. **No new runtime dependency is introduced by this feature** — process-group
termination, the live provider probe, and the environment loader are built from Node built-ins and
the already-present `dotenv` parser.

**Storage**: SQLite in WAL mode, one registry per workspace. Schema is
`migration/registry_schema.sql`, applied by `migration/registry/db/schema.ts`, which splits the file
at the migrations marker and adds columns idempotently through its `ensureColumn` guard (this SQLite
build rejects `ADD COLUMN IF NOT EXISTS`).

**Testing**: `node:test` via `node --import tsx --test test/*.test.ts` in `migration/`, plus the
Mission Control UI suite; both run from the repo root as `npm test`. New suites join the existing 58
files in `migration/test/`. Provider calls and process trees are tested through injected seams, never
live (see research R15).

**Target Platform**: cross-platform CLI — Linux, macOS, and Windows. Windows is a first-class
constraint for this feature specifically: process-tree termination (R8) and portable context-path
resolution (R12) are both platform-divergent by nature.

**Project Type**: single-repository CLI toolkit with a packaged distributable. Two source roots with
a strict boundary: `migration/` is the runtime (registry + guildctl), `package/` is the source of
truth for everything shipped into user workspaces. Runtime code is never mirrored between them.

**Performance Goals**: preflight returns a verdict within 30 seconds (SC-001, FR-017 default budget);
per-artifact verification completes inside its budget in ≥95% of attempts and exceeds it in 0%
(SC-006, enforced by termination rather than hope); registry queries added for status and counted
conditions stay `COUNT`-shaped so they remain fast on the ~3,000-artifact registries the existing
doctor checks are already sized for.

**Constraints**:

- No new migration status values, no new pipeline phase, no widening of agent write authorization
  (spec Out of Scope).
- Verification state must never satisfy the arbitration gate (Constitution IV; research R11).
- Claim recoverability outranks cleanup completeness: a claim is released even when process cleanup
  fails (spec Assumptions, FR-039).
- Secrets redacted in every output path, including divergence reports and preflight failures
  (FR-019, FR-023; Constitution VI).
- Output stays silence-first: one summary per run, one run-start line (Constitution VI).
- Verification performs no unbounded filesystem search and never reads outside the workspace
  (FR-005).

**Scale/Scope**: 44 functional requirements across six areas; ~3,000-artifact registries; 6 user
stories prioritized P1–P6 and independently testable. Touched surfaces: 4 guildctl modules
(`runner`, `harness`, `config`, `cli`) plus 2 new ones (`preflight`, `env`), 3 registry command
modules, 1 schema file, 2 stack packs in both `stacks/` and `package/stacks/`, 4 packaged agent
definitions, and 4 documentation files.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Constitution: `.specify/memory/constitution.md` v1.0.0.

### Initial check (pre-research)

| Principle | Gate | Verdict |
|-----------|------|---------|
| **I. Evidence Over Assertion** (NON-NEGOTIABLE) | Does any change let an actor's self-report advance state? Is exit code zero ever treated as completion? | **PASS — reinforcing.** The feature exists to remove a self-report path: `migrated` stops implying "checked". Preflight replaces three assertions about configuration with one assertion about a response. FR-031 forbids labelling a no-progress termination as success. |
| **II. Legacy Read-Only; `modern/` Only Write Target** (NON-NEGOTIABLE) | Does anything write outside authorized paths, or broaden them? | **PASS.** Verification only reads, and FR-005 confines it to the workspace. FR-010 *reports* an out-of-scope-path blockage; broadening write authorization is explicitly out of scope, and the warden's allow-list is untouched. |
| **III. Registry-Mediated Coordination** | Do new facts live in the registry? Do claims stay atomic and recoverable? | **PASS.** All six new facts are registry rows or columns. No claim, token, lease, or heartbeat semantics change. Cleanup failure never blocks claim release. |
| **IV. Separation of Powers** | Could a producer certify its own work? | **PASS — with an explicit guardrail.** The per-unit check is builder-side, so research R11 fixes it as triage input only: the arbiter gate keeps requiring independent verifier evidence, and a regression test asserts that `verified` without passing runtime evidence is still rejected. |
| **V. Tests Before Production Code** | Are claim / evidence / warden / phase-control changes covered by regression tests, written first? | **PASS.** This feature touches claims, run lifecycle, warden reporting, and phase control flow, so tests-first is mandatory and is carried into task ordering. |
| **VI. Fail-Closed Automation** | Does automation stop rather than guess? Are timeouts terminal? Are secrets redacted? Is output silence-first? | **PASS — reinforcing.** Preflight fails closed and offline mode returns `unvalidated` rather than green. Termination now actually terminates (FR-035–FR-038). Redaction is required in every new output. New output is one run-start line plus fields inside the existing single summary. |
| **VII. Pluggable Stacks, Neutral Providers** | Does stack- or vendor-specific knowledge leak into core? | **PASS.** The per-unit check is declared in `stack.yaml`, never in core (research R2). The live probe stays OpenAI-compatible and config-driven. Harness swappability and the `AGENT_CMD` escape hatch are preserved — and the shared launch resolver strengthens them by giving preflight and the runner one code path. |
| **Repository Source-of-Truth Boundaries** | Is shipped capability represented in `package/`? Is runtime mirrored? Are phases run against this repo? | **PASS.** Agent-visible changes (context guidance, close-out expectations, verification reporting) land in `package/`; stack `verify:` blocks land in both `stacks/` and `package/stacks/`, which are identical today. No runtime code is mirrored. Installed behaviour is validated in a workspace outside this repository. |
| **Development Workflow and Quality Gates** | Pinned deps? `npm test` green? Maintainer checklist answered? Docs and changelog updated? | **PASS.** No new dependency. FR-026 and FR-029 already require operator docs; `CHANGELOGS.MD` and `DEVELOPMENT.md` updates are in scope by the workflow rule for claim/run-lifecycle changes. |

**Initial gate result: PASS.** No violations; Phase 0 proceeded.

### Post-design re-check (after Phase 1)

Re-evaluated against the concrete artifacts in [data-model.md](./data-model.md) and
[contracts/](./contracts/):

- **I** — `artifact_verifications.state` is `NOT NULL` with a 3-value `CHECK`, and `reason` is
  mandatory for the two non-verified states, so a verification fact cannot be recorded without saying
  how it was reached. `runs.outcome_label` has no value that reads as success for a no-progress
  attempt. **PASS.**
- **II** — the verification contract requires every resolved path to be asserted inside the workspace
  root before a command is built, and the stack `verify:` contract permits no path escape.
  **PASS.**
- **III** — the schema delta is two new tables' worth of facts expressed as one new table plus eight
  nullable columns on `runs`; no claim table column changes. **PASS.**
- **IV** — `contracts/registry-cli.md` marks the verification commands as triage-only and states the
  gate invariant; the required regression test is named in the contract. **PASS.**
- **V** — [quickstart.md](./quickstart.md) sequences the regression tests as the acceptance mechanism
  per user story. **PASS.**
- **VI** — the preflight contract defines three verdicts with `unvalidated` distinct from `pass`, and
  the divergence contract mandates redaction by the existing `isSensitiveEnvName` rule. **PASS.**
- **VII** — the stack-pack contract is the only place a build/test command may appear; core reads it
  as data. **PASS.**

**Post-design gate result: PASS.** No entries required in Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/001-truthful-run-state/
├── plan.md              # This file ($speckit-plan command output)
├── research.md          # Phase 0 output ($speckit-plan command)
├── data-model.md        # Phase 1 output ($speckit-plan command)
├── quickstart.md        # Phase 1 output ($speckit-plan command)
├── contracts/           # Phase 1 output ($speckit-plan command)
│   ├── README.md                    # index + conventions
│   ├── registry-schema.md           # DDL delta (new table, new columns)
│   ├── registry-cli.md              # verification, context, outcome commands
│   ├── guildctl-cli.md              # preflight, limits, status, run-start, summary
│   ├── stack-pack-verify.md         # stack.yaml `verify:` block schema
│   └── environment-precedence.md    # loader + divergence report contract
├── checklists/
│   └── requirements.md  # pre-existing spec quality checklist
└── tasks.md             # Phase 2 output ($speckit-tasks command - NOT created by $speckit-plan)
```

### Source Code (repository root)

```text
migration/                          # runtime: registry + orchestrator (repo-only source of truth)
├── registry_schema.sql             # + artifact_verifications table, + runs columns   (FR-001/002, 030-034)
├── registry/
│   ├── db/schema.ts                # + ensureColumn calls for the new runs columns
│   ├── types.ts                    # + VerificationState, ContextResponse, AttemptOutcome types
│   ├── cli.ts                      # + set-verification, get-verification, get-context,
│   │                               #   list-verification, show-no-progress-attempts
│   └── commands/
│       ├── verification.ts         # NEW — verification read/write + status roll-up   (FR-001-009)
│       ├── context.ts              # portable resolution, summary fallback, form label (FR-040-043)
│       └── runs.ts                 # + attempt-outcome fields on finishRun
└── guildctl/
    ├── env.ts                      # NEW — precedence loader + divergence report      (FR-020-023)
    ├── preflight.ts                # NEW — 3-stage probe, injectable fetch            (FR-011-019)
    ├── limits.ts                   # NEW — limit descriptor resolver                  (FR-027-029)
    ├── harness.ts                  # + resolveAgentLaunch() shared by runner+preflight (FR-011)
    ├── runner.ts                   # process-group spawn/kill, honest summary, outcome (FR-030-039)
    ├── verify.ts                   # + bounded per-artifact verification              (FR-003-005)
    ├── warden.ts                   # + named out-of-scope-path condition              (FR-010)
    ├── config.ts                   # + verification.budget_seconds, termination grace
    ├── cli.ts                      # + preflight, limits; doctor delegates to preflight
    ├── commands/
        ├── status.ts               # + verified/unverified/failed split, no-progress counts (FR-008)
        ├── migrate.ts              # phase dispatch; limit descriptors                 (FR-027/029)
        ├── auto.ts                 # autonomous dispatch, preflight, and agent spawn  (FR-011/024/030-039)
        └── review.ts               # verification state visible to review              (FR-009)
    └── supervisor/
        └── loop.ts                 # autonomous claim close, verification, outcomes    (FR-001/030-039)

migration/test/                     # node:test regression suites (tests written first)
├── verification-state.test.ts      # NEW  (US1)
├── verification-bounds.test.ts     # NEW  (US1: scope, budget, no out-of-workspace reads)
├── preflight-resolved-path.test.ts # NEW  (US2)
├── env-precedence.test.ts          # NEW  (US3)
├── limit-knob-naming.test.ts       # NEW  (US4)
├── attempt-outcome.test.ts         # NEW  (US4)
├── process-tree-termination.test.ts# NEW  (US5)
├── context-retrieval.test.ts       # NEW  (US6)
├── registry-schema-delta.test.ts   # NEW  (foundational)
├── run-outcome-plumbing.test.ts    # NEW  (foundational)
├── runtime-resolution.test.ts      # NEW  (foundational)
├── process-group-primitives.test.ts# NEW  (foundational)
└── arbiter-gate.test.ts            # EXTENDED — verified-without-evidence still rejected (R11)

stacks/{java-spring,python}/stack.yaml          # + verify: block                       (FR-003)
package/stacks/{java-spring,python}/stack.yaml  # shipped copy; T069 reconciles Python before parity gate

package/                            # source of truth for everything shipped to workspaces
├── agents/{code-writer,test-writer,codegen,test}-agent.agent.md   # consume returned context (FR-044)
└── agent-instructions.md           # close-out expectations, verification reporting

README.md / GETTING-STARTED.md      # operator docs: precedence change, limits    (FR-026, FR-029)
DEVELOPMENT.md / CHANGELOGS.MD      # maintainer docs: behaviour change record    (FR-026)
```

**Structure Decision**: single project, using the repository's existing two-root split. Runtime
changes land in `migration/` (registry schema and commands, guildctl modules); everything
agent-visible lands in `package/`; stack-specific checks land in the stack packs in both
`stacks/` and `package/stacks/`, which must be byte-identical after the baseline reconciliation and
must stay so. This split is mandated by the
constitution's Repository Source-of-Truth Boundaries section, not chosen here. Three new guildctl
modules (`env.ts`, `preflight.ts`, `limits.ts`) and one new registry command module
(`verification.ts`) are added rather than growing `cli.ts` and `runner.ts`, because each is a
resolver that must be independently unit-testable — that testability is what makes the "reporting
cannot drift from behaviour" property checkable rather than aspirational.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

No violations. The Constitution Check passed at both gates, and no entry is required.

Two design choices that *could* have become violations were resolved conservatively in Phase 0 and
are recorded here for reviewer attention rather than as justifications:

- The per-unit verification check would have violated Principle VII if implemented in core; it is
  declared in stack packs instead (research R2).
- Verification state would have violated Principle IV if it could satisfy the arbiter gate; it is
  fixed as triage-only input with a named regression test (research R11).
