---

description: "Task list for guildctl Operational Hardening"
---

# Tasks: guildctl Operational Hardening

**Input**: Design documents from `/specs/012-guildctl-operational-hardening/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/cli-commands.md](./contracts/cli-commands.md), [quickstart.md](./quickstart.md)

**Tests**: Included. The project constitution (Principle V, Development Workflow gates) requires a
`migration/test` regression test for any change to claims, evidence, arbitration, warden scope, or
phase control flow — which covers US1, US2, US3, US4, and US5 here. Tests are also included for
US6/US7/US9 because the issues that spawned them explicitly asked for a regression test, and they are
cheap relative to the risk of silent regression (a stale path, a false-negative preflight, a silent
setup no-op).

**Organization**: Tasks are grouped by user story (matching spec.md's 9 stories / GitHub issues
#150–#159), each independently implementable, testable, and shippable — per plan.md's Constitution
Check, no story depends on another.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1–US9, per spec.md priorities)
- File paths are exact, taken from plan.md's Project Structure and research.md's confirmed line references

## Path Conventions

Single existing project (no new top-level structure). Paths are relative to repo root:
`migration/guildctl/`, `migration/registry/commands/`, `migration/test/`, `stacks/java-spring/`,
`package/agents/`, `package/prompts/`, `setup.ts`, `GETTING-STARTED.md`, `README.md`.

---

## Phase 1: Setup

**Purpose**: Establish a baseline before touching any of the nine independent fixes.

- [x] T001 Run `npm test` from repo root and record the current pass/fail baseline, so each story's checkpoint can confirm it introduced no regression beyond its own new tests

---

## Phase 2: Foundational

**Purpose**: Blocking prerequisites shared by all user stories.

**None required.** Per plan.md's Constitution Check and Project Structure, these nine fixes are
independently scoped to disjoint files with no shared new abstraction (the one new primitive, the
verify-slot lease, is scoped entirely to US5 and touches no other story's files). Proceed directly to
the user story phases; they may be done in any order or in parallel.

---

## Phase 3: User Story 1 — Manual arbitration works (Priority: P1) 🎯 MVP

**Goal**: `guildctl arbitrate --approve`/`--reject` succeeds for manual/CLI use outside an `auto` run, and any credential/state failure prints a clean message instead of a stack trace.

**Independent Test**: Run `guildctl arbitrate --approve` against an artifact with recorded evidence, outside any `auto` session; confirm status transitions and no uncaught exception (see quickstart.md US1).

### Tests for User Story 1

- [x] T002 [P] [US1] Write regression test in `migration/test/arbitrate-manual-approval.test.ts` asserting: (a) `runArbitrate` succeeds end-to-end for a manual approve/reject with no pre-existing `auto` run active (ad-hoc run+credential minted transparently), and (b) a `RegistryError` from a failed independence/credential check is surfaced as a clean message, not an uncaught exception

### Implementation for User Story 1

- [x] T003 [US1] Add `--run-id <id>` and `--operator-token <token>` options to the `arbitrate` command definition in `migration/guildctl/cli.ts` (~line 534)
- [x] T004 [US1] In `migration/guildctl/commands/arbitrate.ts`, when neither `--run-id` nor `--operator-token` is supplied, mint an ad-hoc run + operator credential via the existing `createRunOperatorCredential` (`migration/registry/commands/claim.ts:19`) scoped to this one invocation, and pass it through to `approveArtifactWithEvidence`/`rejectArtifactWithEvidence`
- [x] T005 [US1] Wrap the approve/reject call in `runArbitrate` (`migration/guildctl/commands/arbitrate.ts:22`) in a try/catch that recognizes `RegistryError` and writes a single clean line to stderr plus a non-zero exit, instead of letting it propagate
- [x] T006 [US1] In `migration/guildctl/cli.ts`'s `arbitrate` action (~line 543), confirm/align the catch boundary with the existing `PreflightGateError` pattern already used on the neighboring `auto-run` action (~line 574) so no raw stack trace reaches the terminal for any remaining edge case

**Checkpoint**: `guildctl arbitrate` is independently usable and testable — MVP delivered.

---

## Phase 4: User Story 2 — Correct verify command + blocked-loop stop (Priority: P1)

**Goal**: Verify uses the active stack's configured command instead of a hardcoded `npm test`, and the supervisor stops re-looping once remediation has confirmed no content defect.

**Independent Test**: Run `auto` on a java-spring artifact and confirm `javac`, not `npm test`, runs; force an unresolvable case and confirm the loop halts to a terminal state instead of repeating (see quickstart.md US2).

### Tests for User Story 2

- [x] T007 [P] [US2] Write regression test in `migration/test/verify-stack-command-resolution.test.ts` asserting the default verify command list (when `--command` is omitted) resolves from the active stack pack's `verify.per_artifact` config (e.g. `javac-scope-compile` for `java-spring`) rather than `["npm test"]`, for both `migration/guildctl/commands/verify.ts` and `commands/auto.ts`'s default-resolution paths
- [x] T008 [P] [US2] Write regression test in `migration/test/blocked-loop-hard-stop.test.ts` asserting `migration/guildctl/supervisor/loop.ts` stops re-invoking verify for an artifact once a "remediation confirmed no defect" signal has been recorded for it, and instead surfaces the artifact in a terminal, operator-visible state

### Implementation for User Story 2

- [x] T009 [US2] Add a stack-pack-aware default-command resolver in `migration/guildctl/stack.ts` that reuses the existing `per_artifact` resolution logic already used by `migration/guildctl/verify.ts` (`verify.ts:322`, `stack.ts:90,152,164`)
- [x] T010 [US2] Replace the hardcoded `commands.length > 0 ? commands : ["npm test"]` fallback in `migration/guildctl/commands/verify.ts:34` with the resolver from T009
- [x] T011 [P] [US2] Replace the same hardcoded fallback in `migration/guildctl/commands/auto.ts:473` with the resolver from T009
- [x] T012 [US2] Add a "remediation confirmed no defect" event type, appended via the existing `appendEvent` mechanism, emitted from the remediation-agent's repair-completion path (`migration/guildctl/commands/repair.ts` / `remediate.ts` as applicable — per data-model.md's decision to use an event, not a schema column)
- [x] T013 [US2] In `migration/guildctl/supervisor/loop.ts`, check for the T012 event immediately before each verify re-dispatch (the `blocked` branches enumerated in research.md: lines ~358, 483, 514, 600, 754) and halt to a terminal state instead of re-blocking when the event is present

**Checkpoint**: Both P1 stories (US1, US2) are independently functional — the two highest-severity issues are closed.

---

## Phase 5: User Story 3 — Resume from `blocked` fails cleanly (Priority: P2)

**Goal**: `guildctl auto --resume` against a `blocked` artifact either resumes or reports a clean, actionable error — never an uncaught exception.

**Independent Test**: Put an artifact in `blocked`, run `--resume`, confirm clean success or clean failure message (see quickstart.md US3).

### Tests for User Story 3

- [x] T014 [P] [US3] Write regression test in `migration/test/auto-resume-blocked.test.ts` asserting `guildctl auto --artifact <id> --resume` against a `blocked` artifact either resumes successfully or exits non-zero with a clean stderr message, never an uncaught `RegistryError`

### Implementation for User Story 3

- [x] T015 [US3] Widen the resume-eligible status set used by the reclaim path around `claimArtifactById` (`migration/registry/commands/claim.ts`) to include `blocked`
- [x] T016 [US3] Wrap the `auto` command's action handler in `migration/guildctl/cli.ts` (~line 548) in a try/catch for `RegistryError`, mirroring the existing `PreflightGateError` catch already present on the neighboring `auto-run` action (~line 574), printing a clean stderr message instead of propagating a stack trace
- [x] T017 [US3] Audit CLI/status output text that labels a prior status "retryable" and align it with the actual resume-eligible set from T015

**Checkpoint**: US1–US3 independently functional.

---

## Phase 6: User Story 4 — Warden-reverted output never counted as migrated (Priority: P2)

**Goal**: If the warden reverts an artifact's own claimed-path output, that artifact is never left recorded as `migrated`.

**Independent Test**: Trigger a warden revert touching an artifact's own claimed output mid-migrate; confirm resulting status isn't `migrated` (see quickstart.md US4).

### Tests for User Story 4

- [x] T018 [P] [US4] Write regression test in `migration/test/warden-revert-blocks-migrated.test.ts` reproducing a warden restore that touches a path within an artifact's own `expected_output_paths` mid-migrate, asserting the resulting artifact status is not `migrated`

### Implementation for User Story 4

- [x] T019 [US4] Before the migrate session is allowed to persist a `migrated` status write (in `migration/guildctl/commands/migrate.ts` and/or `supervisor/loop.ts`, wherever that write currently occurs), check whether the warden's restore for this run touched any path within the claim's `expected_output_paths` (`migration/registry/commands/claim.ts:69`); if so, redirect to the existing failed/needs-redelivery status instead

**Checkpoint**: US1–US4 independently functional.

---

## Phase 7: User Story 5 — Bounded verify subprocess concurrency (Priority: P2)

**Goal**: Verify subprocesses are capped by a configurable `verification.max_concurrent`, with a memory bound on the java-spring `javac` check.

**Independent Test**: Start more concurrent sessions than the configured limit; confirm live verify-subprocess count never exceeds it (see quickstart.md US5).

### Tests for User Story 5

- [x] T020 [P] [US5] Write regression test in `migration/test/verify-slot-concurrency.test.ts` asserting `acquireVerifySlot` enforces `verification.max_concurrent` (blocking/rejecting acquisition beyond the limit) and `releaseVerifySlot` frees capacity for the next waiter, using the same atomic-lease assertions as the existing `claim-leases.test.ts`

### Implementation for User Story 5

- [x] T021 [US5] Add a `verify_slot` lease table to the registry schema, mirroring the existing claim/lease shape per data-model.md (`slot_id`, `run_id`, `artifact_id`, `acquired_at`, `lease_expires_at`, `released_at`)
- [x] T022 [US5] Implement `acquireVerifySlot`/`releaseVerifySlot` in `migration/registry/commands/claim.ts`, using the same atomic under-limit-insert pattern already used by `claimArtifactById`
- [x] T023 [US5] Add `verification.max_concurrent` to `GuildConfig` in `migration/guildctl/config.ts`, default `Math.max(1, os.cpus().length)`
- [x] T024 [US5] In `migration/guildctl/verify.ts`, acquire a verify slot before each `spawn()` call (~line 387) and release it on process settle (try/finally); poll briefly on failed acquisition instead of spawning unconditionally
- [x] T025 [P] [US5] Add `-J-Xmx256m` to the `javac` verify `args` array in `stacks/java-spring/stack.yaml` (~lines 50-59)

**Checkpoint**: US1–US5 independently functional — all P1/P2 stories complete.

---

## Phase 8: User Story 6 — No stale `migration/dist/...` paths (Priority: P3)

**Goal**: Every shipped command message and prompt template references a real path; a regression test prevents recurrence.

**Independent Test**: Trigger the `plan` blocked message and the test-writer-agent's self-claim fallback; confirm both reference real paths (see quickstart.md US6).

### Tests for User Story 6

- [x] T026 [P] [US6] Write regression test in `migration/test/stale-dist-path-consistency.test.ts` that scans `migration/guildctl/commands/*.ts`, `package/agents/*.agent.md`, and `package/prompts/*.md` for the literal string `migration/dist/` and fails if any match is found

### Implementation for User Story 6

- [x] T027 [US6] Fix the stale `migration/dist/registry/cli.js` reference in `plan`'s dependency-disposition blocked message (`migration/guildctl/commands/plan.ts`) to the real `migration/registry/dist/cli.js` form
- [x] T028 [P] [US6] Fix the same stale path in the test-writer-agent prompt template's self-claim fallback (locate via grep across `package/agents/*.agent.md`, `package/prompts/*.md`)
- [x] T029 [US6] Repo-wide sweep for any remaining `migration/dist/` occurrences across the same three globs from T026 and fix any found beyond T027/T028, until T026's test passes

**Checkpoint**: US1–US6 independently functional.

---

## Phase 9: User Story 7 — Preflight doesn't false-fail reasoning models (Priority: P3)

**Goal**: `preflight`/`doctor` correctly reports a healthy reasoning-model provider as healthy.

**Independent Test**: Run `preflight` against a known-healthy reasoning-model provider and a known-broken one; confirm correct healthy/failing reports respectively (see quickstart.md US7).

### Tests for User Story 7

- [x] T030 [P] [US7] Write regression test in `migration/test/preflight-reasoning-model-budget.test.ts` using a mocked provider response shaped as empty-completion-with-nonzero-reasoning-tokens, asserting preflight reports success (or a distinct clear message) rather than the generic "empty completion" failure; also assert a genuinely broken/misconfigured provider still correctly fails

### Implementation for User Story 7

- [x] T031 [US7] Raise the test-completion `max_tokens` in `migration/guildctl/preflight.ts:240` from `16` to `256`–`512`
- [x] T032 [P] [US7] Add detection for the empty-with-reasoning-tokens response shape in `migration/guildctl/preflight.ts`, reporting a distinct "model needs a larger token budget" message if it still occurs at the raised budget

**Checkpoint**: US1–US7 independently functional.

---

## Phase 10: User Story 8 — `init` defaults don't silently break `auto` (Priority: P3)

**Goal**: An operator following documented defaults from `init` through `auto` either succeeds or is warned before hitting the failure.

**Independent Test**: Run `guildctl init` then `guildctl auto` with no extra config; confirm either success or that GETTING-STARTED.md already explained the required step (see quickstart.md US8).

### Implementation for User Story 8

- [x] T033 [US8] Document the `assertAutonomousRegistryPlacement` constraint and the exact `--db <path>` override pattern in GETTING-STARTED.md's "Run the pipeline" section, ahead of where `auto`/`auto-run` is first introduced
- [x] T034 [P] [US8] Cross-check README.md for the same gap; add an equivalent note/pointer if it documents `auto`/`auto-run` usage
- [x] T035 [US8] (Best-effort hardening) If a low-risk conditional default is straightforward, have `guildctl init` default `database.path` outside the workspace when it can detect `auto`/`auto-run` usage is intended; otherwise T033/T034 alone satisfy the requirement — do not force a riskier default-path change to close this task — **resolved docs-only**: `init` cannot detect intended `auto` usage at scaffold time, and an out-of-workspace default would regress the documented phase-by-phase/manual path (the in-workspace default is correct there), so T033/T034 documentation is the fix per research.md

**Checkpoint**: US1–US8 independently functional.

*No dedicated test task: this story is documentation-only (or an optional low-risk default), not a code-path change with new failure modes to regress-test.*

---

## Phase 11: User Story 9 — Setup wizard's non-TTY fallback works as documented (Priority: P3)

**Goal**: Headless/piped `setup.js` runs either scaffold a workspace using documented defaults, or fail loudly — never a silent no-op success.

**Independent Test**: Run the wizard with closed stdin and with partially piped input; confirm a workspace is produced or a clear non-zero failure occurs (see quickstart.md US9).

### Tests for User Story 9

- [x] T036 [P] [US9] Write regression test in `migration/test/setup-non-tty-fallback.test.ts` spawning the setup entrypoint with stdin from `/dev/null` and no flags, asserting exit code `0` and an actually-scaffolded workspace directory; and a second case with partially piped input, asserting remaining prompts resolve to defaults (with a stderr diagnostic line) rather than hanging or exiting silently

### Implementation for User Story 9

- [x] T037 [US9] In `setup.ts`'s `runInstall()`, detect non-TTY stdin (`!process.stdin.isTTY`) up front and short-circuit to the flag-driven/default path before calling `readline.createInterface` (`setup.ts:189`)
- [x] T038 [US9] In `setup.ts`'s `ask()` helper (`setup.ts:92`), resolve the pending promise to a blank/default sentinel on the readline interface's `close`/EOF event, with a stderr diagnostic line noting stdin closed and remaining prompts defaulted — a backstop for any prompt reached after T037
- [x] T039 [US9] Correct GETTING-STARTED.md's non-TTY stdin fallback note (~lines 35-39) to accurately describe the behavior implemented in T037/T038

**Checkpoint**: All nine user stories independently functional.

---

## Phase 12: Polish & Cross-Cutting Concerns

**Purpose**: Final verification and constitution-mandated documentation gates, after all desired stories are complete.

- [x] T040 [P] Run full `npm test` (migration suite + Mission Control UI suite) from repo root and confirm all new and existing tests pass, comparing against the T001 baseline — **803/803 green: migration 738/738 (706 baseline + 32 net new US1–US9 tests), UI 65/65**; required syncing the T025 stack.yaml and `.env.example` verify-knob edits to their shipped `package/` copies (byte-parity) to restore green
- [x] T041 [P] Add entries to `CHANGELOGS.MD` under `Unreleased` for all nine fixes, grouped by date heading, per the constitution's Development Workflow gates
- [x] T042 Run the `quickstart.md` validation scenarios end-to-end against a fresh test workspace under a dated subfolder of `migration-guild-test-workspaces` (never the repo root)
- [x] T043 Answer the constitution's maintainer checklist (repo-only vs. shipped; `package/` updated; `migration/` updated; `DEVELOPMENT.md` updated) for each of the nine fixes, and update `DEVELOPMENT.md` if any maintainer-facing workflow changed

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — run first.
- **Foundational (Phase 2)**: None — empty for this feature.
- **User Stories (Phases 3–11)**: Each depends only on Setup (T001) completing; they do not depend on
  each other and may proceed in any order or in parallel, in priority order (P1 → P2 → P3) if done
  sequentially.
- **Polish (Phase 12)**: Depends on all desired user story phases being complete.

### User Story Dependencies

- **US1 (#153, P1)** and **US2 (#154, P1)**: Independent of every other story; together form the MVP.
- **US3 (#155, P2)**, **US4 (#156, P2)**, **US5 (#151, P2)**: Each independent of every other story
  (including each other).
- **US6 (#157, P3)**, **US7 (#158, P3)**, **US8 (#159, P3)**, **US9 (#150, P3)**: Each independent of
  every other story.

### Within Each User Story

- Tests are written first and confirmed to fail before implementation.
- Implementation tasks within a story follow the dependency order given by their descriptions
  (e.g. T004 depends on T003; T024 depends on T022 and T023).
- Story complete and independently checkpointed before moving to the next, if working sequentially.

### Parallel Opportunities

- All `[P]`-marked tasks within a phase touch different files and can run in parallel.
- Because no story shares files with another, **entire story phases can be run in parallel** by
  different contributors/agents once T001 (baseline) is done — e.g. US1 and US2 (the MVP pair) can be
  built simultaneously.
- Within US5, T025 (stack.yaml memory bound) is independent of T021–T024 (verify-slot lease) and can
  run in parallel with them.

---

## Parallel Example: User Stories 1 and 2 (MVP)

```bash
# Once T001 (baseline) is done, launch both P1 stories' test tasks together:
Task: "Write regression test in migration/test/arbitrate-manual-approval.test.ts (T002)"
Task: "Write regression test in migration/test/verify-stack-command-resolution.test.ts (T007)"
Task: "Write regression test in migration/test/blocked-loop-hard-stop.test.ts (T008)"

# Then their implementation tasks proceed within each story per its own dependency chain.
```

---

## Implementation Strategy

### MVP First (User Stories 1 + 2 only)

1. Complete Phase 1: Setup (T001).
2. Complete Phase 3: User Story 1 (#153 — manual arbitration).
3. Complete Phase 4: User Story 2 (#154 — verify command + blocked-loop).
4. **STOP and VALIDATE**: both P1 issues closable independently; run their quickstart scenarios.

### Incremental Delivery

1. Setup → MVP (US1 + US2) → validate → optionally ship/PR.
2. Add US3, US4, US5 (P2) in any order → validate each independently.
3. Add US6, US7, US8, US9 (P3) in any order → validate each independently.
4. Phase 12 Polish once all desired stories are in.

### Parallel Team / Agent Strategy

With multiple contributors or parallel agent sessions:

1. One agent/session per user story phase (no cross-story file overlap, per plan.md's Constitution
   Check and Project Structure).
2. Each closes its own GitHub issue (#150–#159) independently once its checkpoint passes.
3. Phase 12 Polish runs once, after the last desired story phase lands.

---

## Notes

- `[P]` tasks touch different files with no dependency on an incomplete task.
- `[Story]` labels map every phase-3-through-11 task to its GitHub issue for traceability when closing
  issues.
- Each story's regression test(s) must be written and observed failing before its implementation tasks
  land, per the constitution's Tests Before Production Code principle.
- Commit after each task or logical group; each story is independently revertible.
- Avoid: cross-story file edits, skipping the T001 baseline, merging a story without its checkpoint's
  independent test passing.
