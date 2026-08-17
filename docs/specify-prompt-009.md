# /speckit-specify Input Packet — Feature 009 (Wave 2: Fix workspace build/scaffolding entry points)

## Tracking issue

GitHub issue **#131** — "Wave 2 — Fix workspace build/scaffolding entry points (onboarding hardening)"
- Author: iserifith (Seri), OWNER
- State: OPEN
- Comment on issue: `/hermes-specify` (slash command invoked 2026-08-17)
- Depends on: Wave 1 tracking issue (the "what does a workspace contain" decision). This feature does NOT reopen Wave 1 scope; it fixes the *entry points* that produce a workspace, sequenced after Wave 1's content decision.

## Locked scope (INCLUDED)

Exactly one feature directory `specs/009-*` covering these three child issues, all onboarding-hardening entry-point fixes:

- **#116** — `npm run build:dist` fails: `assembleTarball()` in `scripts/build-dist.mjs` (line 154) calls
  `fs.cp(path.join(repoRoot, "docs"), ...)` unconditionally. When the repo-root `docs/` directory does
  not exist, the step throws `ENOENT` and the whole dist build aborts. Fix: make the docs copy
  conditional / skip-if-absent, mirroring the existing `.env.example` skip pattern already used at
  `scripts/build-dist.mjs:160-167` (try/catch ENOENT). No other tarball-content decisions are in scope
  (those belong to Wave 1).
- **#117** — Interactive setup wizard silently no-ops on a blank legacy URL. In `setup.ts` `runInstall()`,
  when `repoUrl` is blank and `legacyPath` is undefined, the wizard proceeds, writes only the scaffolding
  (agents/skills/etc.) to the workspace, copies 0 legacy files, and exits 0 — a silent failure. Per
  Constitution Principle VI (Fail-Closed Automation), the wizard MUST surface a clear warning (and/or
  non-zero-exit guidance) when no legacy source was provided but the run expected one, instead of exiting
  0 with 0 legacy files. Out of scope: the actual clone/copy mechanics (already work for non-blank URL).
- **#118** — Interactive setup wizard has no way to point at a local legacy path. `runInstall()` already
  accepts a `--legacy-path <dir>` CLI flag (setup.ts:46, 177, 277-285) and the non-interactive branch
  honors it, but the interactive `readline` prompt (setup.ts:162-164) only asks for a "Legacy repo URL
  (leave blank to skip)" and offers no option to supply a local directory. Fix: add an interactive
  local-path prompt/choice so a human at the wizard can point at a local legacy dir. This shares the
  `runInstall()` code path with #117 and MUST be fixed together with #117 (per issue #131 note).

## Deliberate EXCLUSIONS (do NOT include)

- Wave 1 content decisions (what should go *in* the tarball / what a workspace contains) — belongs to the
  Wave 1 tracking issue, not this feature.
- Wave 3 (#132, provider/harness resolution), Wave 4 (#133, pipeline execution correctness), Wave 5 (#134,
  doc-only polish) — separate features, separate specs.
- All other open issues (#116/#117/#118 are the only included ones). #119-#129 are unrelated.
- The non-interactive `--legacy-path`/`--legacy-url` machinery itself is NOT broken and is excluded from
  "fix" scope — only the interactive gap (#118) and the blank-URL silent no-op (#117) are in scope.

## Non-duplicates / settled decisions (must NOT be reopened during specify)

- #117 and #118 both touch `runInstall()` in `setup.ts` and are intentionally consolidated into this single
  feature (one coherent user-visible contract: "the wizard produces a usable workspace from either a URL or
  a local path, and never silently skips the legacy source"). They are NOT two features.
- The fail-closed doctrine is settled by Constitution Principle VI; do not relitigate whether silent no-ops
  are acceptable.

## Hard constraints for the /speckit-specify run

- Produce EXACTLY ONE feature directory: `specs/009-<slug>/` with the standard `spec.md`,
  `checklist.md`, and `.specify/feature.json` (or whatever `specify` scaffolds for a new spec).
- Prohibit application-source edits, builds, deployment, and extra specs during specify. This is a
  specify-only phase. Do NOT run plan, tasks, analyze, or implement.
- Requirement IDs must be unique. User stories / acceptance scenarios / success criteria / assumptions /
  dependencies / out-of-scope boundaries must all be present.
- Include source-issue traceability (#116, #117, #118) and explicit exclusions.
- The spec MUST reflect the ACTUAL current code state observed in this worktree:
  - `scripts/build-dist.mjs` line 154: unconditional `fs.cp(repoRoot/docs → buildDir/docs)`.
  - `setup.ts` `runInstall()`: interactive branch prompts only for URL (line 162), blank URL → 0 legacy
    files written, exit 0; non-interactive branch already honors `--legacy-path` (lines 46/177/277).
- Name the feature slug to reflect "workspace build/scaffolding entry points" (e.g.
  `009-workspace-scaffolding-entry-points`).

## Repository grounding (agent-instructions.md)

This repo is the source of the Migration Guild KIT, not a migration workspace. The fixes here are to the
kit's own onboarding entry points (`scripts/build-dist.mjs`, `setup.ts`) — shipped via `dist/` tarball and
`node setup.js`. Constitution principles I (Evidence Over Assertion), V (Tests Before Production Code), and
VI (Fail-Closed Automation) govern.
