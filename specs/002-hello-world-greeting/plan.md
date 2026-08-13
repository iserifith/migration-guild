# Implementation Plan: Hello World Greeting

**Branch**: `spec/issue-94` | **Date**: 2026-08-14 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-hello-world-greeting/spec.md`

**Note**: This template is filled in by the `$speckit-plan` command; its definition describes the execution workflow.

## Summary

Provide a way for a user to request a greeting and always receive the exact text
"Hello, World!" — stateless, idempotent, no input, no configuration. The feature is a
throwaway smoke test for the `/hermes-spec` pipeline (issue #94); its purpose is to exercise
branch reuse, the single-PR pipeline, and the specify → plan → tasks → issues flow on a real
repository, not to solve a production problem.

Technical approach, in one line: add one pure function returning the constant greeting in the
`migration/` runtime, expose it through the existing `guildctl` CLI as a read-only
`guildctl greet` command, and pin the behavior with a `node:test` suite written before the
implementation. Full rationale in [research.md](./research.md).

## Technical Context

**Language/Version**: TypeScript 6.x on Node.js (types pinned to `@types/node` 25.5.0),
compiled with `tsc`/`tsup`; consistent with every other module in `migration/`.

**Primary Dependencies**: `commander` 12.1.0 (CLI, already pinned in `migration/package.json`).
**No new runtime dependency is introduced by this feature** — a constant string needs nothing
beyond the language.

**Storage**: N/A. The greeting is stateless; nothing is persisted, and no registry table is
touched.

**Testing**: `node:test` via `node --import tsx --test test/*.test.ts` in `migration/`,
running from the repo root as part of `npm test`. A new `greet.test.ts` suite joins the
existing suites in `migration/test/` and is written first (Constitution V).

**Target Platform**: cross-platform CLI — Linux, macOS, Windows. The feature has no
platform-divergent behavior (no process, path, or shell interaction).

**Project Type**: single-repository CLI toolkit. All runtime code lands in `migration/`
(registry + guildctl), per the constitution's Repository Source-of-Truth Boundaries. The
feature is repo-only plumbing validation; nothing agent-visible is shipped, so `package/` is
untouched (see Assumptions).

**Performance Goals**: greeting returns in O(1); CLI invocation completes in well under the
30-second preflight-style budget used elsewhere. No measurable performance requirement exists
beyond "perceived as instant" (SC-002).

**Constraints**:

- The greeting text is exactly `Hello, World!` (FR-002); identical on every invocation (FR-003).
- Read-only with respect to the registry and filesystem: no claim, no evidence row, no warden
  interaction, no workspace access.
- Output stays silence-first: the command prints the greeting and nothing else (Constitution VI).
- No new migration status, no new pipeline phase, no write-authorization change (mirrors the
  constitution's non-negotiables; this feature touches none of them).

**Scale/Scope**: 3 functional requirements, 1 user story (P1), 1 new source module
(`migration/guildctl/greet.ts`), 1 small CLI wiring change (`migration/guildctl/cli.ts`),
1 new test file (`migration/test/greet.test.ts`). This is the smallest change that exercises
the pipeline end to end.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Constitution: `.specify/memory/constitution.md` v1.0.0.

### Initial check (pre-research)

| Principle | Gate | Verdict |
|-----------|------|---------|
| **I. Evidence Over Assertion** (NON-NEGOTIABLE) | Does any change let an actor's self-report advance state? | **PASS.** The feature records no state and advances nothing. The test suite asserts on actual command output, not on an implementation claim. |
| **II. Legacy Read-Only; `modern/` Only Write Target** (NON-NEGOTIABLE) | Does anything write outside authorized paths? | **PASS.** The command is read-only: it prints a constant and touches neither `legacy/` nor `modern/`, nor any workspace path. |
| **III. Registry-Mediated Coordination** | Do new facts live in the registry? Do claims stay atomic? | **PASS.** No new facts exist; no claim, token, lease, or heartbeat semantics are touched. The registry is not involved. |
| **IV. Separation of Powers** | Could a producer certify its own work? | **PASS.** Nothing is produced that requires certification. The regression test is the independent check on behavior. |
| **V. Tests Before Production Code** | Are changes covered by tests written first? | **PASS.** The plan orders `migration/test/greet.test.ts` before `migration/guildctl/greet.ts`; kit behavior changes MUST ship with regression tests, and this one does. |
| **VI. Fail-Closed Automation** | Does automation stop rather than guess? Is output silence-first? | **PASS.** No automation path is added or altered. Output is a single line — the greeting — with no streaming noise. |
| **VII. Pluggable Stacks, Neutral Providers** | Does stack- or vendor-specific knowledge leak into core? | **PASS.** The greeting is stack- and provider-neutral; no stack pack or provider code changes. |
| **Repository Source-of-Truth Boundaries** | Is runtime mirrored? Are phases run against this repo? | **PASS.** One runtime module in `migration/`, no mirroring into `package/`, no migration phase is run against this repository root. |
| **Development Workflow and Quality Gates** | Pinned deps? `npm test` green? Maintainer checklist answered? | **PASS.** No new dependency. `npm test` must pass with the new suite. Maintainer checklist: repo-only change; `package/` not needed; `migration/` touched; docs/changelog not warranted for a throwaway smoke test (recorded as an assumption below). |

**Initial gate result: PASS.** No violations; Phase 0 proceeded.

### Post-design re-check (after Phase 1)

Re-evaluated against [data-model.md](./data-model.md), [contracts/guildctl-greet.md](./contracts/guildctl-greet.md),
and [quickstart.md](./quickstart.md):

- **I** — the contract defines the exact expected stdout and exit code, so the test asserts on
  observed behavior, not on a self-report. **PASS.**
- **II** — the contract states the command performs no filesystem writes; quickstart verifies by
  asserting a clean `git status` after invocation. **PASS.**
- **III/IV** — no registry or certification path is introduced. **PASS.**
- **V** — quickstart sequences the test suite as the acceptance mechanism and requires it to be
  authored before the implementation task in `tasks.md`. **PASS.**
- **VI/VII** — single-line output; no stack or provider coupling. **PASS.**

**Post-design gate result: PASS.** No entries required in Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/002-hello-world-greeting/
├── plan.md              # This file ($speckit-plan command output)
├── research.md          # Phase 0 output ($speckit-plan command)
├── data-model.md        # Phase 1 output ($speckit-plan command)
├── quickstart.md        # Phase 1 output ($speckit-plan command)
├── contracts/
│   └── guildctl-greet.md        # CLI contract for `guildctl greet`
├── checklists/
│   └── requirements.md  # pre-existing spec quality checklist (from specify phase)
└── tasks.md             # Phase 2 output ($speckit-tasks command - NOT created by $speckit-plan)
```

### Source Code (repository root)

```text
migration/                          # runtime: registry + orchestrator (repo-only source of truth)
├── guildctl/
│   ├── greet.ts                    # NEW — pure greeting function + command handler (FR-001..FR-003)
│   └── cli.ts                      # + register `greet` subcommand                    (FR-001)
└── test/
    └── greet.test.ts               # NEW — node:test suite, written first            (FR-002/003, Constitution V)
```

**Structure Decision**: single project, using the repository's existing layout. The change is
deliberately confined to `migration/` — the canonical source for registry and guildctl runtime
code — because a greeting is runtime behavior, not shipped agent content. `package/`, `stacks/`,
and `package/stacks/` are untouched. This split is mandated by the constitution's Repository
Source-of-Truth Boundaries section, not chosen here. The greeting logic lives in its own module
rather than inline in `cli.ts` so it is unit-testable without booting the CLI, matching how
`limits.ts`, `preflight.ts`, and other single-responsibility modules are organized.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

No violations. The Constitution Check passed at both gates, and no entry is required.

## Assumptions

Recorded autonomously (no human available during the plan phase); each is the best-supported
choice given the spec and constitution:

1. **Exposure point**: the greeting is exposed as a `guildctl greet` CLI subcommand. The spec
   requires "a way for a user to request a greeting" (FR-001) without naming a surface; the
   existing `guildctl` CLI is the repo's user-facing runtime surface and the cheapest one to
   test. A library-only export was considered and rejected because it provides no user-invocable
   path.
2. **Repo-only change**: nothing is added to `package/`. The feature validates pipeline
   mechanics, not shipped capability; shipping it to user workspaces would violate the
   Repository Source-of-Truth Boundaries rule that `package/` holds what users need.
3. **No docs/changelog entry**: the maintainer checklist rule on `CHANGELOGS.MD` covers
   "notable changes"; a throwaway smoke-test feature is explicitly fictional (spec
   Assumptions), so no changelog or docs update is planned. If a maintainer disagrees, that is
   a one-line addition during implementation.
4. **No contracts beyond the CLI**: the feature exposes no API, registry schema, or stack-pack
   interface, so `contracts/` contains exactly one CLI contract.
