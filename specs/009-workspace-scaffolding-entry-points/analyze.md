# Analysis: Spec 009 — Workspace Build & Scaffolding Entry Points

## Summary

Cross-check of the spec / plan / tasks triad for Feature 009 (Wave 2, GitHub issue #131)
covering child issues #116 (`docs/` skip in `scripts/build-dist.mjs` `assembleTarball()`),
#117 (fail-closed no-legacy-source warning in `setup.ts` `runInstall()`), and #118
(interactive URL-or-local-path choice in the same `runInstall()`). All claims below are
verified against the ACTUAL source at the referenced lines; no application source was
modified (analyze-only phase).

**Verdict: YES-WITH-NITS** — the triad is coherent and implementable. One Blocker-class
doc inconsistency must be closed before the MVP checkpoint (analyzed below, not fixed),
plus several Minor traceability/terminology nits. No scope creep beyond #116/#117/#118 was
found; constitution alignment (Principle V tests-first, Principle VI fail-closed) is
correctly reflected in task ordering and in the planned warning behavior.

## Findings

### Blockers

| # | Where | What's wrong | Recommended fix (analyze-only) |
|---|-------|--------------|--------------------------------|
| B1 | spec.md:15 (and :16-:17 by reference) | **Traceability line numbers are wrong / will mislead the implementer.** The spec maps US1/FR-001–004 to `scripts/build-dist.mjs:143-155 (assembleTarball())`. Actual source: `assembleTarball()` is lines **143–184**; the unconditional `fs.cp` of `docs/` is at **line 154** (inside a `Promise.all` 149–155), and the `.env.example` ENOENT-skip precedent is at **lines 160–167** — all outside the spec's stated `143-155` range. The cited `143-155` range literally stops before the skip precedent the spec depends on (FR-004). | Correct the traceability table in spec.md to `scripts/build-dist.mjs:143-184`, `docs` copy at `:154`, `.env.example` precedent at `:160-167`. (This is a spec.md edit — out of scope for analyze to apply, but it MUST be fixed before implementation so the implementer reads the right region.) |

### Major

| # | Where | What's wrong | Recommended fix (analyze-only) |
|---|-------|--------------|--------------------------------|
| M1 | spec.md:125 (Assumptions) vs plan.md:80 vs tasks.md:34 | **Warning-string wording is now pinned enough to test — good — but the spec's Assumptions still call it "a planning-phase decision," creating a spec↔plan contradiction.** Plan (line 80) and T027 (tasks.md:34) hard-pin the string `⚠ WARNING: No legacy source was provided` + `legacy/ is empty (0 files).`; the spec's Assertion Target for FR-006 (spec.md:96) requires only "explicit, clearly-labeled warning" but the Assumptions (spec.md:125) explicitly *defer* wording to planning. Result: the test asserts a specific string that the spec does not itself commit to. | Either (a) add the pinned strings to spec.md FR-006/Assumptions so spec and plan agree, or (b) note in plan that the pinned string is the binding contract for the test. The Test (T020/T027) already pins it, so the implemented behavior will match the test, not the spec's looser wording — close the gap so spec is the source of truth. |
| M2 | plan.md:43 vs setup.ts:180-187 (actual `--yes` path) | **Plan under-states what `--yes` does, risking an untested-but-claimed guarantee.** Plan line 43 says `--yes` "sets `repoUrl = ""`, `legacyPath = cliPath` and NEVER calls the legacy branch." Actual source: `nonInteractive` is true for `--yes` (line 178); in that branch `legacyPath = cliPath` (line 183) — but `cliPath = flag("--legacy-path")` is `undefined` unless the operator also passed `--legacy-path`. So a bare `node setup.js --yes` leaves BOTH `repoUrl` and `legacyPath` empty, and `hasLegacy` (line 290) is falsy → the planned warning (T021/T029) fires. The plan's "fire in both interactive and non-interactive paths" (FR-007) holds, but the plan's own description ("`legacyPath = cliPath`") is ambiguous about the bare `--yes` case. | Clarify in plan.md that bare `--yes` (no `--legacy-path`) yields `legacyPath === undefined`, which is exactly the no-legacy case the warning must cover. No code change; wording only. FR-007 coverage (T021) is already correct. |

### Minor

| # | Where | What's wrong | Recommended fix (analyze-only) |
|---|-------|--------------|--------------------------------|
| N1 | spec.md:16 (US2 traceability) | Cites `setup.ts:188-206` (interactive branch) and `setup.ts:262-287` (legacy branching). Actual: interactive branch is **188–207** (prompt at :205, `rl.close()` at :206, block closes :207); legacy branching is **262–287** (URL clone :262-:276, `else if (legacyPath)` copy :277-:287). Off-by-one on the interactive block. Cosmetic but should match B1's correction. | Fix the line spans to `:188-207` / `:262-287` when correcting B1. |
| N2 | spec.md:17 (US3 traceability) | Cites non-interactive precedent `setup.ts:46,177,277-285`. Actual: `--legacy-path` flag parsed at **:177** (`flag("--legacy-path")`), used at **:183**, copy branch at **:277-287** (not `:277-285` — the `catch`/`console.error` is :284-:285, the block ends :287). Line `:46` is a comment in the CLI-flag banner, not the parse. | Align spans with B1/M1 corrections; cite `:177` (parse) and `:277-287` (copy branch). |
| N3 | spec.md:128 vs actual `docs/` semantics | Spec Assumptions say repo-root `docs/` is "the top-level `docs/` directory referenced at `scripts/build-dist.mjs:154`." Confirmed correct (`repoRoot = path.resolve(__dirname, "..")`, line 12; `path.join(repoRoot, "docs")` line 154). Minor note only: the worktree itself has a repo-root `docs/` (this checkout ships `docs/`), so the "absent" test (T010/T012) MUST be run in a temp kit-root mirror that omits `docs/` — the plan (Phase 1) already does this correctly. OK, no fix needed; flagged so the implementer doesn't assume the repo-root `docs/` can simply be deleted. | No fix; ensure T010/T012 build a temp mirror without `docs/` (already specified). |
| N4 | tasks.md:46 vs plan.md:112 | **MVP/US3 priority drift between plan and tasks.** Plan.md:112/Phase 2 labels US2+US3 both P1+P2 and says US2=P1, US3=P2; tasks.md:46 MVP boundary lists US2 portion as "P1" and is consistent. But tasks.md:34/T027 is tagged `[P1][US2]` while tasks.md:35/T028 is `[P2][US3]` — consistent. Minor: plan.md:112 header reads "(P1 + P2, MVP includes US2; US3 delivered here per SC-004)" — slightly ambiguous whether US3 is "MVP." tasks.md:46/47 resolves it (US3 = incremental, shipped together). OK; optionally tighten plan.md:112 wording. | Optional: reword plan.md:112 to "US2 (#117, P1) is the MVP core; US3 (#118, P2) is incremental but must land in the same `runInstall()` edit (SC-004)." |
| N5 | spec.md:97 (FR-007) vs setup.ts:289-302 | FR-007 requires the warning "in both the interactive and non-interactive/CLI-flag-driven paths." The planned warning is computed at completion (after line 289 `Done.`) from `legacyResolved = Boolean(repoUrl) || Boolean(legacyPath)` — which is evaluated after the URL-clone / local-copy branches have run. This correctly fires for `--yes`, `--legacy-url`, `--legacy-path`, and interactive blank. OK — verified, no fix. (Listed to document the FR-007 coverage is actually satisfied by the plan's completion-point computation, not a separate branch.) | No fix. |
| N6 | plan.md:100 vs tasks.md:5 / T001 | Test framework is correctly identified as Node built-in runner (`node --import tsx --test test/*.test.ts`, migration/package.json:13) and explicitly NOT vitest. The spec's earlier "vitest" mention (spec.md does not actually name vitest in the body — only plan.md:93 disclaims it) is handled. OK. Confirmed: no vitest dependency exists in migration/package.json. | No fix; the disclaimer in plan.md:93 and tasks.md:5 is sufficient. |

### OK (verified healthy)

- **Scope discipline:** spec.md:139-145 Out-of-Scope matches plan.md:136-141 and tasks scope (line 5). No Wave 1/3/4/5 (#132-#134) or #119-#129 creep. OK.
- **Principle V (tests-first) reflected in task order:** every US1/US2/US3 production task (T014, T027, T028) is preceded by its test task(s) (T010-T013, T020-T026) in the same phase. OK.
- **Principle VI (fail-closed) enforced, not just described:** plan pins a distinct `⚠ WARNING: ...` block that supplements (does not replace) the existing soft hint, and fires on every no-legacy path including blank `--yes`. The kit-root guard (setup.ts:308-314) is correctly referenced as the reason tests must run in temp workspaces outside the kit root. OK.
- **SC-004 (one coordinated `runInstall()` edit):** plan.md:64-65 and tasks.md:25/34-35 make US2+US3 a single coordinated edit (T027+T028). OK.
- **FR-004 precedent grounding:** `.env.example` ENOENT-skip at build-dist.mjs:160-167 is the exact pattern; plan option (b) mirrors it; option (a) `existsSync` guard is simpler. Both satisfy "distinguish not-found from other failures." OK.
- **Repo source-of-truth boundary:** plan.md:6/25 and tasks.md:5 honor `.github/agent-instructions.md` + constitution §Repository Source-of-Truth Boundaries — tests exercise `build-dist.mjs`/`setup.ts` in temp dirs, never against the kit source tree. OK.

## Traceability matrix (FR → task)

| Requirement | Covered by task(s) | Test task | Notes |
|---|---|---|---|
| FR-001 (#116 docs exists-check) | T014 | T010,T011 | OK |
| FR-002 (#116 skip-and-continue) | T014 | T010,T011 | OK |
| FR-003 (#116 unchanged copy when present) | T014 | T012 | OK (regression) |
| FR-004 (#116 ENOENT-only skip) | T014 | T013 | OK (mirrors :160-167) |
| FR-005 (#117 detect no-legacy) | T027 | T020,T021 | OK |
| FR-006 (#117 distinct warning) | T027 | T020 | String pinned in plan/T027 (see M1) |
| FR-007 (#117 fire both modes) | T027 | T021 (--yes), T022 (suppression) | OK |
| FR-008 (#117 don't fire when supplied) | T027 | T022 | OK |
| FR-009 (#117 mechanics unchanged) | T027 | T022,T023 | OK |
| FR-010 (#118 choice prompt) | T028 | T023 | OK |
| FR-011 (#118 copy reuse) | T028 | T023 | reuses :277-287 |
| FR-012 (#118 invalid path) | T028 | T024 | OK |
| FR-013 (#118 mutually exclusive) | T028 | T025 (decline), T026 (URL) | OK |
| SC-001 (#116 100% build) | T014,T015 | T010-T013 | OK |
| SC-002 (#117 warning 100%) | T027,T029 | T020,T021 | OK |
| SC-003 (#118 local without flag) | T028 | T023 | OK |
| SC-004 (#117+#118 one edit) | T027+T028 | — | OK (coordinated) |

Every FR/SC has ≥1 task and ≥1 test task. No traceability gaps.

## Ready for implementation?

**Verdict: YES-WITH-NITS.**

Gating conditions (must close before MVP checkpoint):
1. **B1 (Blocker):** fix the spec.md:15 traceability line numbers (`assembleTarball()` = 143-184; `docs` copy = :154; `.env.example` precedent = :160-167) so the implementer reads the correct region. This is a spec.md edit and is the only hard gate.
2. **M1 (Major):** reconcile spec.md FR-006/Assumptions wording with the pinned warning string already in plan.md:80 / tasks.md:34, so the spec is the source of truth for what the test asserts.

Non-gating (can land during implementation): M2 wording clarification, N1-N4 line-span/priority nits.

## Remaining spec gaps to close before MVP checkpoint

1. **Pinned warning string in the spec (M1).** Move `⚠ WARNING: No legacy source was provided` + `legacy/ is empty (0 files).` from plan/tasks into spec.md FR-006 so the assertion target is spec-authored, not plan-authored.
2. **Exit-code policy (FR-006 / Acceptance Scenario 2).** Spec leaves non-zero exit optional; plan defaults to 0 and allows the implementer to optionally set `process.exitCode = 1` "uniformly." This is acceptable per spec, but the spec should explicitly record that a 0 exit is the *approved minimum* and that if a non-zero exit is added it MUST be uniform across interactive+non-interactive — otherwise a later implementer may diverge. (Currently only the plan notes uniformity; promote to spec Assumptions.)
3. **Bare `--yes` no-flag behavior (M2).** Capture explicitly in spec US2 Acceptance Scenario 5 / FR-007 that a bare `node setup.js --yes` (no `--legacy-url`/`--legacy-path`) is the canonical non-interactive no-legacy case and MUST emit the warning. The test (T021) covers it; the spec should state it.
4. **Line-number spans (B1/N1/N2).** Correct all traceability line citations in spec.md against the verified source before any `/speckit-implement` run.
