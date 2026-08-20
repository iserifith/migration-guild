# Phase 0 Research: guildctl Operational Hardening

No `[NEEDS CLARIFICATION]` markers remain in the spec, so this research phase is grounded verification
of the actual current code paths each fix touches, not speculative technology selection — every
decision below is anchored to a file/line already confirmed by reading the repository.

## US1 (#153) — Manual arbitration is dead code outside `auto`

- **Current state confirmed**: `migration/guildctl/commands/arbitrate.ts` calls
  `approveArtifactWithEvidence`/`rejectArtifactWithEvidence` (`migration/registry/commands/evidence.ts`)
  without ever passing `runId`/`operatorToken`. Those functions validate via
  `validateRunOperatorCredential` (`migration/registry/commands/claim.ts:38`), which requires a row in
  `run_operator_credentials` — created only by `createRunOperatorCredential` (`claim.ts:19`), which
  itself requires an existing `runs` row. `cli.ts`'s `arbitrate` command (line 534) exposes no
  `--run-id`/`--operator-token` options today.
- **Decision**: Add `--run-id <id>` and `--operator-token <token>` options to the `arbitrate` command.
  When `--run-id` is supplied without a matching credential, or when neither is supplied, the command
  mints an ad-hoc run + operator credential via the *existing* `createRunOperatorCredential` (no new
  credential mechanism) scoped to that one arbitration call, rather than requiring the operator to
  already have a live `auto` run. Wrap the `approveArtifactWithEvidence`/`rejectArtifactWithEvidence`
  call in `runArbitrate` (`commands/arbitrate.ts:22`) in a try/catch that recognizes `RegistryError`
  (already used elsewhere in the registry layer — see `claim.ts`'s own imports) and prints a clean
  one-line error instead of letting it propagate to `program.parse()` uncaught.
- **Rationale**: Reuses the mechanism `auto`'s supervisor already relies on (Principle III), so no new
  trust boundary is introduced; the CLI's existing `PreflightGateError` catch pattern in
  `cli.ts`'s `auto-run` action (line 574) is the precedent to follow for the clean-error part.
- **Alternatives considered**: A separate "manual approval" credential type was considered and rejected
  — it would duplicate `run_operator_credentials` semantics for no behavioral gain and would need its
  own independence check, redoing work `assertApprovalEvidenceIsIndependent` already does.

## US2 (#154) — Verify command defaults to `npm test`; blocked-loop never terminates

- **Current state confirmed**: The hardcoded fallback is real and located precisely:
  `migration/guildctl/commands/verify.ts:34` and `commands/auto.ts:473` both do
  `commands.length > 0 ? commands : ["npm test"]`. Separately, `migration/guildctl/verify.ts` already
  has a *correct* stack-aware mechanism (`per_artifact` check resolution, `verify.ts:322` /
  `stack.ts:90,152,164`) used by the standalone `guildctl verify` check-execution path — the bug is
  that `auto`/`auto-run`'s own command-list default does not consult it.
- **Decision**: When no explicit `--command` is supplied to `auto`/`auto-run`/`verify`, resolve the
  default command list from the active stack pack's `verify.per_artifact` config (the same resolution
  `verify.ts` already performs) instead of `["npm test"]`. If the stack declares no `verify:` block,
  fall through to the existing "no verify: block" unverified path rather than to `npm test`.
- **Blocked-loop decision**: `supervisor/loop.ts` re-invokes verify after every repair/remediation
  attempt (confirmed at each `setArtifactStatus(db, ..., "blocked", ...)` call site, e.g. lines 358,
  483, 514, 600, 754). Add an explicit signal the remediation-agent can set (a new evidence/event field
  or a dedicated event type — exact shape decided in tasks/data-model, not here) meaning "confirmed no
  content defect, do not re-loop." When present, the loop's next iteration halts and surfaces the
  artifact instead of calling the verifier again.
- **Rationale**: Keeps the fix inside the existing stack-pack interface (Principle VII) and inside the
  existing supervisor loop's state machine (Principle VI) rather than adding a parallel control path.
- **Alternatives considered**: Hardcoding stack-specific verify commands directly in `auto.ts` was
  rejected — it's exactly the anti-pattern Principle VII forbids (stack knowledge leaking into core
  runtime code).

## US3 (#155) — `auto --resume` crashes on `blocked` status

