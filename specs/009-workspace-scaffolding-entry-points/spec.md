# Feature Specification: Workspace Build & Scaffolding Entry Points

**Feature Branch**: `009-workspace-scaffolding-entry-points`

**Created**: 2026-08-17

**Status**: Draft

**Input**: User description: "Wave 2 — Fix workspace build/scaffolding entry points (onboarding hardening), GitHub issue #131. Covers exactly three child issues: #116 (`npm run build:dist` fails when repo-root `docs/` is absent because `assembleTarball()` in `scripts/build-dist.mjs` unconditionally `fs.cp`s it), #117 (interactive setup wizard silently no-ops — exits 0 with 0 legacy files copied — when the legacy URL prompt is left blank and no local path was given), and #118 (interactive setup wizard has no prompt/choice to supply a local legacy path, even though the non-interactive `--legacy-path` flag already works). #117 and #118 share `runInstall()` in `setup.ts` and must be fixed together. #116 is independent (different file) but sequenced after Wave 1's workspace-content decision. Out of scope: Wave 1 content decisions, Wave 3 (#132), Wave 4 (#133), Wave 5 (#134), and the already-working non-interactive `--legacy-path`/`--legacy-url` machinery."

## Source-Issue Traceability

| Spec area | Source issue | Repo location observed |
|---|---|---|
| US1, FR-001–FR-004, SC-001 | **#116** | `scripts/build-dist.mjs:143-184` (`assembleTarball()`); unconditional `docs/` copy at `:154`; `.env.example` ENOENT-skip precedent at `:160-167` |
| US2, FR-005–FR-009, SC-002 | **#117** | `setup.ts` `runInstall()`, interactive branch (`setup.ts:188-207`) and legacy-source branching (`setup.ts:262-287`) |
| US3, FR-010–FR-013, SC-003 | **#118** | `setup.ts` `runInstall()`, interactive branch (`setup.ts:188-207`); non-interactive precedent at `setup.ts:177` (parse `--legacy-path`), `:277-287` (copy branch) |

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Dist build succeeds without a repo-root `docs/` directory (Priority: P1)

As a maintainer running `npm run build:dist` in a checkout that has no repo-root `docs/` directory (e.g., a pruned or fresh clone, or a future state where `docs/` is removed by a Wave 1 content decision), I want the tarball build to complete successfully rather than crash with an unhandled `ENOENT`, so that packaging is not coupled to the accidental presence of an optional directory.

**Why this priority**: This is a hard build break — `npm run build:dist` currently cannot succeed at all when `docs/` is missing, blocking every downstream onboarding step (there is no tarball to hand a new user). It is the single highest-leverage, lowest-risk fix in this feature.

**Independent Test**: In a checkout with no repo-root `docs/` directory, run `npm run build:dist`. Confirm the command exits 0, produces `dist/migration-guild-kit.tar.gz`, and the assembled `dist/` staging directory contains no `docs/` entry. Then repeat with `docs/` present and confirm the tarball still includes `docs/` unchanged, to confirm no regression for the common case.

**Acceptance Scenarios**:

1. **Given** a repo checkout with no `docs/` directory at the repo root, **When** `npm run build:dist` is run, **Then** the command completes successfully (exit code 0) and produces `dist/migration-guild-kit.tar.gz`.
2. **Given** a repo checkout with no `docs/` directory at the repo root, **When** the build completes, **Then** the assembled staging directory has no `docs/` entry, and no other assembled content (setup.js, README.md, GETTING-STARTED.md, AGENTS.md, `package/`, `migration/dist/`, `stacks/`) is affected.
3. **Given** a repo checkout that DOES have a repo-root `docs/` directory, **When** `npm run build:dist` is run, **Then** the build completes successfully and the assembled staging directory's `docs/` entry is present and matches the source `docs/` contents (no behavior change for the existing common case).
4. **Given** a repo-root `docs/` path that exists but is not readable/copyable for a reason other than "does not exist" (e.g., a permissions error), **When** `npm run build:dist` is run, **Then** the build still surfaces that error rather than silently swallowing it (only the "absent" case is treated as skip-and-continue).

---

### User Story 2 - Interactive wizard never silently skips the legacy source (Priority: P1)

As a person running the interactive setup wizard (`node setup.js` with no flags) to scaffold a new migration workspace, I want to be clearly warned if I leave the legacy-source prompt blank and haven't otherwise provided a local path, so that I know my workspace has 0 legacy files and I have to act — instead of the wizard quietly printing "Done" and exiting successfully as if nothing were wrong.

