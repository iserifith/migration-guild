# CLI Command Contracts: guildctl Operational Hardening

`guildctl` is a CLI tool; its external interface is its commands' flags, exit codes, and stdout/stderr
shape. This document specifies the contract changes each fix makes, so tasks/tests can assert against
concrete before/after behavior instead of re-deriving it from the issues each time.

## `guildctl arbitrate` (US1 / #153)

**New flags**:
- `--run-id <id>` (optional) — an existing run to scope the operator credential to.
- `--operator-token <token>` (optional) — a previously minted operator token for that run.

**Behavior**:
- If both `--run-id` and `--operator-token` are supplied and valid, they are used directly (existing
  `approveArtifactWithEvidence`/`rejectArtifactWithEvidence` validation path, unchanged).
- If neither is supplied, `arbitrate` mints an ad-hoc run + operator credential (via the existing
  `createRunOperatorCredential`) scoped to this one invocation and uses it transparently — no new flag
  is *required* for the common manual case to work.
- If `--run-id` is supplied but the credential is missing/invalid, or evidence independence fails
  (`assertApprovalEvidenceIsIndependent`), the command exits non-zero with a single-line message on
  stderr describing the failure — never an uncaught exception / raw stack trace.

**Exit codes**: `0` on successful approve/reject; non-zero on any `RegistryError` or validation
failure, with the message printed cleanly first.

## `guildctl auto --resume` (US3 / #155)

**Behavior change**: `--resume` now accepts an artifact in `blocked` status as a valid resume source,
in addition to whatever statuses it already accepted.

**Error behavior**: If resume is attempted from a genuinely unsupported status, the command exits
non-zero with a clean stderr message naming the artifact's actual status and stating resume isn't
available from it — never an uncaught `RegistryError` stack trace. This mirrors the existing
`PreflightGateError` catch already present on the neighboring `auto-run` command.

**Consistency contract**: Any prior CLI output that labels a status "retryable" MUST only do so for
statuses `--resume` genuinely accepts (post-fix, this includes `blocked`).

## `guildctl auto` / `guildctl auto-run` / `guildctl verify` default command (US2 / #154)

**Behavior change**: When `--command` is not supplied, the default verify command list is resolved
from the active stack pack's `verify.per_artifact` config (e.g. `javac-scope-compile` for
`java-spring`), not `["npm test"]`. If the stack pack declares no `verify:` block, the existing
"unverified — no verify: block" path is used, not `npm test`.

**Blocked-loop contract**: Once a remediation attempt has emitted the new "confirmed no defect, do not
re-loop" signal (US2/#154 in data-model.md) for an artifact, the next supervisor decision point for
that artifact MUST NOT dispatch another verify attempt for the same unresolved cause; it surfaces the
artifact in a terminal, operator-visible state instead.

## `guildctl migrate` (US4 / #156)

**Behavior change**: If the filesystem warden's restore for a run touches any path within the
artifact's own `expected_output_paths`, the migrate session's terminal status for that artifact MUST
NOT be `migrated`. It resolves to the existing failed/needs-redelivery state instead.

**No CLI flag change** — this is an internal state-machine correction, observable only via the
artifact's resulting `status` and the run's event log.

## `guildctl preflight` / `guildctl doctor` (US7 / #158)

**Behavior change**: The test-completion probe's `max_tokens` is raised (256–512) and/or the
empty-completion-with-reasoning-tokens shape is detected and reported distinctly. A provider that
returns real output within the raised budget is reported healthy; a provider that is genuinely
unreachable/misconfigured still reports failure with its existing message.

**No flag change.**

## `guildctl init` (US8 / #159)

**Behavior change (docs-first, per research.md decision)**: GETTING-STARTED.md/README.md explicitly
documents the `assertAutonomousRegistryPlacement` constraint and the exact `--db <path>` override for
`auto`/`auto-run`, in the section an operator reads before first running `auto`. If a low-risk
conditional default is implemented instead/in addition, `guildctl init` may default
`database.path` outside the workspace — this is decided at task time per research.md, not fixed here.

**No required flag change** for the documentation-only path.

## `setup.js` / `node setup.ts` non-interactive install (US9 / #150)

**Behavior change**:
- With non-TTY stdin (`< /dev/null`) and no `--framework`/`--legacy-url`/`--legacy-path` flags,
  `runInstall()` short-circuits to the flag-driven/default path before creating a `readline`
  interface, and completes: framework confirmation printed, `.guild/` created, "Done." summary
  printed, exit code `0`.
- With piped input that runs out mid-wizard, any prompt reached after the buffer is exhausted
  resolves to its documented default (not left pending), with a stderr diagnostic line noting stdin
  closed and remaining prompts defaulted.
- The wizard MUST NOT exit `0` having created no workspace and no diagnostic — that specific failure
  mode (silent no-op success) is eliminated by this fix in every case, not just the two scenarios
  above.

**Exit codes**: `0` only when a workspace was actually scaffolded (using explicit answers or documented
defaults); non-zero with a clear stderr message in any case where it wasn't.

## Verify Slot internal contract (US5 / #151, not user-facing CLI surface)

New config field `verification.max_concurrent` in `GuildConfig` (`migration/guildctl/config.ts`),
consumed internally by `verify.ts` before each `spawn()` call. Not a CLI flag in this pass (config-file
/ env-driven, consistent with the other `agent_limits.*`/`verification.budget_seconds` fields already
in `GuildConfig`); exposing a `--max-concurrent` override flag is an optional task-time addition, not
required by the spec.
