# Implementation Plan: Fix Pipeline Execution Correctness (Onboarding Hardening, Wave 4)

**Branch**: `011-pipeline-execution-correctness` | **Date**: 2026-08-17 | **Spec**: `specs/011-pipeline-execution-correctness/spec.md` | **Tracking**: issue #133

**Input**: Feature specification from `/specs/011-pipeline-execution-correctness/spec.md` (US1–US3, FR-001..FR-010, SC-001..SC-004, Assumptions, Edge Cases).

**Note**: This plan is non-implementation. It edits no app source, runs no build, and commits nothing. Its sole deliverable is this `plan.md`; `tasks.md` (the checkbox-phase decomposition) is produced later by `$speckit-tasks`.

## Summary

The feature closes three execution-correctness defects surfaced against a *working* provider/harness (Wave 3, #132, prerequisite). Each sub-issue maps to one user story and one exact code location, verified by direct read of `origin/dev` HEAD `078d15d`:

- **US1 / #122** — `run [phase]` action in `migration/guildctl/cli.ts` (`program.command("run [phase]")` at line 666, `.action(async (phase, opts) => { switch (phase) { … } })` at lines 670–720) invokes each phase function (`runInventory(db())` at line 680, and siblings for `scope`/`plan`/`bootstrap`/`migrate`/`review`/`remediate`/`repair`) with **no `try/catch` and no `process.exit`/`process.exitCode` on failure**. `runInventory` (`migration/guildctl/commands/inventory.ts`) already does the correctness work: on a failed quality gate it calls `recordInventoryCompletion(db, { status: "failed", … })` (line 453) and `throw new Error(...)` (line 461) — but the thrown rejection from the `async` commander action is never converted to a non-zero OS exit by the `run [phase]` branch. This is the one branch inconsistent with the already-correct pattern at cli.ts:180 (`preflight`, `if (result.verdict === "fail") process.exit(1)`), cli.ts:195 (`doctor`, config-load `catch` → `process.exit(1)`), and cli.ts:237 (`doctor`, combined-checks → `process.exit(1)`). Fix: wrap the `run [phase]` action body in `try/catch` and set a non-zero exit (`process.exitCode = 1` per FR-002, deterministic across runtimes) on any thrown error, mirroring the existing preflight/doctor propagation.
- **US2 / #123** — `migration/registry/commands/serve.ts` line 34: `const UI_DIR = path.join(__dirname, "..", "..", "ui-dist");` is **correct** for the shipped bundle. `migration/tsup.config.ts` sets `outDir: "registry/dist"`, so the real compiled CLI is `migration/registry/dist/cli.js`, where at runtime `__dirname` = `migration/registry/dist` and `__dirname/../..` = `migration/ui-dist` — the real UI output dir per `migration/ui/vite.config.ts`'s `outDir`. A live smoke test (`node migration/registry/dist/cli.js serve` against a built `migration/ui-dist/`) returns `200` + real `index.html`, confirming `serve.ts` requires **no code change**. The real defect is upstream, in packaging and docs: `scripts/build-dist.mjs`'s `assembleTarball()` (line 183) unconditionally copies `repoRoot/migration/dist` into the tarball, but the `build:dist` pipeline runs `tsup` (which writes `registry/dist` + `guildctl/dist`) and never runs a step that creates `migration/dist/**` — so `npm run build:dist` throws `ENOENT` on a clean checkout (no absent-dir guard, unlike the `docs/`-absent handling added for #116) or ships stale content if a stray `migration/dist` exists. Separately, `GETTING-STARTED.md` (lines ~65/131/186/188/189) and `setup.ts` (lines ~325/328/330) hardcode `node migration/dist/registry/cli.js` as the built CLI path — a file the documented build never produces (the real artifact is `migration/registry/dist/cli.js`). Fix: repoint `build-dist.mjs`'s `assembleTarball()` at the real tsup outputs (`registry/dist` + `guildctl/dist`) and add a UI build step so `migration/ui-dist` ships in the tarball; correct the documented CLI paths in `GETTING-STARTED.md` and `setup.ts` to `migration/registry/dist/cli.js`. `serve.ts`'s `UI_DIR` is left unchanged.
- **US3 / #124** — `migration/registry/commands/artifacts.ts` `releaseTask` (lines 215–252): after `validateId` and an existence check, line 226 unconditionally rejects any artifact whose `status !== "in-progress"` with `throw new RegistryError(1, 'Cannot release "<id>": status is "<status>", expected "in-progress".')` (lines 227–230) — before ever reaching the claim-release branch at lines 231–251. GETTING-STARTED.md's documented recovery ("Agent left a file stuck" → `release --id … --reason "crashed"`) targets exactly the state this throw forecloses: `claimed_by='crashed-agent'` with `status='pending'` (the agent crashed before flipping to `in-progress`). The claim-release logic that would clear `claimed_by`/`claimed_at`/`claimed_from` and reset `status` to `claimed_from ?? "planned"` (lines 232–249) already exists and works for the `in-progress` case; it is simply unreachable for the pending-claimed case. `releaseClaimedArtifactsForOwner` (lines 258–277) has its own SQL filter `WHERE status = 'in-progress' AND claimed_by = ?` (lines 268–269) that must stay consistent with (or be intentionally scoped apart from) whatever `releaseTask` widens to. Fix: widen `releaseTask`'s guard to accept `status === "pending" && claimed_by IS NOT NULL` as a second releasable state (clear the claim, reset status to `claimed_from ?? "planned"`, write the same parameterized `status-changed` event), while leaving the `in-progress` path and the `planned`+unclaimed refusal unchanged.

## Technical Context

**Language/Version**: TypeScript (Node 18+; developer machine runs Node v22.23.1), compiled via the existing `migration/` tsx/tsc toolchain; tests run on the built-in `node:test` runner (`node --import tsx --test test/*.test.ts`, `migration/package.json` line 13).

**Primary Dependencies**: `commander` (CLI actions, `cli.ts`), `better-sqlite3` (registry reads/writes, `artifacts.ts`), Node `http`/`fs`/`path` (static file serving, `serve.ts`), `vite` (UI build, `migration/ui/vite.config.ts`). All already present in `migration/`.

**Storage**: SQLite registry (`better-sqlite3`) — `releaseTask`/`releaseClaimedArtifactsForOwner` write `artifacts` and `events` rows; no schema change for this feature.

**Testing**: `node:test` (assert/strict) under `migration/test/`, run via `npm test` in `migration/`. No existing test file directly exercises `run [phase]` exit codes, `npm run build:dist`'s packaging of `registry/dist` + `guildctl/dist` + `ui-dist` (or the resulting `serve`'s HTTP behavior), or `releaseTask`'s pending-claimed path (verified: no `migration/test/*.test.ts` currently imports `releaseTask` or exercises `scripts/build-dist.mjs`) — three new/extended suites are required per NFR-003.

