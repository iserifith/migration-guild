# Analysis: Spec 012 — Onboarding Wave 6 — Kit Build/Packaging Integrity and First-Run Guidance

## Summary

Cross-checked `spec.md`, `plan.md`, and `tasks.md` against each other and against the actual
source on this branch (`scripts/build-dist.mjs`, `migration/guildctl/config.ts`,
`migration/guildctl/harness.ts`, `migration/guildctl/doctor.ts`, `migration/guildctl/preflight.ts`,
`migration/test/*.test.ts`, `setup.ts`, `package/setup.js`, `package/agent-shim.mjs`,
`package/harness/opencode.mjs`, `.env.example` ×2, `README.md`, `GETTING-STARTED.md`,
`DEVELOPMENT.md`, `CHANGELOGS.MD`, `package.json` ×2, `.specify/memory/constitution.md`) as it
exists on `spec/issue-148` today (2026-08-19).

Unlike Spec 011's analysis, `plan.md`'s and `tasks.md`'s line-number citations for this feature
are almost uniformly exact — every citation spot-checked (assembleTarball's four copy jobs at
lines 188–191, main()'s Step 1/Step 3 at lines 215–227, `checkHarness` at 190–204, DEFAULT_GUILD_CONFIG
at 46–87, harness-selection.test.ts:32, doctor-pipeline-state.test.ts:319/282, setup.ts's
`--legacy-path` flag at 46/177/290–313, package/agent-shim.mjs's DashScope literals, README.md's
DashScope mentions at 16/28/54 and its bare-command pipeline table at 75–79) matched the real
source exactly. `tasks.md`'s own re-verification pass already caught and corrected the one
material citation drift in `plan.md`/`spec.md` (the FR-007 test-file surface). The two carried-over
constitution-compliance gaps (no `CHANGELOGS.MD` task, no root/UI-suite verify task) are confirmed
real and are the most actionable findings in this pass. `spec.md`'s FR-006/FR-007 wording issues
from the previous session are also both confirmed real and still uncorrected in `spec.md` itself
(though already worked around correctly in `plan.md`/`tasks.md`). No new BLOCKER-class defect was
found; this feature's plan/tasks are implementation-ready.

## Findings

