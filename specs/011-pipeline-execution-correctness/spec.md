# Feature Specification: Fix Pipeline Execution Correctness (Onboarding Hardening, Wave 4)

**Feature Branch**: `011-pipeline-execution-correctness`

**Created**: 2026-08-17

**Status**: Draft

**Input**: Issue #133 (Wave 4 of the onboarding-hardening plan, from the 2026-08-16 black-box onboarding test). Tracking issue that fixes three execution-correctness defects surfaced against a *working* provider/harness (i.e. once Wave 3 lets phases actually run). The three sub-issues are the entire scope of this spec, covering findings F11 (#122), F12 (#123), F13 (#124) in `onboarding-test-report.md`:

- **#122 — failed pipeline phases and preflight return exit code 0**: a `run inventory` (or `preflight`) that ends in `FAIL` / `completion=missing` still exits `0`, breaking `&&`-chained shell usage and any CI gating that trusts the process exit code.
- **#123 — Mission Control UI `serve` looks for `migration/dist/ui-dist` while `migration/ui` builds to `migration/ui-dist`**: the server starts and listens but 404s the UI until the operator manually copies `ui-dist` → `migration/dist/ui-dist`.
- **#124 — `registry release` refuses a claimed-but-pending artifact even though the docs describe this as the "stuck" case**: the operator escape hatch in GETTING-STARTED.md fails against `claimed_by='crashed-agent', status='pending'` with a non-actionable refusal.

**Source context**: derived from reading the actual code on `origin/dev` (HEAD `486b585`, post Wave 3):

- `migration/guildctl/cli.ts` (`run [phase]` action, lines 665–720) — each phase is awaited in a `switch` with **no `try/catch` and no `process.exit` on failure**. `runInventory` (inventory.ts) *does* `throw` on quality-gate failure (line 461), but the unhandled rejection from an `async` commander action is not converted to a non-zero exit in all environments; in the onboarding run it printed `✗ Inventory quality gate failed` / `completion=missing` and still exited `0`. The `preflight`/`doctor` path (cli.ts lines 180, 195, 237) already calls `process.exit(1)` on `verdict === "fail"` — so the inconsistency is specifically the `run [phase]` branch, which lacks equivalent propagation. **Fix direction**: wrap each phase invocation so a thrown error or an explicit failure verdict sets a non-zero exit code, consistent with the existing preflight/doctor pattern. This is a direct constitution Principle I violation ("Exit code zero is not completion evidence" must cut both ways: a failing phase must not report success via exit code).
- `migration/guildctl/commands/inventory.ts` (lines 433–461) — `getInventoryCompletionStatus` + `validateInventoryQuality(..., { requireCompletion: true })` already compute the failure; the failure is recorded (`recordInventoryCompletion({ status: "failed" })`) and thrown, but the `run` wrapper does not propagate it to the OS exit code. Same pattern applies to `scope`/`plan`/`bootstrap`/`migrate`/`review`/`remediate`/`repair` phases: each should propagate a non-zero exit when its own postcondition check fails.
- `migration/registry/commands/serve.ts` (lines 33–34) — `const UI_DIR = path.join(__dirname, "..", "..", "ui-dist");` with the comment "ui-dist is one level up from registry/dist/ → migration/ui-dist/". The comment is **wrong for the built artifact**: the compiled CLI is emitted to `migration/dist/registry/commands/serve.js`, so `__dirname` = `migration/dist/registry/commands` and `__dirname/../..` = `migration/dist/`, making `UI_DIR = migration/dist/ui-dist` — a directory that never exists. Meanwhile `migration/ui/vite.config.*` sets `build.outDir = ../ui-dist` (relative to `migration/ui/`) → the UI actually builds to `migration/ui-dist/`. The onboarding test confirmed: after `npm --prefix migration/ui run build`, output lands in `migration/ui-dist/`, but `serve` 404s until `ui-dist` is manually copied to `migration/dist/ui-dist`. The reporter's manual copy made `/` return 200 and `/api/artifacts` return real data. **Fix direction (pick one, document the chosen one)**: (a) change `UI_DIR` to resolve against the repo/kit root the CLI was invoked from or via `require.resolve` of the package root so it points at `migration/ui-dist` regardless of build depth, **or** (b) relocate the UI build output into `migration/dist/ui-dist` so the existing `__dirname/../../ui-dist` resolves correctly, **or** (c) keep the manual step but make it explicit + enforced by adding `build:ui` into `build:dist` and documenting it in GETTING-STARTED.md. The chosen fix must make `node migration/dist/registry/cli.js serve` serve a 200 `/` and real `/api/artifacts` data with **no manual copy** after `build:dist`.
- `migration/registry/commands/artifacts.ts` (`releaseTask`, lines 215–256) — explicitly throws `RegistryError(1, 'Cannot release "<id>": status is "<status>", expected "in-progress".')` when `artifact.status !== "in-progress"` (lines 226–231). GETTING-STARTED.md's troubleshooting table tells the operator to run `release --id "<id>" --agent operator --reason "crashed"` for "an agent left a file stuck" — a claim the agent may have crashed holding while still `pending` (`claimed_by` set, `status='pending'`). That combination is itself evidence of an abandoned claim, but the code rejects it before the operator ever reaches the release path. **Fix direction (pick one)**: (a) accept `status === "pending" && claimed_by != NULL` as a releasable "stuck" state (treat the pending-claimed artifact like in-progress: clear `claimed_by`, return to `claimed_from ?? "planned"`), **or** (b) keep the guard but make the error message state the required status and add a `--force` flag for the operator escape hatch the docs already promise. The chosen fix must let the literal GETTING-STARTED.md trigger (`claim left stale with status 'pending'`) release the artifact.

