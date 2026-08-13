# Quickstart: Hello World Greeting

**Feature**: `002-hello-world-greeting` | **Branch**: `spec/issue-94` | **Date**: 2026-08-14

Runnable validation scenarios proving the feature works end to end. See
[contracts/guildctl-greet.md](./contracts/guildctl-greet.md) for the exact CLI contract and
[data-model.md](./data-model.md) for the entity definition.

## Prerequisites

- Node.js and npm installed (per repo `README.md` / `GETTING-STARTED.md`).
- Repository checked out on branch `spec/issue-94`.
- Dependencies installed: `npm ci` at the repo root, then `npm --prefix migration ci`.

## Scenario 1 — User Story 1: receive a greeting (P1)

Validates FR-001, FR-002, SC-001, SC-002.

1. Run the greeting command:

   ```bash
   node --import tsx migration/guildctl/cli.ts greet
   ```

   (or the built `guildctl greet` equivalent, if the dist build is present).

2. Expected outcome:
   - stdout is exactly `Hello, World!` followed by a single newline;
   - stderr is empty;
   - exit code is 0;
   - the response is immediate (perceived as instant).

## Scenario 2 — idempotency and statelessness (edge case)

Validates FR-003.

1. Run the command three times in quick succession, capturing output:

   ```bash
   for i in 1 2 3; do node --import tsx migration/guildctl/cli.ts greet; done
   ```

2. Expected outcome: three identical lines, each exactly `Hello, World!`.

## Scenario 3 — no side effects (Constitution II)

1. Run `git status --short` before and after invoking the command.
2. Expected outcome: identical output — the command creates, modifies, and deletes nothing.

## Scenario 4 — regression suite (Constitution V)

The behavior is pinned by a test suite that is authored **before** the implementation in
`tasks.md`:

```bash
npm --prefix migration test -- --test-name-pattern=greet
```

(or the plain `npm --prefix migration test` full run).

Expected outcome: `migration/test/greet.test.ts` passes — function-level equality,
repeated-call idempotency, and CLI-level stdout/exit-code assertions all green. Root
`npm test` remains green overall.

## Pipeline success criterion (SC-003)

The meta-goal of this feature: the artifacts in this directory (`spec.md`, `plan.md`,
`research.md`, `data-model.md`, `contracts/`, `quickstart.md`, and later `tasks.md`) were
produced by successive speckit phases on the single branch `spec/issue-94` carrying a single
pull request — demonstrating specify → plan → tasks → issues mechanics on issue #94.
