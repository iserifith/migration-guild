# Phase 0 Research: Truthful Run State

**Feature**: `001-truthful-run-state` | **Date**: 2026-07-31 | **Spec**: [spec.md](./spec.md)

**Purpose**: resolve every technical unknown raised by the Technical Context in [plan.md](./plan.md)
before design begins. Each decision is grounded in code that exists in this repository today; the
"Current behaviour" line names the file that produces the symptom the spec describes.

**Resolution posture**: conservative. Where two designs satisfy a requirement, the one that adds no
new coordination mechanism, no new status value, and no new gate wins. Nothing here broadens agent
authority, weakens an existing gate, or reopens the settled `.env` precedence decision.

---

## R1. Where a verification state is recorded

**Decision**: a new registry table `artifact_verifications`, one row per artifact, holding the
latest verification state, method, determination time, and machine-readable reason. Absence of a row
reads as *unverified* with reason `not-attempted`.

**Rationale**:

- FR-001 requires verification to be *a distinct fact* from migration status. A table keeps it
  distinct by construction; nothing about `artifacts.status` changes, which the spec's Out of Scope
  section requires ("Any change to the set of migration statuses themselves").
- FR-002 requires state + method + time + reason together. That is four correlated fields with a
  lifecycle of their own.
- Coalescing a missing row to *unverified* means **no backfill migration** is needed for existing
  workspaces: every pre-existing `migrated` artifact immediately reads as unverified rather than
  blank, satisfying FR-002's "never blank or absent" without touching historical rows.

**Alternatives considered**:

- *Columns on `artifacts`* — rejected: four nullable columns on the hottest table in the registry,
  and status and verification would sit in the same row, inviting exactly the conflation FR-001
  exists to prevent.
- *Reuse `acceptance_evidence`* — rejected, and this is the important rejection. That table is the
  arbitration gate's content-bound record produced by an independent verifier (Constitution I and
  IV). A builder-side self-check written into it would be indistinguishable from arbiter-grade
  evidence, and "unverified" would be indistinguishable from "no evidence row yet". See R11 for the
  guardrail that keeps these two records separate.
- *A new migration status such as `verified`* — rejected: explicitly out of scope.

**Current behaviour**: `migration/registry_schema.sql` has no verification concept; an artifact
reaching `migrated` (`migration/registry/commands/artifacts.ts`) records nothing about whether its
output was checked.

---

## R2. What the bounded per-artifact check actually is

**Decision**: the check is declared by the workspace's stack pack, in a new optional `verify:` block
in `stack.yaml`, as a command template with substitutable placeholders. Core runtime never contains a
build or test command. When the active stack pack declares no `verify:` block, verification records
*unverified* with reason `no-stack-check`.