**Governing document**: `.specify/memory/constitution.md` — principally **I (Evidence Over Assertion: exit code zero is not completion evidence — a failing phase must not report success via exit code either)**, and **VI (Fail-Closed Automation: the operator escape hatch must be actionable; do not refuse a documented recovery path with a non-actionable error)**. Principle I governs #122; VI governs #124 (the operator recovery path must work as documented).

## User Scenarios & Testing *(mandatory)*

Primary persona: the **scripted/CI operator** who chains `guildctl run inventory && <next>` and relies on the OS exit code to gate the next step (#122), and who runs `registry serve` to monitor progress without a manual build step (#123). Secondary persona: the **recovery operator** following GETTING-STARTED.md's "agent left a file stuck → release" instruction after an agent crash (#124). Tertiary persona: the **maintainer** running `migration/test` as a regression gate for all three fixes.

### User Story 1 - A failed pipeline phase exits non-zero (Priority: P1)

A scripted operator runs `guildctl run inventory` in a workspace whose inventory quality gate fails (or whose completion check is `missing`). The command must exit with a **non-zero** code so `&&`-chained steps and CI gates stop, instead of silently proceeding on exit `0`. The same must hold for `preflight`/`doctor` (already partially wired) and for every `run [phase]` whose own postcondition check fails.

**Why this priority**: #122 — this is a direct Principle I violation and the headline finding of Wave 4. A `0` exit on a failed phase makes every downstream `&&` and CI gate unsafe, and is the most dangerous of the three because it hides failure broadly.

**Independent Test**: invoke the `run [phase]` action for a phase that fails its postcondition (e.g. an inventory fixture whose quality gate fails, or inject a `runInventory` that returns a failed completion) and assert `process.exitCode !== 0` (or the spawned `cli.js` process exits non-zero). Delivers value if a `FAIL`/`completion=missing` run yields a non-zero shell exit, and a `success` run still yields `0`.

**Acceptance Scenarios**:
1. **Given** `guildctl run inventory` ends with `Inventory quality gate failed` / `completion=missing`, **When** the CLI process exits, **Then** the OS exit code is non-zero (consistent with the existing `preflight`/`doctor` `process.exit(1)` behavior at cli.ts:180/195/237).
2. **Given** any `run [phase]` whose phase function throws or returns a failed postcondition, **When** the action runs, **Then** the non-zero exit is propagated (a `try/catch` around the phase invocation converts the failure to a non-zero exit), and the failure text on stderr is preserved.
3. **Given** a phase that completes successfully, **When** the action runs, **Then** the exit code remains `0` (the fix must not change green-path behavior).
4. **Given** `guildctl doctor` / `guildctl preflight` reports `verdict: fail`, **When** it exits, **Then** it still exits non-zero (regression guard for the already-wired path).

---

### User Story 2 - `registry serve` serves the built UI with no manual copy (Priority: P1)

An operator runs `node migration/dist/registry/cli.js serve` after `build:dist` (which builds `migration/ui`) and opens `:3322`. `GET /` must return `200` with the real `index.html`, and `GET /api/artifacts` must return real artifact data — **without** anyone manually copying `ui-dist` → `migration/dist/ui-dist`.

**Why this priority**: #123 — it is the "Monitor progress" path in GETTING-STARTED.md and currently 404s out of the box, forcing a manual, undocumented relocation. P1 because it blocks the documented monitoring workflow and is a deterministic, reproducible defect (the path arithmetic is simply wrong for the built layout).

**Independent Test**: build the UI (`npm --prefix migration/ui run build` or `build:dist`), start `serve`, and `fetch` `http://127.0.0.1:3322/` and `http://127.0.0.1:3322/api/artifacts`. Delivers value if `/` returns `200` HTML and `/api/artifacts` returns a JSON array (real data), and the test asserts `migration/dist/ui-dist` does **not** need to exist for this to work.

**Acceptance Scenarios**:
1. **Given** the UI has been built to its actual output dir (`migration/ui-dist/`, per `migration/ui/vite.config.*` `outDir: ../ui-dist`), **When** `serve` starts, **Then** `GET /` returns `200` with the built `index.html` (no 404 "UI not built").
2. **Given** a populated registry DB, **When** `serve` is up, **Then** `GET /api/artifacts` returns real artifact rows (HTTP `200`, JSON array), matching the onboarding test's post-fix observation.
3. **Given** the chosen fix changes `UI_DIR` resolution, **When** the CLI is run from the built `migration/dist/registry/` layout, **Then** `UI_DIR` resolves to the real UI output dir regardless of how many `dist/` nesting levels exist (use `require.resolve` of the package root or an explicit kit-root constant, not a blind `../..`).
4. **Given** `build:dist` is the documented one-shot build, **When** it runs, **Then** it builds the UI as part of the kit build so `serve` works immediately (or, if the fix keeps a separate UI build, GETTING-STARTED.md documents the exact build step and `serve` verifies the UI dir exists and emits a named error if missing — never a silent 404).

---

### User Story 3 - `registry release` accepts a claimed-but-pending "stuck" artifact (Priority: P1)

A recovery operator follows GETTING-STARTED.md: "Agent left a file stuck → `release --id "<id>" --agent operator --reason "crashed"`." The artifact has `claimed_by='crashed-agent'` but `status='pending'` (the agent crashed before it flipped the artifact to `in-progress`). The release must succeed and clear the claim, returning the artifact to `claimed_from ?? "planned"`.

**Why this priority**: #124 — the docs explicitly promise this escape hatch, but the code refuses the exact state the docs describe as the stuck case. P1 because it strand-locks recovery: an operator who trusts the documented command hits a wall with no indication of what state is required.

**Independent Test**: insert an artifact with `status='pending', claimed_by='crashed-agent'`, call `releaseTask(db, id, 'operator', 'crashed')`, and assert it returns an artifact with `claimed_by = NULL` and `status` reset to `claimed_from ?? 'planned'` (no throw). Delivers value if the literal GETTING-STARTED.md trigger releases the artifact.

**Acceptance Scenarios**:
1. **Given** an artifact with `status='pending'` and `claimed_by != NULL`, **When** `releaseTask` runs, **Then** it succeeds: `claimed_by` is cleared, `claimed_at`/`claimed_from` are cleared, and `status` is reset to `claimed_from ?? 'planned'`; an `status-changed` event is recorded with the operator's reason.
2. **Given** an artifact with `status='in-progress'` and an active claim (today's working case), **When** `releaseTask` runs, **Then** behavior is unchanged (releases via `releaseClaimByArtifactId`).
3. **Given** an artifact with `status='planned'` and `claimed_by IS NULL` (never claimed), **When** `releaseTask` runs, **Then** it still refuses (nothing to release) — the fix only widens the releasable set to the abandoned-claim case (`claimed_by != NULL`), it does not make release a no-op for unclaimed artifacts.
4. **Given** the alternative fix (keep the `in-progress`-only guard + add `--force`), **When** the operator passes `--force` (or the error message names the required status), **Then** the documented recovery still completes and the error message tells the operator exactly what state is required.

---

### Edge Cases
- **#122 — partial phase failure swallowed by unhandled rejection**: if a phase throws inside the `async` commander action, Node may print "UnhandledPromiseRejection" and still exit `0` in some runtime/config states. The fix must normalize this to a non-zero exit deterministically (catch + `process.exitCode = 1`), not rely on runtime unhandled-rejection defaulting.
- **#122 — phase that logs failure but does not throw**: `runInventory` currently both records `failed` and throws (line 461). If any phase instead returns a failure indicator without throwing, the `run` wrapper must still detect the failed postcondition (read the recorded completion / phase verdict) and exit non-zero — do not assume "throw" is the only failure signal.
- **#123 — UI not built at all**: `serve` must emit a named error (`UI not built. Run build:ui / build:dist`) if the resolved `UI_DIR` is absent, rather than silently 404ing with no diagnostic — and this error must name the *actual* build command for the chosen fix.
- **#123 — dev vs built layout divergence**: the fix must work both when run from `migration/registry/commands/serve.ts` (source, `__dirname` shallower) and from `migration/dist/registry/commands/serve.js` (built, `__dirname` deeper). Resolve the UI dir from the kit/package root, not a fixed `../..` count, so both layouts serve correctly.
- **#124 — `releaseClaimedArtifactsForOwner`** (artifacts.ts:258) bulk-releases with the same `status = 'in-progress'` SQL filter (lines 268–269); if the chosen fix widens `releaseTask` to pending-claimed, keep the bulk path consistent (or intentionally scope it) and note it in tasks.
- **#124 — event/audit trail**: a pending-claimed release must still write the `status-changed` event (for auditability) and must redact nothing sensitive; the `reason` string is operator-supplied and free-form, so it must not be trusted as SQL (use parameterized statements, as today).

## Requirements *(mandatory)*

### Functional Requirements
- **FR-001** (Story 1, P1): The `run [phase]` action in `migration/guildctl/cli.ts` MUST wrap each phase invocation in error handling that sets a non-zero process exit code when the phase throws or fails its own postcondition check (quality gate / completion / planning-readiness / etc.), mirroring the existing `preflight`/`doctor` `process.exit(1)` behavior.
- **FR-002** (Story 1, P1): The non-zero exit MUST be deterministic across Node runtime configurations (explicit `process.exitCode = 1` / `process.exit(1)`), not dependent on unhandled-promise-rejection defaults.
- **FR-003** (Story 1, P1): A phase that completes successfully MUST still exit `0`; green-path behavior is unchanged.
- **FR-004** (Story 1, P1): The existing `preflight`/`doctor` non-zero-exit paths (cli.ts:180/195/237) MUST remain non-zero on `verdict: fail` (regression guard).
- **FR-005** (Story 2, P1): `migration/registry/commands/serve.ts` MUST resolve the UI directory to the real UI build output (`migration/ui-dist`, per `migration/ui/vite.config.*`) from both source and built CLI layouts, so `serve` returns `200 /` with real `index.html` after `build:dist` with no manual copy.
- **FR-006** (Story 2, P1): `GET /api/artifacts` (and the other `/api/*` routes) MUST return real data when the registry DB is populated, with no manual relocation of `ui-dist`.
- **FR-007** (Story 2, P1): If the resolved UI dir is absent, `serve` MUST emit a named, actionable error stating the exact build command for the chosen fix, instead of a silent 404.
- **FR-008** (Story 3, P1): `releaseTask` (artifacts.ts) MUST accept an artifact with `status='pending'` and `claimed_by != NULL` as a releasable "stuck" state — clearing the claim and resetting `status` to `claimed_from ?? 'planned'` — OR MUST keep the guard but add a `--force` flag and a clearer required-status error message. The literal GETTING-STARTED.md "agent left a file stuck" trigger MUST succeed either way.
- **FR-009** (Story 3, P1): `releaseTask` MUST leave `status='in-progress'` + active-claim behavior unchanged, and MUST still refuse `status='planned'` + unclaimed artifacts (only the abandoned-claim case is widened).
- **FR-010** (Story 3, P1): Any release (including the widened case) MUST write a parameterized `status-changed` event with the operator's reason (audit trail; no SQL injection via free-form `reason`).

### Non-Functional Requirements
- **NFR-001**: The #122 fix MUST NOT change green-path exit codes or phase output format; it only adds failure propagation.
- **NFR-002**: The #123 fix MUST work from both `migration/registry/commands/serve.ts` (source) and `migration/dist/registry/commands/serve.js` (built) without a layout-specific constant.
- **NFR-003**: All three fixes MUST be covered by `migration/test` regression tests (exit-code propagation, serve UI path resolution + `/` + `/api/artifacts`, release pending-claimed) so Wave 5 onboarding cannot regress them silently.

## Success Criteria *(mandatory)*
- **SC-001**: `guildctl run inventory` against a failing inventory exits non-zero; a passing inventory exits `0`. (covers FR-001/003)
- **SC-002**: `node migration/dist/registry/cli.js serve` after `build:dist` returns `200` at `/` and real data at `/api/artifacts` with no manual `ui-dist` copy. (covers FR-005/006)
- **SC-003**: `release --id "<id>" --agent operator --reason "crashed"` against `status='pending', claimed_by='crashed-agent'` succeeds and clears the claim. (covers FR-008/009/010)
- **SC-004**: `migration/test` passes for all three added regression suites and the existing preflight/doctor non-zero-exit guard. (covers NFR-003)
