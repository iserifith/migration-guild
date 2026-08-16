# Interface Contracts: Truthful Run State

**Feature**: `001-truthful-run-state` | **Date**: 2026-07-31

The Migration Guild kit exposes four external interfaces. Everything in this feature is delivered
through one of them, so each has a contract file:

| Contract | Interface | Consumers | Requirements |
|----------|-----------|-----------|--------------|
| [registry-schema.md](./registry-schema.md) | SQLite registry DDL | every kit component; the durable coordination substrate | FR-001, FR-002, FR-030–FR-034 |
| [registry-cli.md](./registry-cli.md) | `registry` CLI (`migration/dist/registry/cli.js`) | agents in installed workspaces, guildctl, Mission Control | FR-001–FR-010, FR-034, FR-040–FR-044 |
| [guildctl-cli.md](./guildctl-cli.md) | `guildctl` CLI | operators | FR-008, FR-011–FR-019, FR-024–FR-033, FR-039 |
| [stack-pack-verify.md](./stack-pack-verify.md) | `stack.yaml` stack-pack manifest | stack pack authors; core reads it as data | FR-003, FR-004 |
| [environment-precedence.md](./environment-precedence.md) | process environment + `.env` loading | operators, every phase run | FR-020–FR-026 |

## Conventions

**Contract status**. Each entry is marked `NEW`, `CHANGED`, or `UNCHANGED (stated for completeness)`.
An `UNCHANGED` entry appears only where a reader might reasonably expect a change and its absence is
itself a commitment — most importantly the arbitration gate.

**Compatibility rule**. No existing command is removed and no existing output field changes meaning.
`get-context-path` keeps working. Every new registry column is nullable or defaulted, so an older row
and a newer reader coexist. The one intended behaviour change in the whole feature is environment
precedence (FR-020), which is why FR-026 requires it in operator docs and the changelog.

**Exit codes** follow the repository's existing convention: `0` success, `1` error/failure verdict,
`2` not-found / nothing-to-do. Preflight adds no new code — its `unvalidated` verdict exits `0` and is
distinguished by the verdict string, never by the exit code (see `guildctl-cli.md`).

**JSON output**. Every command that supports `--json` emits a single JSON document on stdout and
nothing else on stdout; human-readable output goes to stdout only in non-JSON mode, diagnostics to
stderr. This is what lets the acceptance scenarios in [../quickstart.md](../quickstart.md) assert on
structure rather than prose.

**Redaction**. Any contract that can carry a credential states its redaction rule explicitly. The
rule is the existing `isSensitiveEnvName` predicate in `migration/guildctl/verify.ts` — one
definition of "secret" for evidence logs, preflight output, and divergence reports alike.

**Silence-first**. Per Constitution VI, these contracts add exactly one new always-on line per phase
run (the resolved provider/model line, FR-024). Everything else is either inside the existing single
run summary, or on a command the operator explicitly invoked.