**Target Platform**: Linux/macOS/Windows CLI (`guildctl`, `registry`), Node process; US2 additionally spans a static HTTP server (`registry serve`, port 3322).

**Project Type**: CLI runtime library (`migration/guildctl/`, `migration/registry/`) + its regression suite (`migration/test/`).

**Performance Goals**: None new; US1 adds a `try/catch` around already-awaited work (no new I/O), US2 changes a path computation (no new I/O beyond an existence check), US3 widens a SQL `WHERE`-equivalent branch (same statement shapes, no new query).

**Constraints**: Per constitution Principle I, exit-code-zero must not be completion evidence in either direction — this feature is the "must cut both ways" enforcement referenced in spec.md line 17. Per Principle VI (Fail-Closed Automation), the documented operator escape hatch (release of a stuck artifact) must be actionable, not refused with a non-actionable error. Per NFR-002, the US2 fix must keep `serve.ts`'s existing `UI_DIR` resolution unchanged (it already resolves correctly for the shipped bundle) and instead fix the packaging pipeline (`scripts/build-dist.mjs`) and the documented CLI paths (`GETTING-STARTED.md`, `setup.ts`) so the built kit actually contains what `UI_DIR` expects to find.

**Scale/Scope**: Three targeted fixes across three areas (`cli.ts`; `scripts/build-dist.mjs` plus the documented CLI paths in `GETTING-STARTED.md`/`setup.ts`; `artifacts.ts`) plus three regression test files (two new, one new — no existing suite currently covers any of the three code paths under test).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after design.*

