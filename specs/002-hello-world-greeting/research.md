# Phase 0 Research: Hello World Greeting

**Feature**: `002-hello-world-greeting` | **Branch**: `spec/issue-94` | **Date**: 2026-08-14

The Technical Context in [plan.md](./plan.md) contained no `NEEDS CLARIFICATION` markers —
the spec is intentionally trivial and the repository already pins every relevant technology
choice. This document records the small set of decisions that *were* made, with rationale, so
the plan is auditable rather than asserted.

## R1 — Where does the greeting capability live?

- **Decision**: a new module `migration/guildctl/greet.ts`, wired into `migration/guildctl/cli.ts`
  as a `greet` subcommand.
- **Rationale**: the spec requires a user-invocable way to request a greeting (FR-001).
  `guildctl` is the repository's existing user-facing CLI runtime; every user-invocable
  capability in this repo is a `guildctl` subcommand. Confining the change to `migration/`
  follows the constitution's Repository Source-of-Truth Boundaries.
- **Alternatives considered**:
  - Library-only export (no CLI): rejected — no user-invocable path, FR-001 unmet.
  - New top-level script or bin entry: rejected — adds a second CLI surface for a smoke test,
    and would need `package.json` bin churn.
  - Shipped agent content under `package/`: rejected — nothing about a greeting belongs in
    user workspaces; the constitution reserves `package/` for shipped capability.

## R2 — Greeting implementation shape

- **Decision**: a pure function `greet(): string` returning the constant `"Hello, World!"`,
  plus a thin command handler that writes it to stdout.
- **Rationale**: FR-003 requires identical output on every invocation; a pure constant
  function satisfies statelessness and idempotency by construction, and is unit-testable
  without booting the CLI (matching how `limits.ts` and `preflight.ts` keep resolvers
  separate from `cli.ts`).
- **Alternatives considered**:
  - Inline string in `cli.ts`: rejected — not unit-testable in isolation, diverges from the
    repo's module-per-resolver pattern.
  - Configurable greeting (config file, env var): rejected — the spec fixes the text and
    explicitly excludes configuration (spec Assumptions); adding a knob would violate FR-002.

## R3 — Testing approach

- **Decision**: one `node:test` suite, `migration/test/greet.test.ts`, asserting (a) the
  function returns exactly `"Hello, World!"`, (b) repeated calls return identical values, and
  (c) the CLI subcommand prints exactly that line and exits 0. Tests are written before the
  implementation (Constitution V).
- **Rationale**: the repo runs `node --import tsx --test test/*.test.ts` under
  `npm --prefix migration test`, which rolls up into root `npm test`. A new suite in
  `migration/test/` is the established pattern (58+ existing suites).
- **Alternatives considered**:
  - CLI-only end-to-end test without unit tests: rejected — the function-level contract
    (FR-003 idempotency) is cheaper to pin directly.
  - Snapshot testing: rejected — introduces a new test pattern the repo does not use; plain
    string equality is clearer for a constant.

## R4 — Registry, warden, and workspace interaction

- **Decision**: none. The command performs no registry access, no claim, no filesystem read or
  write outside its own process, and no workspace resolution.
- **Rationale**: the greeting is stateless (spec Edge Cases). Touching the registry would
  require claim/evidence semantics the spec does not ask for, and would drag in Constitution
  III obligations for zero benefit.
- **Alternatives considered**: recording greeting invocations as registry events — rejected as
  scope creep beyond FR-001..FR-003.

## R5 — Dependencies

- **Decision**: no new dependency. The CLI wiring uses the already-pinned `commander` 12.1.0.
- **Rationale**: the constitution requires fully pinned tool dependencies; the safest pinned
  set is the one that doesn't change. A constant string needs nothing beyond the language.
- **Alternatives considered**: none — any new dependency for a constant would be unjustifiable
  under the constitution's pinning rule.

## Outcome

All technical-context fields in [plan.md](./plan.md) are resolved with concrete values; no
`NEEDS CLARIFICATION` markers remain. Phase 1 proceeded.