**Rationale**: Constitution VII requires stack-specific knowledge — "classification heuristics,
framework mappings, audit rules, scaffold templates" — to live in `stacks/` and `package/stacks/`,
not in core runtime code. A per-unit compile or test invocation is exactly that kind of knowledge:
`./gradlew compileJava` means nothing to the Python pack. The spec agrees explicitly in its
Assumptions ("using whatever check the workspace's stack pack defines … a stack concern, not a core
concern").

The existing `stack.yaml` already carries structured runtime instructions of this shape
(`audit.external_probes` declares `cmd`, `availability_args`, `args`, `targets`, and a
`fallback_note`), so the `verify:` block follows an established pattern rather than inventing one.

**Alternatives considered**:

- *Hardcode a per-stack command in `migration/guildctl/verify.ts`* — rejected: a direct Constitution
  VII violation.
- *Reuse `guildctl verify`'s current default of `npm test`* — rejected: `migration/guildctl/commands/verify.ts`
  falls back to `npm test`, which is a tree-wide command and is wrong for both shipped stacks. It
  also violates FR-003's ban on requiring a tree-wide build.

**Current behaviour**: `migration/guildctl/verify.ts` runs whatever commands the caller passes, with
no scoping, no budget, and no per-artifact meaning.

---

## R3. How verification scope is bounded

**Decision**: scope = the claimed artifact's own recorded output paths, plus the output paths of its
directly declared dependencies (one hop, not transitive). Output paths come from
`artifact_claims.expected_output_paths` (already recorded per claim, see
`deriveExpectedOutputPaths` in `migration/registry/commands/claim.ts`); direct dependencies come from
the existing `source_dependencies` and `dependencies` tables. The resolved path set is passed to the
stack command through placeholders; the command runs with `cwd` = workspace root.

**Rationale**: FR-003 defines the unit as "the claimed artifact's own output plus its directly
declared dependencies", and both halves already exist as recorded registry facts — no new
dependency analysis is introduced. One hop is the conservative reading of "directly declared";
transitive closure would drift back toward a tree-wide build and violate FR-003's second sentence.

FR-005 (no unbounded filesystem searches, no reads outside the workspace) is satisfied structurally:
the path set is computed from registry rows, never by walking the filesystem, and every resolved path
is asserted to be inside the workspace root using the existing `isPathInside` helper
(`migration/guildctl/config.ts`) before the command is built. Environment scrubbing reuses
`scrubVerificationEnv` (`migration/guildctl/verify.ts`), which already strips credentials from
verification subprocesses.

**Alternatives considered**:

- *Transitive dependency closure* — rejected: on a mid-migration tree the closure quickly reaches
  unmigrated artifacts, which would push nearly every artifact into the `tree-incomplete` reason and
  make the *verified* state unreachable in practice.
- *Whole-module build* — rejected: same failure, at module granularity.

---

## R4. Verification wall-clock budget and its default

**Decision**: a new config key `verification.budget_seconds`, default **120**, overridable per
workspace and by `GUILDCTL_VERIFY_BUDGET_SECONDS`. On elapse, the check's process group is
terminated using the same mechanism as R8, the artifact records *unverified* with reason
`budget-exhausted`, and the agent's claim closes normally.

**Rationale**: the spec fixes no number (FR-004 only requires "bounded, configurable … whose
effective value is reported"). 120s is chosen because it matches the existing
`agent_limits.inactivity_timeout_seconds` default of 120 in `migration/guildctl/config.ts`, so
operators meet one familiar magnitude rather than a new one, and because it sits an order of
magnitude below the smallest per-phase ceiling (phase timeouts are floored at 5 minutes by
`Math.max(5, …)` in `migration/guildctl/commands/migrate.ts`) — a verification budget must never be
able to consume the agent's whole remaining ceiling.

**Alternatives considered**: 30s (rejected: a cold JVM per-file compile routinely exceeds it, which
would make `budget-exhausted` the common case and drain FR-004 of meaning); 300s (rejected: exceeds
the shortest phase ceiling, so verification could outlive the agent that requested it).

---

## R5. What preflight actually exercises

**Decision**: a three-stage probe sharing one wall-clock budget, in this order, stopping at the first
failure:

1. **resolution** — resolve harness, provider base URL, model, and credential variable through a
   single shared resolver, `resolveAgentLaunch()`, extracted from the runner and called by both
   `spawnAgent` and preflight. Fails when any resolved value is missing or the harness is unknown.
2. **live resolved launch request** — issue one minimal end-to-end model request through the resolved
   launch path, asserting a non-empty completion. Provider status and body map to `authorization`,
   `model-availability`, or `response`: `401`/`403` → authorization; `404` or a model-not-found body
   → model availability; `429`/quota bodies → authorization with the provider-reported reason; network
   error, malformed body, empty completion, or budget elapse → response.

The live stage may invoke the resolved adapter or its provider request path, but it must be one request
under one shared budget. Adapter startup alone is never a pass, and preflight must not issue a second
completion solely to test adapter fidelity.
The single live stage preserves both concerns without issuing two completions: it reports provider
authorization/model-availability/response attribution when the request exposes it, while requiring a
non-empty model response through the resolved launch path. Adapter startup alone remains insufficient,
and a missing adapter is a resolution or response failure rather than a separate successful stage.

**Alternatives considered**:

- *Adapter startup only* — rejected: it can pass while the adapter cannot obtain a model response.
- *A separate HTTP probe plus adapter round-trip* — rejected: it spends two completions and can still
 let the two paths drift; one resolved end-to-end request is the truthful assertion.
- *Keep `--version`* — rejected: this is the status quo the feature exists to remove.

**Current behaviour**: `guildctl doctor` (`migration/guildctl/cli.ts:143-193`) performs exactly the
three misleading checks the spec names — a non-empty model string, `checkHarness()` running
`--version`, and a presence test on the credential variable. None of them contacts a provider.

---

## R6. Offline preflight

**Decision**: `--offline` (and `GUILD_PREFLIGHT_OFFLINE=1`) skips the live stage. It reports
status `unvalidated`, never `pass`, and the overall verdict is `unvalidated` — a third verdict
distinct from `pass` and `fail`, with a non-zero-free exit code of its own (`0`, since offline is a
deliberate operator choice, but a verdict string that no green-check script can mistake for `pass`).

**Rationale**: FR-018 requires live-dependent results to be *labelled* unvalidated, and the spec's
edge case is explicit: "it must not report a plain green". A third verdict is the only way a machine
reader cannot conflate the two.

**Alternatives considered**: reporting `warn` for skipped stages — rejected: `warn` already exists in
`CheckResult` (`migration/guildctl/doctor.ts`) with a different meaning ("real but non-blocking
finding"), and overloading it would make an offline run and a degraded run look alike.

---

## R7. Environment precedence and divergence

**Decision**: replace the implicit dotenv auto-load with an explicit loader module that:

1. snapshots ambient `process.env` **before** any file is read;
2. parses each candidate `.env` with `dotenv.parse` (no side effects), preserving today's candidate
   order, first file to define a variable wins among files;
3. applies precedence — project file values overwrite ambient by default; with the opt-in, ambient
   wins;
4. computes the divergence set (defined in both sources with differing values) **always**, before
   either side is applied, and reports it regardless of winner or opt-in state.

The opt-in is `GUILD_ENV_PRECEDENCE=ambient` plus a `--ambient-env` global flag. The mode is read
**only from the ambient snapshot and the flag** — never from a `.env` file, so a project file cannot
grant itself ambient precedence.

**Rationale**: this is the spec's settled product decision (Assumptions, and the checklist forbids
reopening it), so the only open question was mechanism. `dotenv`'s `override: true` alone is
insufficient for two reasons: it would silently flip precedence *between* the three candidate files
(today earlier files win because dotenv does not override; with `override: true` the last file would
win), and it discards the information needed to report divergence, because the ambient value is gone
by the time anything can compare. Snapshotting first and applying explicitly preserves the existing
inter-file ordering while changing only the project-vs-ambient relationship the spec asks for.

Redaction (FR-023) reuses the existing `isSensitiveEnvName` predicate in
`migration/guildctl/verify.ts` — the same rule that already keeps secrets out of evidence logs, so
one definition of "secret" governs both.

**Behaviour-change note for FR-026**: `.env.example` ships `AGENT_CMD`. Under the new default, a
project `.env` that sets `AGENT_CMD` now wins over an ambient `AGENT_CMD` that previously won. That
is intended, is the mechanism that makes a checkout reproducible (SC-003), and is exactly why FR-026
requires it in operator docs and the changelog.

**Current behaviour**: `migration/guildctl/cli.ts:10-17` loads three candidate `.env` files with
`dotenv`, which by design does not override already-set variables — so ambient always wins today,
and nothing is reported.

---

## R8. Terminating the whole process tree

**Decision**: spawn the agent as a process-group leader (`detached: true`) and terminate the group,
not the process:

- **POSIX**: `process.kill(-pgid, "SIGTERM")`, then `process.kill(-pgid, "SIGKILL")` after the grace
  period; confirm with `process.kill(-pgid, 0)`, which throws `ESRCH` when the group is gone.
- **Windows**: `taskkill /PID <pid> /T /F` (there is no POSIX process group to signal); confirm with
  `tasklist /FI "PID eq <pid>"`.

Grace period becomes `agent_limits.termination_grace_seconds`, defaulting to the 5 seconds already
hardcoded in the runner. Confirmation runs after the grace period; survivors are reported as a
cleanup failure naming each surviving PID, and the claim is still released.

**Rationale**: FR-035 fails today for a structural reason — `proc.kill()` in
`migration/guildctl/runner.ts:661-676` signals only the direct child, which for every bundled harness
is a Node adapter shim that has itself spawned the real `codex`/`opencode` binary. The shim dies; the
binary is re-parented to init and keeps consuming provider budget. Group signalling is the smallest
change that reaches the grandchild, and it needs no process bookkeeping, no `ps` parsing, and no new
dependency.

Claim release ordering follows the spec's stated priority ("Claim recoverability outranks cleanup
completeness"): release first, report cleanup outcome alongside (FR-039).

**Caveats to handle in implementation** (both are real consequences of `detached: true`, not
hypotheticals):

- A detached child no longer receives the terminal's `SIGINT`, so operator Ctrl-C would leave the
  tree running. The parent must forward `SIGINT`/`SIGTERM` into the group.
- The parent must **not** call `child.unref()`, or it would stop awaiting the exit it needs to
  finalize the run.

**Alternatives considered**: walking `/proc` or `ps --ppid` to enumerate descendants — rejected: not
portable to Windows, races against processes spawned during the walk, and adds a parsing surface for
no benefit over group signalling. `tree-kill` as a dependency — rejected: the repository pins every
dependency with explicit `overrides` (Constitution: Development Workflow), and this is ~15 lines of
platform-conditional code.

---

## R9. Recording the attempt outcome

**Decision**: extend the existing `runs` table rather than adding an attempt table. New nullable /
defaulted columns: `files_written_count`, `files_written_source`, `status_from`, `status_to`,
`budget_consumed`, `cleanup_outcome`, `survivor_pids`, `outcome_label`. `outcome_label` is
constrained to `succeeded` | `released-retryable` | `no-progress` | `failed`.

**Rationale**: a run *is* the attempt — `runs.run_id` already joins to `artifact_claims.run_id`, and
`termination_reason`, `exit_code`, and the `token_*` columns already live there. Adding a parallel
table would split one attempt's facts across two rows. All new columns are nullable or defaulted, so
existing rows and existing consumers (`listRuns`, the dashboard, `serve`) keep working untouched.

Columns are added through the repository's established idempotent path: an `ALTER TABLE` in the
migrations section of `registry_schema.sql`, backed by the `ensureColumn` guard in
`migration/registry/db/schema.ts` (which exists precisely because this SQLite build rejects
`ADD COLUMN IF NOT EXISTS`).

FR-031's distinction is carried by `outcome_label`: `released-retryable` states that work was safely
released, `no-progress` states that budget was spent for nothing, and neither is `succeeded`.
FR-034's counted condition is a query — runs joined to claims, grouped by artifact, counting
`outcome_label = 'no-progress'` — not a stored counter, so it cannot drift from the rows it
summarizes.

**Current behaviour**: `finishRun` records exit code, termination reason, and tokens. The closing log
block (`migration/guildctl/runner.ts:597-629`) prints files and claims to the *log only*, and the
status word is `TIMEOUT` / `CEILING-KILL` — never a statement that nothing was produced or that
budget was spent and is unrecoverable.

---

## R10. Counting files written without a git worktree

**Decision**: prefer the warden snapshot diff (already computed for every pre-claimed run, see
`snapshotWorkspaceForWardenWithExclusions` / `enforceWardenSnapshot` in
`migration/guildctl/warden.ts`); fall back to the existing git diff when no warden snapshot exists;
record which source was used in `files_written_source`.

**Rationale**: FR-030 requires the summary to state how many files were written.
`snapshotChangedFiles` (`migration/guildctl/runner.ts:123-143`) returns an empty set in a non-git
workspace, so today a run in a non-git workspace reports "Files written: (none)" whether it wrote
nothing or wrote fifty files — a false statement of exactly the kind this feature exists to remove.
The warden snapshot is content-hash based and already covers the workspace, so it is both more
accurate and already paid for.

---

## R11. Keeping verification state out of the arbitration gate

**Decision**: `artifact_verifications` is readable by the review and arbitration stages (FR-009) and
is **never** an input that can satisfy the arbiter gate. The gate continues to require
verifier-produced `acceptance_evidence` with `authenticity` + `log_sha256`, produced by an actor
different from the arbiter. Verification state may only *route* work — it makes `unverified` and
`verification-failed` triageable conditions.

**Rationale**: this is the sharpest constitutional risk in the feature, so it is recorded as an
explicit design constraint rather than left implicit. The per-unit check is run in service of the
builder's own claim; treating it as approval-grade evidence would collapse builder and certifier into
one actor, which Constitution IV forbids and Constitution I calls "self-report". Constitution
Governance also classes weakening a gate as a MAJOR amendment, not a refactor — so the plan must not
touch `evidence-gate` or `arbiter-gate` semantics at all.

**Test obligation**: a regression test asserting that an artifact with `verification_state =
'verified'` and no passing runtime evidence is still **rejected** by arbitration.

---

## R12. Portable, always-usable context retrieval

**Decision**: a new registry command `get-context` returning JSON with a `form` discriminator —
`file` | `summary` | `none`. Resolution order, with no filesystem search at any step:

1. normalize the stored `file_path` for the current platform (accept `\` and `/` in the stored value,
   emit the host's separator);
2. if relative, resolve against the workspace root;
3. if that misses, try the canonical layout `migration/artifacts/<slug>/context/<agent>.md`, rebuilt
   from the artifact id via the existing `idToSlug`;
4. if no file resolves, return the stored `summary` as `form: "summary"`;
5. if the summary is absent **or whitespace-only**, return `form: "none"` with the documented
   fallback named.

`get-context-path` is retained and re-pointed at the same resolver so existing packaged agents keep
working during the transition.

**Rationale**: FR-042's portability requirement is satisfied by normalization plus the canonical
rebuild — both are deterministic and constant-time. Step 3 is what makes a record written on Windows
resolve on Linux when the tree *is* present, without a search (FR-005's spirit and the spec's
"no path-repair work left to the caller"). Whitespace-only summaries are treated as absent because
the spec's edge case says so explicitly.

**Current behaviour**: `getContextPath` (`migration/registry/commands/context.ts:56-74`) returns
`row.file_path` verbatim and throws when no row exists. `writeContext` stores a path built with
`path.join`, so a record written on Windows stores `migration\artifacts\…` and never resolves on
Linux — while a perfectly good `summary` sits unused in the same row. Four packaged agents
(`code-writer-agent`, `test-writer-agent`, `codegen-agent`, `test-agent`) call it and are told to
work out the rest themselves; FR-044 requires that guidance to change.

---

## R13. Making the effective limit inspectable and naming the right knob

**Decision**: a single limit resolver returns a descriptor `{ knob, effectiveValueMs, requestedValueMs,
source, floorApplied }` instead of a bare number. Termination messages quote `knob`,
`effectiveValueMs`, and `source` from that descriptor. A new `guildctl limits [--phase <p>] [--json]`
command prints, per phase, both limits with their descriptors and the precedence order.

Precedence, as it exists in the code today, is: per-phase option (set from
`GUILDCTL_ANALYZE_TIMEOUT_MINS`, `GUILDCTL_TEST_TIMEOUT_MINS`, `GUILDCTL_CODE_TIMEOUT_MINS`,
`GUILDCTL_REVIEW_TIMEOUT_MINS`, `GUILDCTL_REMEDIATION_TIMEOUT_MINS`,
`GUILDCTL_INVENTORY_TIMEOUT_MINUTES`) → `GUILDCTL_AGENT_CEILING_SECONDS` →
`config.agent_limits.ceiling_seconds`.

**Rationale**: FR-028 ("the knob named MUST be one that changes the observed limit") is satisfied
structurally, not by care: the message can only name the knob the resolver actually selected, so
message and behaviour cannot disagree. This feature does not change which knobs exist — the spec's
Assumptions require that — only which one is named and whether the order is visible.

`floorApplied` covers the spec's edge case "operator sets a per-phase knob below the enforced
minimum": the phase constants are floored by `Math.max(5, …)`, so the report must state the value
actually enforced (5 minutes) and that a floor was applied, not the value requested.

**Current behaviour**: `migration/guildctl/runner.ts:658` always appends "raise
agent_limits.ceiling_seconds to allow longer runs" — even when `opts.timeoutMs` from a per-phase
constant is what fired, in which case that config value is overridden and raising it does nothing.
This is the wasted operator action User Story 4 describes.

---

## R14. Naming a blocked-by-out-of-scope-path condition

**Decision**: record the condition as an `artifact_tags` row (`blocked:out-of-scope-path`) plus a
`filesystem-violation` event whose `event_data` names the offending path. The warden's existing
behaviour — restore the change, fail the run — is unchanged; the condition is purely additive.

**Rationale**: FR-010 asks for "a named condition on the artifact identifying the out-of-scope path",
and `artifact_tags` is already the artifact-level condition vocabulary. `events.type` is a fixed
`CHECK` list in `registry_schema.sql`; adding a member is a schema change that ripples into every
consumer's type unions for no capability that a tag does not already provide, and
`filesystem-violation` already exists and already carries the violation payload.

The spec is explicit that broadening write authorization is **not** the remedy, and it is listed in
Out of Scope — so the warden's allow-list logic is not touched.

**Alternatives considered**: a new `artifact_conditions` table — rejected: duplicates `artifact_tags`
with no added expressiveness.

---

## R15. Testing strategy for provider- and process-dependent behaviour

**Decision**: all new behaviour is covered by `node:test` suites in `migration/test/`, run by
`npm test`. Two seams keep the tests hermetic:

- **Provider**: the preflight probe takes an injectable `fetch` (defaulting to global `fetch`), so
  authorization, unknown-model, quota, timeout, and success paths are all table-driven with no
  network. The live resolved-launch request uses the existing fake adapter/provider fixtures, following
  the pattern already established by `codex-harness.test.ts` and `opencode-harness.test.ts`.
- **Process tree**: a fixture script that spawns a long-lived grandchild and ignores `SIGTERM`
  exercises graceful → forced → confirmed escalation and the survivor path, extending
  `run-reliability.test.ts`.

**Rationale**: Constitution V requires kit behaviour to be covered by the `migration/test` suite and
requires changes to claim, evidence, warden, and phase control flow to ship with regression tests —
this feature touches claims, run lifecycle, warden reporting, and phase control flow. Constitution V
also requires tests to precede production code, which the plan carries into task ordering.

**Portability note**: `run-reliability.test.ts` was recently made portable (cwd-derived repo root,
`file://` tsx loader URLs); new process-tree tests must follow that convention, and the Windows
`taskkill` path must be guarded so the suite still runs on POSIX CI.

---

## Resolved unknowns summary

| # | Unknown | Resolution |
|---|---------|-----------|
| R1 | Where verification state lives | New `artifact_verifications` table; missing row ⇒ *unverified* |
| R2 | What the per-unit check is | Stack pack `verify:` block; no check ⇒ `no-stack-check` |
| R3 | How scope is bounded | Claim output paths + one-hop declared dependencies, from registry rows |
| R4 | Verification budget default | `verification.budget_seconds`, default 120 |
| R5 | What preflight exercises | Shared launch resolver + one live resolved-launch request |
| R6 | Offline preflight verdict | Third verdict `unvalidated`; never `pass` |
| R7 | Env precedence mechanism | Explicit snapshot-then-apply loader; `GUILD_ENV_PRECEDENCE=ambient` opt-in |
| R8 | Process-tree termination | Process-group signalling (POSIX) / `taskkill /T` (Windows), then confirm |
| R9 | Attempt outcome storage | New nullable columns on `runs`; counted repetition is a query |
| R10 | Files-written accuracy | Warden snapshot preferred, git diff fallback, source recorded |
| R11 | Verification vs. arbitration | Triage input only; arbiter gate untouched; regression test required |
| R12 | Context retrieval | `get-context` with `file`/`summary`/`none` discriminator, no searching |
| R13 | Limit naming and inspection | Limit descriptor drives both the message and `guildctl limits` |
| R14 | Out-of-scope-path condition | `artifact_tags` + existing `filesystem-violation` event |
| R15 | Test seams | Injectable `fetch`, fake adapter, SIGTERM-ignoring fixture |

**No `NEEDS CLARIFICATION` markers remain.**