**Why this priority**: This is the fail-closed gap Constitution Principle VI exists to close. Today a blank answer produces a workspace that looks fully set up (exit 0, "Done. N file(s) installed.") but is missing the one input — legacy source — the rest of the pipeline depends on. Tied for P1 with User Story 1 because both are silent-failure onboarding breaks; this one is a silent *logical* failure rather than a crash, which makes it more dangerous, not less.

**Independent Test**: Run the interactive wizard, answer the legacy-source question with nothing (blank/skip) at every prompt offered, and let it complete. Confirm the run displays an explicit, unmissable warning that no legacy source was provided and that `legacy/` is empty, distinguishing this state from the normal "N files installed" completion message. Compare against providing a real URL or local path, where no such warning appears.

**Acceptance Scenarios**:

1. **Given** the interactive wizard is running and the operator leaves the legacy-source prompt(s) blank, **When** the wizard reaches completion, **Then** it displays an explicit warning stating that no legacy source was provided and that `legacy/` contains 0 files — distinct from and in addition to the normal completion summary.
2. **Given** the interactive wizard completes with no legacy source provided, **When** the process exits, **Then** the run remains observably distinguishable from a successful legacy-populated run (at minimum via the explicit warning text and next-steps guidance; a non-zero exit code is an acceptable additional signal but the warning is the required minimum).
3. **Given** the interactive wizard is running and the operator provides a non-blank legacy URL, **When** the wizard reaches completion, **Then** no "no legacy source" warning is shown, and existing clone behavior is unchanged.
4. **Given** the interactive wizard is running and the operator provides a local legacy path (User Story 3), **When** the wizard reaches completion, **Then** no "no legacy source" warning is shown, and the copy behavior is unchanged.
5. **Given** a non-interactive run (`--yes` or CLI-flag-driven) with neither `--legacy-url` nor `--legacy-path` supplied, **When** the run completes, **Then** the same explicit no-legacy-source warning is shown (the fail-closed guarantee applies regardless of interactive vs. non-interactive mode).

---

### User Story 3 - Interactive wizard can point at a local legacy directory (Priority: P2)

As a person running the interactive setup wizard who has legacy source code sitting in a local directory (no git URL, or the URL flow is inconvenient — e.g., an internal repo without network access from the setup machine), I want the wizard to ask me whether I have a URL or a local path and let me supply either, so that I am not forced to either fake a URL or fall back to manually copying files after the fact.

**Why this priority**: This closes a real capability gap for interactive users, but it is one notch below User Story 2 because a user who hits this gap today at least gets a clear absence of legacy content they can work around manually (copy files into `legacy/` themselves) — annoying, not silently broken. It depends on the same `runInstall()` branching touched by User Story 2 and is delivered together with it.

**Independent Test**: Run the interactive wizard and, when prompted for legacy source, choose the local-path option and supply a directory containing sample files. Confirm the wizard copies those files into `legacy/` and reports the count, with no need to pass `--legacy-path` on the command line.

**Acceptance Scenarios**:

1. **Given** the interactive wizard is running, **When** it reaches the legacy-source step, **Then** it offers the operator a choice between a repo URL and a local directory path (not only a URL prompt).
2. **Given** the operator chooses the local-path option and enters a valid directory, **When** the wizard proceeds, **Then** it copies that directory's contents into `legacy/` using the same copy behavior already used by the non-interactive `--legacy-path` flag, and reports the number of files copied.
3. **Given** the operator chooses the local-path option and enters a path that does not exist or is not readable, **When** the wizard attempts the copy, **Then** it reports a clear error identifying the invalid path, and the overall completion still surfaces the no-legacy-source warning from User Story 2 (the run does not silently proceed as if a path had been supplied).
4. **Given** the operator chooses the URL option (existing behavior), **When** they supply a URL, **Then** behavior is unchanged from today's clone flow.
5. **Given** the operator is offered the URL-vs-local-path choice, **When** they decline both (blank/skip), **Then** the run falls through to the User Story 2 no-legacy-source warning rather than erroring out or looping indefinitely.

---

### Edge Cases