| ID | Category | Severity | Location(s) | Summary | Recommendation |
|---|---|---|---|---|---|
| CN1 | Constitution (Dev Workflow) | MEDIUM | `tasks.md` (no task); `.specify/memory/constitution.md` "Notable changes MUST be added to `CHANGELOGS.MD`..." + "Practical maintainer checklist" item 5 (`DEVELOPMENT.md:327`) | `CHANGELOGS.MD` exists, is actively maintained (latest entry "August 16, 2026"), and both the constitution and `DEVELOPMENT.md`'s maintainer checklist require notable changes to get an `Unreleased` entry. This feature changes five categories of shipped behavior (packaging contents, build self-sufficiency, the seeded default provider every fresh `guildctl init` gets, doctor diagnostic wording, and five doc/dead-file fixes) — squarely "notable" — yet no task in `tasks.md` (T001–T037) instructs adding a `CHANGELOGS.MD` entry. | Add a task (e.g. in Phase 8/Polish, after all five stories land) to append one `Unreleased` entry dated 2026-08-19 summarizing the five fixes, following the existing entries' style (feature/issue number, FR references, one-paragraph technical summary). |
| CN2 | Constitution (Dev Workflow) | MEDIUM | `tasks.md` T001/T004/T008/T020/T024/T034/T035 (all scope `npm test` to `migration/` only); constitution "`npm test` MUST pass before a change is considered complete. It runs the `migration` suite and the Mission Control UI suite." | Root `package.json`'s `test` script (`npm --prefix migration test && npm --prefix migration/ui test`) already cascades into both suites — confirming the constitution's requirement is achievable today with zero new wiring — but every verify task in `tasks.md`, including the final full-suite task T035 ("Run the full `migration/` regression suite"), explicitly scopes to `migration/`'s `node:test` suite only. `migration/ui` has 8 real `*.test.tsx`/`*.test.ts` files (vitest) that no task in this feature ever runs, even though FR-014 excludes UI code from *changes*, not from the completion gate. T036 (Polish) runs `npm run build:dist`, which invokes `npm run build:ui` (a Vite **build**, not the vitest **test** suite) — that is not equivalent. | Change T035 (or add a new Polish task) to run root `npm test` (not `npm test` from inside `migration/`), so the Mission Control UI suite's green status is confirmed as part of this feature's completion, satisfying the constitution's Development Workflow gate literally. |
| I1 | Spec/Plan/Tasks consistency | LOW | `spec.md` FR-007 ("11 test files (~103 matches)"); `plan.md` Summary + "Scale/Scope" (corrects to "13 files / 160 lines"); `tasks.md` "Source of truth for line numbers" note + T019 (corrects to 14 files, citing `workspace-isolation-defaults.test.ts:109`) | Re-derived independently via `grep -lE 'DEFAULT_GUILD_CONFIG\|example-private\|EXAMPLE_PRIVATE\|pvt/\|dashscope' migration/test/*.test.ts` (case-sensitive, matching spec.md's literal pattern): **13 files, 160 matches** — confirming `plan.md`'s correction, not `spec.md`'s original "11/~103." Re-running case-insensitively (`grep -li`) surfaces **15 files, 164 matches** — the case-sensitive pattern's `dashscope` term never matches `DASHSCOPE_API_KEY` (all-caps), which is exactly why `workspace-isolation-defaults.test.ts:109` (`DASHSCOPE_API_KEY: "dummy"`) and — newly confirmed in this pass — `doctor-pipeline-state.test.ts:282` (`DASHSCOPE_API_KEY: "dummy"`) fall outside the literal grep despite both being correctly itemized elsewhere in `spec.md`'s FR-007 prose and `tasks.md`'s T018. Cross-checked against `tasks.md`'s actual per-file task list (T011–T019 update, T020 verifies six structural/incidental files unchanged) — it covers all 15 files exactly, so **the task list itself has the complete, correct surface**; only `spec.md`'s FR-007 sentence is stale. | Update `spec.md` FR-007's citation from "11 test files (~103 matches)" to match `tasks.md`'s now-authoritative 15-file surface (or simply reference "`tasks.md`'s per-file breakdown" instead of a hardcoded count, to avoid a third stale-count drift when the tree next changes). Non-blocking — `tasks.md` is what an implementer executes and is already correct. |
| U1 | Spec wording precision | LOW | `spec.md` FR-006 ("The seeded `provider.routes` and the seeded `agents.*.model` references MUST drop example-private-namespace `pvt/*` identifiers"); `migration/guildctl/config.ts:66-70` (`agents` block: `deepseek-v4-pro`, `deepseek-v4-flash`, `glm-5.1` — no `pvt/` prefix on any of the three) | Verified against current source: `provider.routes` (config.ts:60-64) does carry `pvt/*` identifiers (`pvt/hy3-tencent`, `pvt/deepseek-v4-pro`, `pvt/grok-4.5`, etc.) and FR-006's "drop `pvt/*`" instruction is literally correct there. But `agents.default/cheap/reviewer` (config.ts:67-69) use bare model names with no `pvt/` or `example-private` namespace prefix at all — FR-006's single clause conflates two different fix shapes (strip a prefix vs. replace a non-OpenAI-compatible bare id) under one instruction that's imprecise for the `agents` half. `plan.md`'s Technical Approach for US3 (lines 163-164) already catches and correctly resolves this ambiguity in prose ("these do **not** carry the `example-private` namespace today, so FR-006's... clause has no literal match here; what they do need... is replacement with OpenAI-compatible model identifiers"), and `tasks.md` T010 correctly implements the substantive fix (replace, not strip-a-prefix) — so implementation is not at risk. Only `spec.md`'s FR-006 sentence itself remains imprecise. | Reword `spec.md` FR-006 to split the two clauses: "`provider.routes` MUST drop example-private-namespace `pvt/*` identifiers... `agents.*.model` MUST be replaced with OpenAI-compatible model identifiers (they do not currently carry the `pvt/`/example-private namespace, but their current bare ids — e.g. `deepseek-v4-pro`, `glm-5.1` — are not OpenAI Chat Completions model ids)." Non-blocking — `plan.md`/`tasks.md` already implement the correct fix. |
| N1 | Spec precision (minor) | LOW | `spec.md` Edge Cases ("It is ~63 KB of text"); actual `migration/package-lock.json` = 73,030 bytes (~71 KB) | The spec's tarball-size-impact estimate for `package-lock.json` is off by roughly 8 KB (~13% low). This has zero effect on any requirement, task, or acceptance criterion — the point being made ("negligible against the dist trees it ships beside") holds regardless. Included only because it was checked. | No fix required; optional cosmetic correction ("~63 KB" → "~71 KB") if `spec.md` is touched for I1/U1 anyway. |

## Requirement Coverage

| Requirement | Task(s) | Notes |
|---|---|---|
| FR-001..FR-003 (US1, packaging) | T002–T004 | Covered; tests-first; citations (assembleTarball lines 188–191) verified exact against source |
| FR-004..FR-005 (US2, self-sufficient build) | T005–T008 | Covered; tests-first; citations (main() Step 1/Step 3 at lines 215–227) verified exact |
| FR-006..FR-007 (US3, provider default) | T009–T020 | Covered; tests-first; see I1 (spec.md's own FR-007 file-count citation is stale, but tasks.md's file surface is complete and correct) and U1 (FR-006 wording imprecise for `agents.*.model`, already correctly resolved in plan.md/tasks.md) |
| FR-008..FR-009 (US4, harness diagnostics) | T021–T024 | Covered; tests-first; citations (checkHarness lines 190–204, harness-selection.test.ts:32, doctor-pipeline-state.test.ts:319) verified exact; spawn-error-vs-non-zero-exit branch mapping for the two existing wording assertions independently confirmed correct (both fixtures use `source: "environment"` pointing at a nonexistent path, which hits the spawn-error branch, not the missing-adapter early-return which is gated on `source === "config"`) |
| FR-010 (US5, stale `.env.example` comment) | T025, T026 | Covered; stale comment verified present at `.env.example:5`/`package/.env.example:5` (byte-identical, confirmed via `diff`) |
| FR-011 (US5, `--legacy-path` doc gap) | T025, T028 | Covered; `--legacy-path` verified as a real, wired flag (`setup.ts:46,177,290-313`, exercised by `migration/test/setup-runinstall-legacy.test.ts`) absent from `GETTING-STARTED.md`'s Setup block (verified: only `--legacy-url` appears) |
| FR-012 (US5, pipeline command-form inconsistency) | T025, T027 | Covered; verified: `README.md:75-79` uses bare `guildctl inventory`/`plan`/etc., `GETTING-STARTED.md:105-117` uses `guildctl run <phase>` — real inconsistency |
| FR-013 (US5, piped-stdin EOF) | T025, T032 (MVP), T033 (incremental, optional) | Covered; MVP/incremental split matches spec.md's explicit instruction; `setup.ts:189-219`'s `readline` loop verified to have no EOF handler |
| FR-014 (scope fence) | All tasks | Verified: no task touches registry/claims/evidence-gate/arbitration/audit-rule/UI code; file set in tasks.md's Notes section matches the actual files this analysis touched |
| FR-015 (DashScope removal) | T025–T031 | Covered; all cited DashScope literals verified present at exact cited locations: `.env.example:3-6`, `README.md:16,28,54`, `package/agent-shim.mjs:3,13,65,67,96,98`, `package/harness/opencode.mjs:11` (comment only — `writeProviderConfig` lines 64-66 already OpenAI-compatible by default, confirmed) |
| FR-016 (package/ as source of truth) | T026, T029–T031 | Covered; `guildctl.config.json` (root) and `package/guildctl.config.json` verified byte-identical via `diff`; `benchmark.ts:92`'s copy-list array verified to contain the exact cited `"guildctl.config.json"` entry, guarded by `fs.existsSync` |
| SC-001 | T004, T036 | Covered |
| SC-002 | T008 | Covered |
| SC-003 | T009, T020, T037 | Covered |
| SC-004 | T021–T024 | Covered |
| SC-005 | T025, T034, T037 | Covered |
| Constitution Principle V (tests-first) | All test tasks precede paired impl tasks | Satisfied throughout |
| Constitution Dev-Workflow gate ("`npm test`... runs migration suite and Mission Control UI suite") | — | **Not covered** — see CN2 |
| Constitution Dev-Workflow gate (`CHANGELOGS.MD` entry for notable changes) | — | **Not covered** — see CN1 |

## Metrics

- Findings: 2 MEDIUM (CN1, CN2), 3 LOW (I1, U1, N1); 0 CRITICAL.
- Requirements: 16 FRs, 5 SCs — all have at least one mapped task except the two constitution
  Dev-Workflow gates (CHANGELOGS.MD entry, root/UI-suite test run), which map to no task.
- Tasks: 37 numbered tasks (T001–T037) across 8 phases; citation spot-check sample size 20+
  line/file references, 100% matched actual source exactly (no drift found, in contrast to
  Spec 011's analysis where multiple citations were off).
- FR-007 test-file surface: independently re-derived at 15 files / 164 case-insensitive matches;
  `tasks.md`'s T011–T020 breakdown already covers all 15 correctly; `spec.md`'s own FR-007 text
  ("11 files / ~103 matches") remains stale (I1).
- Repeat findings from prior session: CN1 confirmed, CN2 confirmed, I1 confirmed (spec.md still
  uncorrected; plan.md/tasks.md already self-corrected), U1 confirmed (spec.md still imprecise;
  plan.md/tasks.md already implement the correct fix). No repeat finding was refuted.
- New findings this pass: N1 (minor tarball-size estimate drift, non-blocking).

## Next Actions

1. **Fix CN1 and CN2 before or during `/speckit-implement`** — both are cheap, additive task-list
   edits (no spec/plan changes needed): add one Polish-phase task to append a `CHANGELOGS.MD`
   `Unreleased` entry, and change T035 (or add a sibling task) to run root `npm test` instead of
   `migration/`-scoped `npm test`, so the Mission Control UI suite's continued-green status is
   actually verified as part of this feature's completion.
2. **I1 and U1 are non-blocking** — `plan.md` and `tasks.md` already carry the correct, corrected
   information and are what `/speckit-implement` will actually execute; fixing `spec.md`'s FR-006/
   FR-007 wording is a documentation-accuracy cleanup that can happen anytime (independently, or
   folded into US5's doc-consistency pass) without affecting implementation correctness.
3. **N1 requires no action** — noted for completeness only.
4. No BLOCKER-class finding exists in this pass. This feature's plan and tasks are
   implementation-ready as-is; CN1/CN2 are the only items worth resolving before declaring the
   feature's Definition of Done met, since both trace directly to explicit constitution text
   (`npm test` scope, `CHANGELOGS.MD` requirement) rather than to a judgment call.
