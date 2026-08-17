# Plan: Spec 009 — Workspace Build & Scaffolding Entry Points

**Status:** Ready for implementation (plan only — no source modified)
**Spec:** `specs/009-workspace-scaffolding-entry-points/spec.md`
**Branch / worktree:** `spec-131-wave2` (detached HEAD worktree at `/home/homelab/workspaces/migration-guild-worktrees/spec-131-wave2`)
**Constraint summary:** Plan-only. No edits to `scripts/build-dist.mjs`, `setup.ts`, or anything under `package/`. Source-of-truth boundary (`.github/agent-instructions.md`, constitution §Repository Source-of-Truth Boundaries): this repo is the kit source, never a migration workspace — validate the build/packaging behavior against the kit source only.

## Goal

Close three onboarding-hardening gaps on the Wave 2 build/scaffolding entry points (GitHub issue #131):

- **US1 (P1) — #116**: `npm run build:dist` crashes with `ENOENT` when the repo-root `docs/` directory is absent, because `assembleTarball()` in `scripts/build-dist.mjs` unconditionally `fs.cp`s it. Make the copy tolerant of absence.
- **US2 (P1) — #117**: the interactive setup wizard silently no-ops (exit 0, "Done. N file(s) installed.") when the legacy-source prompt is left blank and no local path was given. Add a fail-closed, explicit no-legacy-source warning.
- **US3 (P2) — #118**: the interactive wizard offers only a URL prompt for the legacy source, even though the non-interactive `--legacy-path` flag already works. Add a URL-vs-local-path choice to the interactive branch.

US2 and US3 share `runInstall()` in `setup.ts` and MUST ship as one coordinated change (SC-004).

## Governing constraints (from constitution + spec)

- **Principle V (Tests Before Production Code)** — Kit behavior itself MUST be covered by the `migration/test` suite; changes to phase-control-flow / installer behavior MUST ship with regression tests. Tests are written first, then production code. Tests MUST use the target test framework used by this repo.
- **Principle VI (Fail-Closed Automation)** — Autonomous execution stops rather than guesses. The missing no-legacy-source warning (#117) is exactly the gap this principle exists to close: a blank legacy prompt must surface an explicit, distinguishable warning, not a silent success.
- **FR-001..FR-004** (#116) — existence-check `docs/` before copy; skip-and-continue when absent; unchanged copy when present; distinguish `ENOENT` (skip) from other copy failures (throw), per the existing `.env.example` skip pattern.
- **FR-005..FR-009** (#117) — detect "no legacy source resolved" at completion; emit a distinct warning; fire in both interactive and non-interactive paths; do NOT fire when a source was provided; existing clone/copy mechanics unchanged.
- **FR-010..FR-013** (#118) — interactive URL-or-local-path choice; reuse the existing `--legacy-path` copy mechanism; validate the local path (error if missing/unreadable/file-not-dir) without treating it as "supplied"; mutually exclusive per run.
- **Repo source-of-truth boundary**: do NOT run migration phases or recreate `legacy/`/`modern/` at repo root. Tests must exercise `setup.ts`/`build-dist.mjs` behavior in isolation (temp dirs, flag-driven), never against the kit source tree as a workspace.

## Actual current behavior (grounding — read before implementing)

### `scripts/build-dist.mjs` (`assembleTarball`, lines 143–184)
- The assembled staging dir is `dist/migration-guild-kit-build` (`buildDir`, line 14).
- Line 154 copies docs unconditionally inside a `Promise.all`:
  `fs.cp(path.join(repoRoot, "docs"), path.join(buildDir, "docs"), { recursive: true })`.
  When `repoRoot/docs` does not exist this rejects → `main().catch` sets `process.exitCode = 1` → entire dist build fails (FR-001/FR-002).
- The exact precedent for "skip-if-absent" already exists at lines 160–167: `.env.example` is copied inside a `try/catch` that swallows only `Error.code === "ENOENT"` and rethrows anything else. FR-004's "distinguish not-found from other failures" requirement is satisfied by mirroring this pattern.
- `repoRoot` is resolved at line 12 (`path.resolve(__dirname, "..")`), so `docs` means the top-level `docs/` at the kit root — matches the spec's "Repo-root `docs/`" assumption.

### `setup.ts` (`runInstall`, lines 166–303) + CLI flags
- CLI flags parsed at lines 50–53 (`flag(name)`), 175–177 (`--framework`, `--legacy-url`, `--legacy-path`), 178 (`nonInteractive` detection).
- Interactive legacy prompt: **single URL prompt only** at line 205:
  `repoUrl = (await ask(rl, "Legacy repo URL (leave blank to skip): ")).trim();` then `rl.close()` at line 206. There is NO local-path prompt — this is the #118 gap.
- Non-interactive local-path copy (the working machinery #118 must reuse): lines 277–287:
  `else if (legacyPath)` → `copyDir(legacyPath, legacyDir, [".git"])` and logs `` ✓ ${files.length} files copied into legacy/ ``. `copyDir` (lines 96–112) returns `[]` if `src` missing and throws on bad read — so an invalid path already produces a `✗ Copy failed` message but does NOT set a "legacy supplied" flag.
- Post-copy reporting: line 289 `Done. ${total} file(s) installed.`; line 290 `hasLegacy = repoUrl || legacyPath`; lines 291–302 "Next steps" — when `!hasLegacy` it prints `1. Copy your legacy Java source into legacy/` (the existing soft hint that #117 must supplement with a hard warning).
- `--yes` path (line 178, 181–187) sets `repoUrl = ""`, `legacyPath = cliPath` and NEVER calls the legacy branch → an operator who runs `node setup.js --yes` with no flags gets 0 legacy files and only the soft hint. IMPORTANT: `cliPath = flag("--legacy-path")` is `undefined` unless `--legacy-path` is also passed, so a **bare** `node setup.js --yes` leaves BOTH `repoUrl === ""` and `legacyPath === undefined` → `hasLegacy` (line 290) is falsy → the new FR-007 warning MUST fire here. This bare `--yes` no-flag run is the canonical non-interactive no-legacy case (US2 Acceptance Scenario 5) and is covered by the warning computed at US2.1. FR-007 coverage (T021) is already correct.

## Data-model

**N/A.** No schema change. This feature changes only build-time and installer control flow in `scripts/build-dist.mjs` and `setup.ts`. No SQLite registry tables, no new file formats, no persisted state, no environment variables are introduced (per spec Assumptions). The "legacy source" entity is an in-memory `repoUrl | legacyPath` resolution already present in `runInstall()`.

## Contracts

**N/A.** No API/interface change. There is no public module boundary, HTTP endpoint, or exported function signature touched:
- `scripts/build-dist.mjs` keeps the same CLI (`node ./scripts/build-dist.mjs [--version]`) and the same output artifact (`dist/migration-guild-kit.tar.gz`). Only the internal docs-copy step becomes conditional.
- `setup.ts` keeps the same CLI flags and the same stdout contract; the only additions are (a) a new warning line and (b) one extra interactive prompt. `copyDir` is reused, not modified in signature. Behavior-only changes confined to a single `build:dist` invocation and a single `runInstall()` execution (spec Assumptions).

## Technical approach (no code — concrete, unambiguous)

### US1 / #116 — tolerate absent repo-root `docs/` in `assembleTarball()`
1. In `scripts/build-dist.mjs`, before the `Promise.all` copy block (around line 149), add an `fs.existsSync(path.join(repoRoot, "docs"))` guard for `docs/` only.
2. If absent, drop the `docs` entry from the `Promise.all` array so the build continues; emit an informational log line (e.g. `docs/ not found at repo root — skipping (build is tolerant of its absence)`). Do NOT change any other entry in the array (setup.js, README.md, GETTING-STARTED.md, AGENTS.md).
3. If present, copy `docs/` exactly as today (line 154 unchanged) — no destination/content change.
4. Honor FR-004 by NOT wrapping the copy in a broad `try/catch` that swallows all errors. Either (a) guard with `existsSync` so no `fs.cp` is attempted when absent, leaving the existing `Promise.all` rejection path intact for genuine failures; OR (b) mirror the `.env.example` pattern at lines 160–167 — wrap only the `docs` copy, catch, and rethrow unless `error?.code === "ENOENT"`. Option (a) is preferred (simpler, no new swallow surface); option (b) is the fallback if existence-check + copy race is a concern. Either way "directory does not exist" is the only skip case; permission/other errors still surface.

### US2 + US3 / #117 + #118 — coordinated change to `runInstall()` in `setup.ts`
These two must be implemented in the same edit of `runInstall()` (SC-004).

**Interactive branch (lines 188–207): replace the single URL prompt with a URL-or-local-path choice.**
1. After the framework prompt (line 203), introduce a choice prompt in the existing single-numbered-choice style used for `FRAMEWORKS`: e.g. print `1. Legacy repo URL  2. Local directory path` and read a choice.
2. If URL chosen → keep the existing line-205 `ask` for the URL (`repoUrl`).
3. If local-path chosen → `ask` for a directory path and assign it to `legacyPath` (the same variable used by the non-interactive branch at line 177/277). Do NOT prompt for a URL in this case (mutually exclusive, FR-013).
4. If the operator declines both (blank/skip at the choice prompt) → leave both `repoUrl` and `legacyPath` empty; the run falls through to the US2 warning (no loop, no crash, spec Edge Case + Acceptance Scenario 5 of US3).
5. Keep `rl.close()` exactly where it is (line 206) so the readline interface is released before file copies begin.

**Local-path copy reuse (lines 277–287): already correct — reuse as-is.**
- The `else if (legacyPath) { copyDir(legacyPath, legacyDir, [".git"]) ... }` block already copies and reports a count. It is the single mechanism both the non-interactive flag and the new interactive prompt drive. No new copy function is introduced; FR-011 is satisfied by routing the interactive `legacyPath` into this branch.
- FR-012 (invalid local path): `copyDir` returns `[]` for a missing `src` and throws for an unreadable tree, producing the existing `✗ Copy failed` line. The plan keeps that behavior; the run is NOT recorded as "legacy supplied" because `legacyPath` truthiness is the only signal and an empty/invalid copy leaves `legacy/` empty — so the US2 warning (below) still fires. Optionally, for a clearer FR-012 message, the implementation may add an explicit pre-check (`fs.existsSync(legacyPath) && fs.statSync(legacyPath).isDirectory()`) and log `✗ Legacy path is not a directory: <path>`; this is a presentational refinement, not a behavioral requirement.

**Fail-closed warning (US2 — new, lines ~288–302, after the existing "Done." line):**
1. After line 289 (`Done. ${total} file(s) installed.`), compute `const legacyResolved = Boolean(repoUrl) || Boolean(legacyPath);` — NOTE: `hasLegacy` at line 290 currently uses the same expression; the warning keys off the *resolved* value at completion, not the prompt input, so it also catches a blank `--yes` run (FR-007).
2. When `!legacyResolved`, emit a distinct, clearly-labeled warning block — e.g. a heading line `⚠ WARNING: No legacy source was provided` followed by `legacy/ is empty (0 files).` and a next-steps line telling the operator to copy their legacy source into `legacy/` (this supplements, does NOT replace, the existing soft hint at lines 292–302). The warning text MUST be distinguishable from the routine `Done.` summary (FR-006). The exact wording is a planning-phase decision per spec Assumptions; the `⚠`/`WARNING` prefix satisfies "clearly-labeled."
3. When `legacyResolved` is true (URL cloned, or local path copied, interactive or flag) → no warning (FR-008). The existing clone/copy success logs (lines 272, 282) are unchanged.
4. Exit code: FR-006/Acceptance Scenario 2 treat the warning as the required minimum and a non-zero exit as optional. The plan leaves the exit code at 0 by default to minimize blast radius, but notes that a non-zero exit (e.g. `process.exitCode = 1`) is an acceptable additional signal the implementer MAY add; if added, it MUST be applied uniformly to both interactive and non-interactive no-legacy runs.

**Non-interactive path (lines 180–187, 277–287): no new prompt; the same warning applies.**
- `--yes` or `--legacy-url`/`--legacy-path`-driven runs already set `repoUrl`/`legacyPath`. The warning computed at step US2.1 fires identically when neither resolves (FR-007). No interactive prompt is shown in non-interactive mode.

## Research notes

None required. All three fixes are small, well-understood control-flow changes grounded directly in the current source:
- #116's skip precedent already exists (`build-dist.mjs:160-167` `.env.example` ENOENT swallow).
- #118's copy mechanism already exists (`setup.ts:277-285` `--legacy-path` branch).
- #117's detection point is the existing `hasLegacy` expression at `setup.ts:290`.
No external libraries, new dependencies, or architectural decisions are needed. (The spec's mention of "vitest" is a generic placeholder; this repo's `migration/test` suite uses Node's built-in test runner — see Verification — so the new tests must target that framework, not vitest.)

## Phased plan

### Phase 0 — Setup / foundational (docs + test scaffolding)
- Create `specs/009-workspace-scaffolding-entry-points/plan.md` (this file).
- Create `specs/009-workspace-scaffolding-entry-points/tasks.md` (implementation checklist derived from the phases below) and `analyze.md` if the repo's speckit flow expects it (reference `specs/008-expand-mock-legacy-fixtures/plan.md` Phase 0 shape). NOTE: this plan step only *creates docs*; it does not modify source.
- Confirm test harness: `migration/test/*.test.ts` run via `node --import tsx --test` (see `migration/package.json` `test` script, line 13). New tests for #116/#117/#118 are added as `migration/test/*.test.ts` files using the same framework — not vitest. Validate that `scripts/build-dist.mjs` and `setup.ts` can be imported/invoked in tests (build-dist.mjs is an ESM script with a top-level `main()` side effect — the test will likely shell out via `execFileSync('node', ['scripts/build-dist.mjs'], {cwd: tmp})` rather than import, to avoid the side-effect; `setup.ts` similarly invoked via `execFileSync('node', ['dist/setup.js' | 'setup.ts'], {cwd: tmpWorkspace, ...})`).

### Phase 1 — US1: docs/ skip in `assembleTarball()` (P1, MVP)
- **Tests first (Principle V):**
  - `migration/test/build-dist-docs-skip.test.ts`:
    1. In a temp dir that mirrors the kit root layout (copy a minimal `package/`, `migration/dist/`, `stacks/`, `README.md`, `GETTING-STARTED.md`, `AGENTS.md`, and `dist/setup.js`) with **no `docs/`**, run `node scripts/build-dist.mjs` and assert exit code 0 and that `dist/migration-guild-kit.tar.gz` exists.
    2. Assert the assembled staging dir (`dist/migration-guild-kit-build`) has **no `docs/`** entry and that the other expected entries (setup.js, README.md, GETTING-STARTED.md, AGENTS.md, `package/`, `migration/dist/`, `stacks/`) are present.
    3. Regression: with `docs/` present (populated), run the build and assert exit 0, tarball exists, and the staging `docs/` matches the source (entry present).
    4. FR-004: simulate a non-ENOENT failure (e.g. a `docs` that exists but is unreadable by the test process) and assert the build still surfaces the error (rejects / non-zero exit) rather than silently skipping — only the absent case is skipped. (This case may be covered by asserting the `.env.example` precedent behavior is preserved, or by a targeted unit if feasible.)
- **Production code (after tests fail):** apply the US1 technical approach above to `scripts/build-dist.mjs` (around line 149/154). No other file touched.
- **Why MVP:** highest-leverage, lowest-risk fix; a hard build break blocking all downstream onboarding.

### Phase 2 — US2 + US3: coordinated `runInstall()` change — fail-closed warning + interactive local-path prompt (P1 + P2, MVP includes US2; US3 delivered here per SC-004)
- **Tests first (Principle V):**
  - `migration/test/setup-runinstall-legacy.test.ts` (or split into two files; both target `setup.ts` via subprocess in a temp workspace outside the kit root):
    1. **US2 interactive blank:** run `node setup.ts` in a temp workspace, answer the framework prompt with default, answer the legacy-source choice with "skip/blank", let it finish. Assert stdout contains the explicit no-legacy-source warning (`⚠`/`WARNING` + `legacy/ is empty`) AND that `legacy/` has 0 files, AND that exit code is 0 (or non-zero if the implementer chose the optional FR-006 signal) — the required minimum is the warning text.
    2. **US2 non-interactive `--yes`:** run `node setup.ts --yes` in a temp workspace with no legacy flags. Assert the same warning appears (FR-007).
    3. **US2 suppression:** run with `--legacy-url <valid-or-dummy>` (or a supplied local path) and assert NO no-legacy-source warning (FR-008).
    4. **US3 local-path interactive:** run `node setup.ts` in a temp workspace, choose the local-path option, supply a temp dir containing sample files. Assert `legacy/` is populated with those files and a "N files copied" count is reported, with no `--legacy-path` flag on the command line (FR-010/FR-011/SC-003).
    5. **US3 invalid path:** choose local-path, supply a non-existent path. Assert a clear error identifying the path (FR-012) and that the US2 warning still fires (the run is not treated as supplied).
    6. **US3 decline both:** at the choice prompt answer blank. Assert the run falls through to the US2 warning, does not loop or crash (spec Edge Case).
    7. **US3 URL unchanged:** choose URL, supply a URL. Assert behavior matches today's clone flow (FR-013 — mutually exclusive; no local copy attempted).
- **Production code (after tests fail):** apply the coordinated US2+US3 technical approach to `setup.ts` `runInstall()` (lines 188–207 interactive prompt; lines 277–287 reuse copy; lines 289–302 add warning). Single edit per SC-004.
- **Why delivered together:** #117 and #118 share `runInstall()` control flow; two independent patches risk one silently invalidating the other's assumptions (Dependency note in spec).

### Phase 3 — Changelog + quality gate
- Add a `CHANGELOGS.MD` `Unreleased` entry (human-readable date heading) covering #116/#117/#118.
- Confirm `DEVELOPMENT.md` maintainer checklist: repo-only source change to `scripts/build-dist.mjs` + `setup.ts`; `migration/` test added; `CHANGELOGS.MD` updated; no `package/` or shipped-agent change.
- Run the full suite: `npm install` then `npm test` (runs `migration` suite + Mission Control UI suite) — MUST pass.

## MVP vs incremental boundaries

- **MVP** = Phase 0 docs + Phase 1 (US1, #116, P1) + Phase 2's US2 portion (#117, P1). Both are P1 silent-failure/onboarding breaks (a build crash and a silent logical skip) and are the approvable core.
- **Incremental** = Phase 2's US3 portion (#118, P2) — the interactive local-path prompt. It is P2 (annoying, not silently broken; operator can work around manually) BUT it MUST ship in the same `runInstall()` edit as US2 (SC-004, spec Dependency). So Phase 2 delivers US2+US3 together even though US3 alone is "incremental" — the shared-code-path constraint overrides the priority split for delivery.
- All three user stories ship in this single feature run; the MVP/incremental distinction governs prioritization and review emphasis, not whether US3 is deferred.

## Out of scope (explicit, per spec)
- Wave 1 content decisions (what the tarball should contain / whether `docs/` should exist) — this feature only tolerates `docs/`'s absence; it does not decide its content.
- Wave 3 (#132), Wave 4 (#133), Wave 5 (#134) — separate specs.
- Any GitHub issue other than #116/#117/#118.
- The non-interactive `--legacy-path`/`--legacy-url` clone/copy machinery itself — assumed correct; only the missing warning (#117) and missing interactive path to it (#118) are added.
- Any change after legacy/ is populated (classification, planning, migration phases).

## Verification
- `cd /home/homelab/workspaces/migration-guild-worktrees/spec-131-wave2 && npm install` (first time).
- `npm test` — MUST pass (migration Node-test suite via `node --import tsx --test test/*.test.ts` + Mission Control UI suite). New tests: `migration/test/build-dist-docs-skip.test.ts` and `migration/test/setup-runinstall-legacy.test.ts`.
- `npm run build:dist` sanity: confirm exit 0 and `dist/migration-guild-kit.tar.gz` produced both with and without a repo-root `docs/`.
- Setup sanity (in a temp workspace OUTSIDE the kit root — never the kit source tree): `node setup.ts` with a blank legacy prompt shows the warning; `node setup.ts` with the local-path option populates `legacy/`; `node setup.ts --yes` (no flags) shows the warning.
- Confirm `git diff` touches only `specs/009-workspace-scaffolding-entry-points/plan.md` (+ existing `spec.json`/docs) and that `scripts/build-dist.mjs` and `setup.ts` are unchanged by this plan phase (plan-only).