| Principle | Status | Evidence in plan |
|-----------|--------|------------------|
| I — Evidence Over Assertion | PASS | Exit code zero is not completion evidence in either direction (spec.md:17, constitution.md:46) — US1 makes a failed phase's exit code match its actual postcondition, closing the gap where `runInventory`'s own recorded `status: "failed"` (inventory.ts:453) and thrown error (inventory.ts:461) were computed but silently discarded by the exit code. Every change cites exact `file:function:line`; tests assert real process exit codes / HTTP status / registry row state, not developer claims. |
| II — Legacy Is Read-Only; `modern/` Is the Only Write Target | N/A | No `legacy/`/`modern/` interaction; this feature is kit-runtime-only (`migration/guildctl/`, `migration/registry/`). |
| III — Registry-Mediated Coordination | PASS | US3 keeps `releaseTask`'s claim-release path registry-mediated (same `artifacts`/`events` tables, same parameterized statements); it does not introduce an out-of-band recovery mechanism — it makes the existing registry-mediated recovery path (the documented `release` command) reach the state it was designed to reach. |
| IV — Separation of Powers: Builder, Critic, Arbiter | N/A | No claim/evidence/arbitration semantics touched by any of the three fixes. |
| V — Tests Before Production Code | PASS | All three fixes gated by new/extended `migration/test/*` cases (NFR-003) written before/alongside the fix — a failing-phase exit-code assertion, a `build:dist`-completes-and-serves-`/`+`/api/artifacts` assertion against the packaged output, and a `releaseTask` pending-claimed assertion. No live provider or live UI browser required — process exit codes, HTTP responses, and SQLite rows are all directly assertable. |
| VI — Fail-Closed Automation | PASS | US1 is the direct fail-closed fix: a failing phase must halt `&&`-chained/CI callers instead of silently reporting success. US3 is the direct fail-closed *escape-hatch* fix: the documented recovery path for a systemic executor error (crashed agent) must be actionable, per constitution.md:131 ("Credential and provider preflight MUST fail closed") and the general fail-closed-not-silent principle — refusing the one documented recovery command with a non-actionable error is itself a fail-*open* surprise for the operator. |
| VII — Pluggable Stacks, Neutral Providers | N/A | No provider/harness/stack-specific branching introduced by any of the three fixes — US2's packaging fix (`build-dist.mjs` + docs; `serve.ts`'s already-correct `UI_DIR` is untouched) and US3's status-guard widening are both provider-neutral kit runtime changes. |
| (no new violations) | — | No added projects, no new external services, no schema change, no new redaction path. |

## Project Structure

### Documentation (this feature)

```text
specs/011-pipeline-execution-correctness/
├── plan.md              # This file ($speckit-plan command output)
├── research.md          # Phase 0 output ($speckit-plan command)
├── data-model.md        # Phase 1 output ($speckit-plan command)
├── quickstart.md        # Phase 1 output ($speckit-plan command)
├── contracts/           # Phase 1 output ($speckit-plan command)
└── tasks.md             # Phase 2 output ($speckit-tasks command - NOT created by $speckit-plan)
```

### Source Code (repository root)

```text
migration/guildctl/
├── cli.ts                       # US1: run [phase] action, command def line 666, action lines 670–720
└── commands/inventory.ts        # US1 (reference only, unchanged): quality-gate throw line 461, recordInventoryCompletion line 453

migration/registry/
├── commands/serve.ts            # US2 (reference only, KEEP UNCHANGED): UI_DIR line 34 already correct for the shipped registry/dist bundle
└── commands/artifacts.ts        # US3: releaseTask lines 215–252, releaseClaimedArtifactsForOwner lines 258–277

migration/ui/
└── vite.config.ts               # US2 (reference only, unchanged): build.outDir → ../ui-dist

scripts/
└── build-dist.mjs               # US2: assembleTarball() line 183 copies non-existent migration/dist instead of registry/dist + guildctl/dist; missing UI build step

GETTING-STARTED.md                 # US2: documented CLI paths (lines ~65/131/186/188/189), migration/dist/registry/cli.js → migration/registry/dist/cli.js
setup.ts                           # US2: documented CLI paths (lines ~325/328/330), same correction

migration/test/
├── cli-run-phase-exit-code.test.ts   # NEW (US1: FR-001..FR-004, NFR-001)
├── registry-serve-ui-dir.test.ts     # NEW (US2: FR-005..FR-007, NFR-002)
└── artifacts-release-pending.test.ts # NEW (US3: FR-008..FR-010)
```

