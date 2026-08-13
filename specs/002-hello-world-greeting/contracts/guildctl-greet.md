# Contract: `guildctl greet`

**Feature**: `002-hello-world-greeting` | **Branch**: `spec/issue-94` | **Date**: 2026-08-14

The only external interface this feature exposes: one subcommand on the existing `guildctl`
CLI.

## Synopsis

```text
guildctl greet
```

## Arguments and Options

None. The command accepts no positional arguments and defines no options. Unknown arguments
are rejected by `commander`'s default strict handling (non-zero exit), consistent with the
other subcommands in `migration/guildctl/cli.ts`.

## Behavior

1. Writes exactly one line to stdout: `Hello, World!` (a single trailing newline, no other
   output).
2. Exits with code 0.
3. Performs **no** filesystem reads or writes outside its own process, **no** registry
   access, **no** network access, and **no** workspace resolution.
4. Is idempotent: any number of invocations, in any environment, produce byte-identical
   stdout.

## Output Contract

| Stream | Content |
|--------|---------|
| stdout | `Hello, World!\n` — exactly |
| stderr | empty |

| Condition | Exit code |
|-----------|-----------|
| Normal invocation | 0 |
| Unknown argument/option | 1 (commander strict-mode default) |

## Invariants (requirement traceability)

- Output text is exactly `Hello, World!` — FR-002.
- Output is identical on every invocation; no personalization, timestamps, or environment
  dependence — FR-003.
- One line, no decoration — Constitution VI (silence-first output).
- No writes anywhere — Constitution II (read-only behavior; nothing touches `legacy/`,
  `modern/`, or any workspace path).

## Verification

The contract is verified by `migration/test/greet.test.ts`:

1. `greet()` returns exactly `"Hello, World!"`.
2. N repeated calls return identical values (idempotency, FR-003).
3. Running the CLI subcommand prints exactly the contract line on stdout and exits 0.