- What happens when `docs/` exists at the repo root but is an empty directory? It is still "present" — the copy proceeds and produces an empty `docs/` entry in the assembled output; this is not the "absent" case FR-002 covers.
- What happens when the interactive wizard's local-path choice is given a path that is a file, not a directory? The wizard reports a clear error (same handling as a non-existent path) rather than attempting a partial copy.
- What happens when the operator supplies both a URL and, via the new local-path prompt flow, indicates a local path in the same interactive session? The prompt flow presents this as a single either/or choice (mirroring the existing mutually-exclusive `repoUrl`/`legacyPath` branching in `runInstall()`), so only one legacy source is active per run — this spec does not introduce a "merge both sources" behavior.
- What happens if the non-interactive branch is invoked with both `--legacy-url` and `--legacy-path` set? Out of scope — this is existing non-interactive machinery excluded from this feature's fix scope; current precedence behavior is unchanged.
- What happens when the interactive wizard is run in an environment with no TTY (e.g., piped input) and the legacy-source prompt receives an unexpected empty read? This is treated the same as an explicit blank answer — it falls under User Story 2's fail-closed warning, not a crash.

## Requirements *(mandatory)*

### Functional Requirements

**Dist build (#116)**

- **FR-001**: `scripts/build-dist.mjs` MUST check whether the repo-root `docs/` directory exists before attempting to copy it into the assembled staging directory.
- **FR-002**: When repo-root `docs/` does not exist, the build MUST skip copying it and continue assembling the rest of the tarball contents without error.
- **FR-003**: When repo-root `docs/` does exist, the build MUST copy it into the assembled staging directory exactly as it does today (no content or destination-path change).
- **FR-004**: The docs-copy skip logic MUST distinguish "directory does not exist" from other copy failures (e.g., permission errors); only the not-found case is treated as skip-and-continue, consistent with the existing `.env.example` skip pattern already used elsewhere in the same file.

**Fail-closed legacy source (#117)**

- **FR-005**: `runInstall()` MUST detect, at the point the wizard would otherwise report success, whether any legacy source was provided (non-blank URL, or a legacy path resolved via User Story 3 or the existing `--legacy-path` flag).
- **FR-006**: When no legacy source was provided, `runInstall()` MUST emit an explicit, clearly-labeled warning (distinct from the routine "Done. N file(s) installed." summary and distinct from the existing soft "copy your legacy Java source into legacy/" next-step hint) stating that no legacy source was supplied and that `legacy/` is empty. The warning MUST use the following pinned wording so it is testable and unambiguous: a heading line `⚠ WARNING: No legacy source was provided` followed by a line `legacy/ is empty (0 files).`, supplemented by the existing next-steps guidance telling the operator to copy their legacy source into `legacy/`. This warning text is the binding contract for FR-006; implementations and tests MUST match it exactly (no other wording satisfies FR-006).
- **FR-007**: This fail-closed warning MUST fire in both the interactive and non-interactive/CLI-flag-driven paths through `runInstall()` whenever neither a URL nor a path resolves to a legacy source.
- **FR-008**: The fail-closed warning MUST NOT fire when a legacy source was provided and successfully processed (non-blank URL cloned, or a local path copied), regardless of whether that path was supplied via the interactive flow or the `--legacy-path`/`--legacy-url` flags.
- **FR-009**: Existing clone/copy mechanics for a non-blank URL or a valid path (success and failure handling) MUST remain unchanged; this feature adds detection and warning only, not new clone/copy behavior.

**Interactive local-path prompt (#118)**

- **FR-010**: The interactive branch of `runInstall()` MUST offer the operator a choice between supplying a legacy repo URL and supplying a local legacy directory path, rather than prompting for a URL only.
- **FR-011**: When the operator supplies a local directory path interactively, `runInstall()` MUST copy that directory into `legacy/` using the same copy mechanism the non-interactive `--legacy-path` flag already uses, and MUST report the number of files copied.
- **FR-012**: When the operator supplies a local directory path interactively that does not exist or is not readable, `runInstall()` MUST report a clear, specific error identifying the problem path, and MUST NOT treat the run as if a legacy source had been successfully supplied (the FR-006 warning still applies for that run).
- **FR-013**: The interactive URL-or-local-path choice MUST be mutually exclusive per run (choosing/entering one does not require or silently also attempt the other), consistent with the existing `repoUrl`/`legacyPath` branching already present in `runInstall()`.

### Key Entities

- **Legacy Source**: The operator-supplied origin of the code being migrated for a given setup run — either a git repository URL (cloned into `legacy/`, history stripped) or a local directory path (copied into `legacy/`). A run has at most one active legacy source.
- **Dist Staging Directory**: The transient build output (`dist/migration-guild-kit.tar.gz` staging area) assembled by `scripts/build-dist.mjs`, containing setup.js, top-level docs, `package/`, `migration/dist/`, `stacks/`, and (when present) `docs/`.
- **No-Legacy-Source Warning**: The explicit, distinct signal `runInstall()` MUST emit when a run completes with no resolved legacy source, as required by Constitution Principle VI.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: `npm run build:dist` succeeds (exit code 0, tarball produced) in 100% of runs regardless of whether a repo-root `docs/` directory is present, with zero difference in the other assembled tarball contents when `docs/` is present.
- **SC-002**: In 100% of setup-wizard runs (interactive or non-interactive) that end with zero legacy files copied, the run's output contains an explicit no-legacy-source warning distinguishable from a normal completion — zero such runs report only the routine "Done" summary with no warning.
- **SC-003**: An operator running the interactive wizard can populate `legacy/` from a local directory without leaving the interactive flow (no requirement to restart with a CLI flag) in 100% of cases where a valid local directory is supplied.
- **SC-004**: Fixing #117 and #118 requires touching `runInstall()` exactly once as a coordinated change (not two independent, potentially conflicting edits), reflecting their shared-code-path dependency.

## Assumptions

- "Explicit warning" (FR-006) means the pinned two-line block: a heading `⚠ WARNING: No legacy source was provided` followed by `legacy/ is empty (0 files).`, clearly distinguishable from routine status lines (FR-006 wording is now spec-pinned, not a planning-phase decision — plan.md and tasks.md match this exact text, and tests assert it). Exit-code policy: a non-zero exit is an OPTIONAL additional signal; the warning is the required minimum. If a non-zero exit (e.g. `process.exitCode = 1`) is added, it MUST be applied uniformly to both interactive and non-interactive no-legacy runs — a 0 exit remains the approved default and satisfies FR-006 on its own.
- The interactive URL-vs-local-path choice (#118) is assumed to be a simple prompt-level branch (e.g., ask which kind of source, then ask for the value) rather than a new menu system — consistent with the existing single-numbered-choice pattern already used for the framework prompt in `runInstall()`. Exact prompt wording/UX is a planning-phase decision.
- "Repo-root `docs/`" (#116) refers specifically to the top-level `docs/` directory referenced at `scripts/build-dist.mjs:154`, not `package/docs/` or any other docs-like path elsewhere in the repo.
- This feature does not change what `docs/` should contain or whether it should exist by default — that is a Wave 1 content decision explicitly out of scope here; this feature only makes the build tolerant of its absence.
- The non-interactive `--legacy-path`/`--legacy-url` clone/copy mechanics are assumed correct as-is per the input packet; only the missing fail-closed warning (#117) and the missing interactive local-path prompt (#118) are gaps.
- No new configuration file, environment variable, or persistent state is introduced; all behavior changes are confined to the single `npm run build:dist` invocation and the single `runInstall()` execution.

## Dependencies

- **#117 and #118 share `runInstall()` in `setup.ts`** and modify overlapping branching logic (the `repoUrl`/`legacyPath` resolution and the post-copy reporting). Per issue #131, they MUST be implemented and delivered together as one coordinated change — not as two independently-mergeable patches — to avoid one fix's edit silently invalidating the other's assumptions about that function's control flow.
- **#116 is independent** of #117/#118 (different file, `scripts/build-dist.mjs`, no shared code path) but is sequenced after Wave 1's "what a workspace contains" decision, even though this feature does not reopen or depend on the content of that decision — it only needs Wave 1 to have concluded so the build-tooling fix lands on a settled baseline.
- This feature depends on Constitution Principle VI (Fail-Closed Automation) as the governing rule for #117's required behavior, and Constitution Principle V (Tests Before Production Code) for how the eventual implementation phase must sequence its tests.
- No dependency on Wave 3 (#132), Wave 4 (#133), or Wave 5 (#134) — those are separate, unrelated features per the input packet.

## Out of Scope / Exclusions

- Wave 1 content decisions — what should or should not be included in the tarball / what a workspace contains — belong to the Wave 1 tracking issue, not this feature. This feature only makes the existing copy step tolerant of `docs/`'s absence; it does not decide whether `docs/` should exist, be renamed, or be restructured.
- Wave 3 (#132, provider/harness resolution), Wave 4 (#133, pipeline execution correctness), and Wave 5 (#134, doc-only polish) are separate features with separate specs and are not addressed here.
- Any GitHub issue other than #116, #117, and #118 (including #119–#129) is explicitly excluded from this feature.
- The non-interactive `--legacy-path` / `--legacy-url` clone and copy machinery itself is NOT broken and is excluded from fix scope — this feature only adds (a) the missing fail-closed warning around it (#117) and (b) an interactive path to reach the existing `--legacy-path` copy behavior (#118).
- Any change to what happens after a legacy source is successfully provided (classification, planning, migration phases) is out of scope — this feature ends at "legacy/ is correctly populated or the operator is clearly warned that it isn't."