**Structure Decision**: No new directories; US1 and US3 land in the existing `migration/guildctl/` and `migration/registry/` modules that already own the `run` action and artifact release. US2 lands in the packaging script (`scripts/build-dist.mjs`) and the two docs that hardcode the built CLI path (`GETTING-STARTED.md`, `setup.ts`) — `migration/registry/commands/serve.ts` is explicitly out of scope for a code change; it is listed above only as a reference (its `UI_DIR` is already correct for the shipped bundle). Test files follow the established `migration/test/*.test.ts` flat layout; all three are new because no existing suite exercises `run [phase]` exit codes, `build-dist.mjs`'s packaging, or `releaseTask`'s status guard (verified by grep — see Technical Context).

## Technical Approach Per User Story

### US1 — A failed pipeline phase exits non-zero (#122, FR-001..FR-004, NFR-001)

**Module**: `migration/guildctl/cli.ts`, `run [phase]` action (command at line 666, action lines 670–720).

**Current behavior**: The `switch (phase)` body `await`s each phase function directly (e.g. `await runInventory(db())` at line 680) inside the commander `.action(async (phase, opts) => { … })` callback, with no surrounding `try/catch`. When `runInventory` throws (inventory.ts:461, on a failed quality gate), the rejection propagates out of the `switch`, out of the `async` action callback, and becomes an unhandled promise rejection at the commander level — which does not reliably set a non-zero OS exit code across Node/commander versions (the onboarding test observed exit `0` after a printed `✗ Inventory quality gate failed`). This is inconsistent with `preflight` (line 180, `if (result.verdict === "fail") process.exit(1)`) and `doctor` (lines 195, 237), which already convert their own failure signal into an explicit, deterministic exit.