- **Current state confirmed**: `claimArtifactById` throws a `RegistryError` when status doesn't match
  the expected set; `cli.ts`'s `auto` action (line 548) has no try/catch around
  `runAutoCommand`, unlike the sibling `auto-run` action three lines below it which does catch
  `PreflightGateError`.
- **Decision**: Add `blocked` to the set of statuses `--resume` accepts for reclaiming (mirroring how
  `auto-run`'s `--no-resume` already treats "migrated crash states" as resumable), and wrap the `auto`
  action's `runAutoCommand` call in the same style of try/catch already present for `auto-run`,
  catching `RegistryError` specifically and printing a clean message.
- **Rationale**: Matches the exact precedent already in the same file three lines away — no new error-
  handling pattern needed.
- **Alternatives considered**: Leaving `blocked` unresumable but only fixing the crash was considered,
  but rejected because the spec (FR-007) requires the CLI's own "retryable" message to match what
  `--resume` actually accepts — fixing only the crash without the resume path would still leave a
  broken promise.

## US4 (#156) — Warden-reverted output still recorded as `migrated`

- **Current state confirmed**: `supervisor/loop.ts` already has warden-violation handling that releases
  claims and marks the run `blocked`/failed (line 591: `releaseClaimsForRun(..., "auto blocked after
  filesystem violation")`) for violations *detected during* the run. The gap described in #156 is a
  case where the migrate session still reports `migrated` despite the artifact's own claimed-path
  output having been part of what the warden reverted — i.e., the existing failure branch isn't being
  reached for this specific case.
- **Decision**: Before a migrate session is allowed to persist a `migrated` status transition, check
  whether the warden's restore for this run touched any path within the artifact's own claimed output
  paths (`expected_output_paths`, already tracked per claim per `claim.ts:69`). If so, force the
  terminal state to the existing failed/needs-redelivery path instead of `migrated`.
- **Rationale**: Reuses data already recorded on the claim (`expected_output_paths`) — no new tracking
  structure needed, just a check gating an existing status write.
- **Alternatives considered**: Relying solely on `review`'s downstream catch (current behavior) was
  rejected per the issue's own reasoning — it works today but is a safety net, not a fix at the source.

## US5 (#151) — Unbounded verify subprocess concurrency

- **Current state confirmed**: `migration/guildctl/verify.ts:387` spawns the per-artifact check via bare
  `child_process.spawn()` with no concurrency gate. `registry/commands/claim.ts` already implements the
  lease pattern this should mirror (opaque IDs via `makeOpaqueId()`, lease-expiry columns, atomic
  claim/release).
- **Decision**: Add a `verify_slot` lease table (new migration, following the existing claim table's
  shape: `slot_id`, `run_id`, `acquired_at`, `lease_expires_at`) and `acquireVerifySlot`/
  `releaseVerifySlot` functions in `claim.ts` (or a sibling module, per the issue's own suggested
  scope). Add `verification.max_concurrent` to `GuildConfig` (`migration/guildctl/config.ts`), default
  `Math.max(1, os.cpus().length)` unless overridden. `verify.ts` acquires a slot before `spawn()` and
  releases on process settle (matching the try/finally shape already used around lease handling
  elsewhere in the claim code); a session that can't acquire immediately polls briefly rather than
  spawning anyway.
- **Memory bound**: Add `-J-Xmx256m` to `stacks/java-spring/stack.yaml`'s `verify.per_artifact.args`
  array (confirmed structure at `stack.yaml:50-59` — `javac -proc:none -d {workspace_root}/...`).
- **Rationale**: Directly reuses the claim/lease idiom already proven in this codebase; avoids adding
  new infrastructure (a daemon, an external semaphore) per the issue's own explicit "not recommended"
  guidance against a persistent JVM/nailgun approach.
- **Alternatives considered**: OS-level `ulimit`/cgroup enforcement was considered and rejected as
  out-of-scope — it requires host-level privileges the CLI can't assume, whereas an in-registry lease
  works identically across all supported platforms.

## US6 (#157) — Stale `migration/dist/...` path

- **Current state confirmed**: Not yet greped exhaustively in this research pass; the issue names two
  concrete sites (`plan`'s dependency-disposition blocked message, and the test-writer-agent prompt's
  self-claim fallback). A repo-wide grep for `migration/dist/` across `migration/guildctl/commands/*.ts`
  and `package/agents/*.agent.md`/`package/prompts/*.md` is deferred to the tasks phase as the first
  concrete task (it's a mechanical find-and-fix, not a design decision).
- **Decision**: Fix every occurrence found; add a regression test analogous to the existing
  `doc-consistency` tests from #148/PR #149 that fails the build if `migration/dist/` reappears in any
  shipped command or prompt template.
- **Rationale**: Same fix shape and same regression-test precedent the prior fix (#148/PR #149) already
  established for this exact class of bug.

## US7 (#158) — Preflight `max_tokens: 16` false-fails reasoning models

- **Current state confirmed**: `migration/guildctl/preflight.ts:240` sends `max_tokens: 16` in the
  probe completion request.
- **Decision**: Raise the probe's `max_tokens` to a value large enough to accommodate a typical
  reasoning model's chain-of-thought overhead before visible output (256–512, per the issue's own
  suggestion), and/or detect the specific empty-completion-with-reasoning-tokens response shape and
  report a distinct, clearer message ("model needs a larger token budget") instead of the generic
  "provider returned an empty completion."
- **Rationale**: The issue itself confirms (via direct `curl` and a subsequent full pipeline run) that
  the provider is healthy — this is purely a probe-sizing bug, not a detection-logic bug, so the
  minimal fix is sufficient.
- **Alternatives considered**: Detecting `finish_reason: length` + nonzero `reasoning_tokens` and
  reporting a distinct message was considered as the *sole* fix (without raising `max_tokens`), but the
  spec's FR-014 allows either approach; raising the budget is simpler and directly resolves the false
  failure rather than just relabeling it, so it's the primary fix with the distinct-message detection
  as a secondary hardening if a reasoning model needs more than the raised budget still allows.

## US8 (#159) — `guildctl init`'s default DB path breaks `auto`

- **Current state confirmed**: `assertAutonomousRegistryPlacement` (`migration/guildctl/runner.ts`,
  per the issue) hard-requires the registry DB outside the workspace; `guildctl init`'s scaffolded
  `.guild/config.yaml` currently defaults `database.path` inside the workspace (issue's own
  confirmation; not independently re-verified in this pass since the fix is either a one-line default
  change or a doc addition, not a design decision).
  Between init's docs default. **Decision**: Prefer documentation over behavior change as the primary
  fix — explicitly document the `assertAutonomousRegistryPlacement` constraint and the exact `--db`
  override pattern in GETTING-STARTED.md's "Run the pipeline" section, since changing `init`'s default
  path risks surprising operators who use `init` for manual (non-auto) workflows where an in-workspace
  DB is fine. If a low-risk conditional default (detecting intended `auto` usage at `init` time) proves
  straightforward at implementation time, prefer it; otherwise the documentation fix alone satisfies
  FR-016.
- **Rationale**: Matches the issue's own framing — the placement guard is "a legitimate, deliberate
  safety guard, not a bug in itself," so the minimal, lowest-risk fix is closing the documentation gap.
- **Alternatives considered**: Auto-detecting and always defaulting outside the workspace was
  considered but risks a bigger behavior change (a DB path outside the workspace by default even for
  purely manual users) than the issue asks for.

## US9 (#150) — Setup wizard's non-TTY fallback produces no workspace

- **Current state confirmed**: `setup.ts:92`'s `ask()` wraps `rl.question()` in a `Promise` with no
  timeout/EOF handling; `setup.ts:189` creates the `readline.Interface` unconditionally regardless of
  `process.stdin.isTTY`.
- **Decision**: Detect non-TTY stdin (`!process.stdin.isTTY`) up front in `runInstall()` and short-
  circuit straight to the flag-driven/default path before calling `readline.createInterface` at all —
  this is option (a) from the issue, chosen over per-prompt EOF handling (option b) because it matches
  what GETTING-STARTED.md's note already claims happens ("resolve to default/blank answer instead of
  hanging"), and is simpler to reason about and test than making every individual `ask()` call EOF-safe.
  For the piped-partial-input case, also make each `ask()` resolve to its default on a `close` event
  from the readline interface, with a stderr diagnostic line, as a backstop for any prompt reached
  after non-TTY detection fails to short-circuit (defense in depth, not the primary mechanism).
- **Rationale**: A single up-front branch is far less likely to leave a prompt unhandled than auditing
  every call site, and it's the behavior the documentation already promises.
- **Alternatives considered**: Per-prompt EOF defaulting alone (option b, no up-front short-circuit)
  was considered as the sole fix but rejected as primary — it requires every current and future `ask()`
  call site to independently get the EOF case right, which is exactly the kind of gap that caused #150
  in the first place (this run's second finding shows even the *second* prompt in a batch failed).