**Change — wrap the switch body (cli.ts lines 670–720)**: Wrap the existing `switch (phase) { … }` in a `try { … } catch (err) { process.stderr.write(...); process.exitCode = 1; }`, so:
  - Any phase function that throws (the existing `runInventory`/`runScope`/`runPlan`/`runBootstrap`/`runMigrate`/`runReview`/`runRemediate`/`runRepair` failure paths) has its message written to stderr (preserving the existing printed diagnostic, e.g. inventory.ts:460's `✗ Inventory quality gate failed` block, which already runs before the throw) and sets `process.exitCode = 1`.
  - `process.exitCode` (not `process.exit()`) is used inside the `catch` so any already-scheduled stdout/stderr writes flush before the process exits — matching FR-002's determinism requirement without introducing the abrupt-exit risk `process.exit()` carries mid-async-cleanup.
  - The existing `default:` branch's `process.exit(1)` (current line ~718, unknown-phase case) and the `case undefined` branch (`printNextSteps`, no exit code change) are left as-is; they are unaffected by the wrap since neither throws.
  - A phase that resolves normally leaves `process.exitCode` unset (`undefined`, which Node treats as `0`), so the green path is unchanged (FR-003, NFR-001).

**Edge case handling (spec.md Edge Cases, #122)**:
  - *Unhandled-rejection swallowed by runtime*: the `try/catch` converts the throw into a synchronously-observed `catch` inside the same `async` action, so there is no unhandled-rejection window to depend on — satisfies "must normalize this to a non-zero exit deterministically… not rely on runtime unhandled-rejection defaulting."
  - *Phase logs failure but does not throw*: today every phase function that has a postcondition check throws on failure (inventory.ts:461 is the concrete instance; `runScope`/`runPlan`/etc. follow the same registry-recorded-failure-then-throw pattern used across `migration/guildctl/commands/`). The plan's `catch`-based wrap therefore covers the current codebase; if a future phase instead returns a failure indicator without throwing, the wrap alone would not catch it — this is called out as a residual risk (below), not a gap, since no phase in the current codebase does this today (verified: `inventory.ts`, and the sibling phase commands, throw on quality-gate/postcondition failure).

**Regression guard (FR-004)**: `preflight` (cli.ts:180) and `doctor` (cli.ts:195, 237) are untouched by this change — their `process.exit(1)` calls are outside the `run [phase]` action entirely — and are covered by an explicit regression assertion in the new test (below) rather than relying on "no diff" as proof.

**Behavior change**: `guildctl run inventory` against a failing quality gate now exits non-zero (`echo $?` after the process exits reports `1`); a passing inventory still exits `0`. Every other `run [phase]` case gets the same propagation for free since the wrap is around the whole `switch`, not a per-case addition.

### US2 — `registry serve` serves the built UI with no manual copy (#123, FR-005..FR-007, NFR-002)

**Modules**: `scripts/build-dist.mjs` (`assembleTarball()`, line 183), `GETTING-STARTED.md` (lines ~65/131/186/188/189), `setup.ts` (lines ~325/328/330). `migration/registry/commands/serve.ts` is a **reference-only, KEEP-UNCHANGED** module for this story.

**Current behavior**: `serve.ts`'s `UI_DIR = path.join(__dirname, "..", "..", "ui-dist")` (line 34) is already correct for the shipped bundle: `migration/tsup.config.ts` sets `outDir: "registry/dist"`, so the real compiled CLI is `migration/registry/dist/cli.js`, where `__dirname` = `migration/registry/dist` and `__dirname/../..` = `migration/ui-dist` — the real UI output dir per `migration/ui/vite.config.ts`'s `outDir`. A live smoke test (`node migration/registry/dist/cli.js serve` against a built `migration/ui-dist/`) returns `200` + real `index.html`. The real defect is upstream: `scripts/build-dist.mjs`'s `assembleTarball()` (line 183) unconditionally copies `repoRoot/migration/dist` into the tarball, but the `build:dist` pipeline runs `tsup` (writing `registry/dist` + `guildctl/dist`) and never runs anything that produces `migration/dist/**` — so on a clean checkout `npm run build:dist` throws `ENOENT` (no absent-dir guard) or, if a stray `migration/dist` exists from a prior manual `npm run build`, ships stale content. Separately, `GETTING-STARTED.md` and `setup.ts` hardcode `node migration/dist/registry/cli.js` as the built CLI path — a file the documented build never produces (the real artifact is `migration/registry/dist/cli.js`), so the operator's "monitor progress" instructions point at a non-existent binary.

**Fix A — repoint `build-dist.mjs`'s `assembleTarball()` at the real tsup outputs (line 183)**: Replace the unconditional copy of `repoRoot/migration/dist` with copies of `migration/registry/dist` and `migration/guildctl/dist` (the artifacts `tsup` actually produces per `migration/tsup.config.ts`), and add a UI build step (`build:ui`, or fold it into the existing `build:dist` script chain) so `migration/ui-dist` is built and copied into the tarball alongside them. This makes `npm run build:dist` complete without `ENOENT` on a clean checkout and ship a working UI (FR-005, FR-006).

**Fix B — correct the documented CLI paths (`GETTING-STARTED.md`, `setup.ts`)**: Replace every `node migration/dist/registry/cli.js` (and the `guildctl` equivalent) reference with `node migration/registry/dist/cli.js` (`migration/guildctl/dist/cli.js`), matching the real tsup output layout (FR-007).

**`serve.ts` stays as-is**: no code change — its `UI_DIR` resolution already works correctly once Fix A ensures `migration/ui-dist` actually exists in the packaged kit. `serve.ts`'s `/` route (line 224) already emits a named error on a missing UI; only the SPA-fallback branch (lines 229–234) is silently 404 on a per-file basis — this residual gap is noted but is not the #123 fix (the fix is making the UI actually present after `build:dist`), so no serve.ts change is required to satisfy FR-005..FR-007.

**Behavior change**: `npm run build:dist` on a clean checkout completes without `ENOENT` and produces a kit whose `migration/registry/dist/cli.js serve` serves `GET /` as `200` with the real `index.html`, and `GET /api/artifacts` returns real registry data — with no manual `ui-dist` copy. `GETTING-STARTED.md` and `setup.ts` now point operators at the CLI path that actually exists.

### US3 — `registry release` accepts a claimed-but-pending "stuck" artifact (#124, FR-008..FR-010)

**Module**: `migration/registry/commands/artifacts.ts`, `releaseTask` (lines 215–252).

**Current behavior**: Line 216–221 look up `status` by `id`; line 225 throws `RegistryError(2, ...)` if not found (unchanged); line 226 `if (artifact.status !== "in-progress")` throws `RegistryError(1, 'Cannot release "<id>": status is "<status>", expected "in-progress".')` (lines 227–230) for *any* other status, including the documented "stuck" case (`status='pending'`, `claimed_by` set). Only artifacts that reach `status === "in-progress"` proceed to the claim-release branch (lines 231–251), which already correctly clears `claimed_by`/`claimed_at`/`claimed_from`, resets `status` to `returnTo = fullArtifact.claimed_from ?? "planned"`, and writes a parameterized `status-changed` event (lines 246–249) with a reason string built from the operator-supplied `reason` (safe — string-templated into an event `summary` column via a parameterized `INSERT`, not interpolated into SQL).

**Change — widen the guard to admit the abandoned-claim case (artifacts.ts, line 226)**: Change the single-condition guard `artifact.status !== "in-progress"` to also accept `status === "pending" && claimed_by !== null`. Concretely: fetch the full artifact row (not just `status`, since `claimed_by` is now needed for the guard — the existing `SELECT status FROM artifacts WHERE id = ?` at lines 222–224 becomes `SELECT status, claimed_by FROM ...` or reuses the later full-row fetch) and branch:
  - `status === "in-progress"` → unchanged: proceeds to the existing claim-release branch (lines 231–251), covering FR-009's "leave `in-progress` + active-claim behavior unchanged."
  - `status === "pending" && claimed_by !== null` → new: treat identically to the `in-progress` claim-release branch — clear `claimed_by`/`claimed_at`/`claimed_from`, reset `status` to `claimed_from ?? "planned"`, write the same parameterized `status-changed` event with the operator's `reason` (FR-010). This is the literal GETTING-STARTED.md trigger (`claimed_by='crashed-agent', status='pending'`).
  - Anything else (notably `status === "planned" && claimed_by IS NULL`, i.e. never claimed) → unchanged: still throws the existing `RegistryError(1, ...)`, satisfying FR-009's "still refuse `planned` + unclaimed" — the widening is scoped to the abandoned-claim case only, not a general relaxation.
  - The error message for the still-refused cases should name both accepted states (`expected "in-progress" or "pending" with an active claim`) so an operator hitting the *genuinely* unclaimed case gets an accurate diagnostic — a small, in-scope wording change, not the alternative `--force`-flag design (spec.md pins either option as acceptable; this plan selects the guard-widening option (a) as primary since it directly satisfies the literal documented trigger without adding a new flag).

**Consistency with the bulk path (Edge Cases, #124)**: `releaseClaimedArtifactsForOwner` (lines 258–277) has its own SQL filter `WHERE status = 'in-progress' AND claimed_by = ?` (lines 268–269) for the "legacy rows" fallback it unions with the primary `releaseClaimedArtifactsForOwnerImpl` release. This plan intentionally leaves that bulk filter scoped to `in-progress` only (does not widen it to `pending`) — the bulk owner-release path is for a *live* agent's active claims being reassigned, not the single-artifact crash-recovery flow `releaseTask` serves — and this scoping decision is captured explicitly (not left implicit) per the Edge Cases instruction to "note it in tasks."

**Audit trail (FR-010)**: The new pending-claimed branch reuses the exact same parameterized `INSERT INTO events (...) VALUES (lower(hex(randomblob(8))), ?, 'status-changed', ?, ?)` statement shape already used at lines 246–249 — the operator-supplied `reason` flows through the same bound parameter, so no new SQL-injection surface is introduced.

**Behavior change**: `release --id "<id>" --agent operator --reason "crashed"` against `status='pending', claimed_by='crashed-agent'` now succeeds: the claim is cleared and status resets to `claimed_from ?? "planned"`, with a `status-changed` event recorded. The `in-progress` case and the unclaimed-`planned` refusal are both unchanged.

## Testing Strategy (Constitution V)

All tests use the existing `node:test` runner (`node --import tsx --test test/*.test.ts`). No live provider, no live browser, no live harness — process exit codes, HTTP responses against a locally-started `serve` instance, and SQLite row assertions are all directly observable in-process or via a local HTTP client.

### `migration/test/cli-run-phase-exit-code.test.ts` (NEW — US1, FR-001..FR-004, NFR-001)
- New case: spawn (or invoke in-process, matching the pattern used by `cli-phase-aliases.test.ts`) `guildctl run inventory` against a fixture workspace whose inventory quality gate fails (an artifact fixture that trips `validateInventoryQuality`'s `requireCompletion` check, mirroring `inventory.ts`'s own test fixtures) and assert the process's exit code is non-zero, while stderr still contains `Inventory quality gate failed` (the existing diagnostic text is preserved, not replaced).
- New case: the same invocation against a passing inventory fixture asserts exit code `0` (green-path regression, FR-003/NFR-001).
- New case (regression guard, FR-004): `guildctl preflight`/`guildctl doctor` against a `verdict: fail` fixture still exits non-zero — asserts the existing cli.ts:180/195/237 paths are untouched by the US1 change.
- Follows the existing `cli-phase-aliases.test.ts` pattern for spawning/invoking `cli.ts` against a fixture workspace.

### `migration/test/registry-serve-ui-dir.test.ts` (NEW — US2, FR-005..FR-007, NFR-002)
- New case: run `npm run build:dist` on a clean checkout (or a fixture-simulated equivalent invocation of `assembleTarball()`) and assert it completes without `ENOENT` and produces `migration/registry/dist/cli.js` + `migration/guildctl/dist/cli.js` + `migration/ui-dist/` in the packaged output — proving `build-dist.mjs` no longer depends on the never-created `migration/dist`.
- New case: start `serve` from the packaged `migration/registry/dist/cli.js`, `fetch` `http://127.0.0.1:<port>/` and assert `200` with the real `index.html` body (no manual `ui-dist` copy).
- New case: `fetch` `.../api/artifacts` against a populated in-memory/temp registry DB and assert `200` + a JSON array of real rows (reusing the registry test DB fixture pattern from `registry-api-queries.test.ts`).
- New case: grep `GETTING-STARTED.md` and `setup.ts` and assert neither references `migration/dist/registry/cli.js` (or the `guildctl` equivalent) — only `migration/registry/dist/cli.js` / `migration/guildctl/dist/cli.js`.
- New case (Edge Cases, "UI not built at all"): with no built UI, assert `serve`'s `/` route still surfaces its existing named error (serve.ts:224) rather than a silent 404 — a regression guard, not new behavior.

### `migration/test/artifacts-release-pending.test.ts` (NEW — US3, FR-008..FR-010)
- New case: seed a temp/in-memory registry DB with an artifact row `status='pending', claimed_by='crashed-agent'`, call `releaseTask(db, id, 'operator', 'crashed')`, and assert (FR-008/FR-010): no throw; the returned artifact has `claimed_by === null`, `claimed_at === null`, `claimed_from === null`, `status === (original claimed_from ?? 'planned')`; and an `events` row with `type === 'status-changed'` and a `summary` mentioning the reason exists.
- New case (FR-009, regression): an artifact with `status='in-progress'` and an active claim releases exactly as before (unchanged assertions against the existing claim-release path).
- New case (FR-009, still refused): an artifact with `status='planned'` and `claimed_by IS NULL` still throws `RegistryError` — the widening does not turn release into a no-op-safe call for never-claimed artifacts.
- New case (Edge Cases, audit trail): assert the `reason` string is passed as a bound parameter (not string-concatenated into SQL) by using a `reason` containing a SQL metacharacter (e.g. `"crashed'; DROP TABLE artifacts; --"`) and confirming the DB and its `artifacts`/`events` tables are intact afterward.
- Reuses whatever in-memory/temp-DB + schema-apply fixture pattern is already established for registry-layer tests (`registry-api-queries.test.ts`, `registry-schema-delta.test.ts`).

**Regression guard (SC-004)**: existing suites that exercise `cli.ts`'s `run`/`preflight`/`doctor` commands (`cli-phase-aliases.test.ts`) and any suite touching `registry/commands/artifacts.ts`'s existing `in-progress` release path must stay green; `serve.ts` itself is unchanged so its existing behavior is unaffected. All three changes are additive (a `try/catch` wrapper that no-ops on success, a packaging fix that repoints what `build-dist.mjs` copies without touching `serve.ts`, and a widened-not-narrowed status guard).

## Risks & Open Questions

**Risks**
- **US1 — `process.exitCode` vs `process.exit()`**: using `process.exitCode = 1` inside the `catch` (rather than `process.exit(1)`) means the process exits non-zero only once the event loop drains naturally. If any phase leaves a dangling handle (an open DB connection, an unresolved timer) after throwing, the process could hang rather than exit — mitigation: verify each phase's failure path already allows natural drain today (the `preflight`/`doctor` precedent uses `process.exit(1)` directly, which is more abrupt but has no drain risk; if hangs are observed in testing, this plan's fallback is `process.exit(1)` after a synchronous flush of the stderr write, matching the existing precedent exactly).
- **US2 — packaging fix must not silently mask a genuinely broken UI build**: once `build-dist.mjs` stops depending on `migration/dist`, it must still fail loudly (not silently skip) if `migration/ui`'s build step itself fails, rather than shipping a tarball with an absent `ui-dist` and a passing `build:dist` exit code — mitigation: the added UI build step is not wrapped in a try/swallow; a failed `vite build` propagates its non-zero exit through `build-dist.mjs` like the existing `tsup` step does.
- **US3 — guard widening scope**: widening `releaseTask`'s guard to `status='pending' && claimed_by != NULL` must not be reachable through any path *other* than an abandoned claim (e.g. a legitimately-`pending`-but-actively-being-claimed race). Mitigation: `claimed_by` is only set by the claim path (`claimTask`/equivalent), and a `pending` status with `claimed_by` set is-by-construction the abandoned/crashed state per the existing schema semantics documented in GETTING-STARTED.md — no other legitimate state produces this combination.

**Open Questions**
- US2's exact packaging mechanism — whether `build-dist.mjs` invokes `vite build` for `migration/ui` directly or shells out to a new `build:ui` npm script — is deferred to implementation/tasks; both satisfy FR-005/FR-006, and the choice is an implementation detail, not a behavior difference, and does not change the plan's Constitution Check or Summary.
- US3's error-message wording for the still-refused cases (exact phrasing naming both acceptable states) is deferred to implementation; FR-008/FR-009 constrain behavior, not exact string content.

## MVP vs Incremental Boundaries

All three user stories are P1 and are the entire scope of this spec (per spec.md's Input: "The three sub-issues are the entire scope of this spec"). There is no incremental/deferred slice — US1, US2, and US3 together constitute the MVP, gated by SC-001..SC-004.

- US1 (#122): `run [phase]` non-zero exit on failure, green path unchanged, preflight/doctor regression-guarded.
- US2 (#123): `build-dist.mjs` packages the real tsup outputs (`registry/dist` + `guildctl/dist`) plus a built `ui-dist` instead of the never-created `migration/dist`, and `GETTING-STARTED.md`/`setup.ts` document the real CLI path; `serve.ts` itself is unchanged.
- US3 (#124): `releaseTask` accepts the documented pending-claimed "stuck" recovery case without weakening the `in-progress` or unclaimed-`planned` guards.
- Regression tests: three new `migration/test/*.test.ts` files (SC-004, NFR-003) — no existing suite covers any of these three paths today.
