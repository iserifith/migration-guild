# Analysis: Spec 011 — Fix Pipeline Execution Correctness (Onboarding Hardening, Wave 4)

## Summary

Cross-checked `spec.md`, `plan.md`, and `tasks.md` against each other and against the actual
source on this branch (`migration/guildctl/cli.ts`, `migration/guildctl/commands/inventory.ts`,
`migration/registry/commands/serve.ts`, `migration/registry/commands/artifacts.ts`,
`migration/guildctl/commands/release.ts`, `migration/tsup.config.ts`, `scripts/build-dist.mjs`,
`GETTING-STARTED.md`, `setup.ts`, and `.specify/memory/constitution.md`). US1 (#122) and US3
(#124)'s code-location citations are accurate and the fix designs are sound. **US2 (#123)'s
entire root-cause narrative was verified live and does not hold against the actual documented
build pipeline** — this is the headline finding (B1) and should be resolved before
`/speckit-implement` touches US2. One citation is out-of-bounds (plan.md cites `cli.ts:670–738`
in a 723-line file). The constitution citations for Principle VI in `spec.md`'s Governing
Document section do not match the constitution's actual text. No scope creep beyond #122/#123/#124
was found; US1/US2/US3 do not technically contradict each other (disjoint files), though there is
one internal US2 acceptance-vs-task contradiction (AS4/SC-002 vs. T008 being "optional").

## Findings

### B1 — BLOCKER: US2/#123's root-cause narrative is falsified by a live test against the actual `build:dist` pipeline; SC-002's literal acceptance command is unreachable regardless of the UI_DIR fix

**Artifacts**: `spec.md` "Source context" (serve.ts bullet), US2 section, FR-005/006/007, SC-002,
Acceptance Scenario 4; `plan.md` US2 summary + "Change A"/"Change B"; `tasks.md` T005/T006/T007/T008.

`spec.md` states as established fact: *"the compiled CLI is emitted to
`migration/dist/registry/commands/serve.js`, so `__dirname` = `migration/dist/registry/commands`
and `__dirname/../..` = `migration/dist/`, making `UI_DIR = migration/dist/ui-dist` — a directory
that never exists... `serve` 404s until `ui-dist` is manually copied to `migration/dist/ui-dist`."*
`plan.md` repeats this verbatim as the fix's justification, and `tasks.md` T005(a)/(d)/(e) are
written to fail against exactly this premise.

**This does not describe the actual, documented build.** Verified directly:

1. `migration/tsup.config.ts` (the tool `scripts/build-dist.mjs` Step 1 actually invokes, line
   208–209: `"▶ Step 1/3 — Build migration (tsup)"` / `await run("npx", ["tsup"], { cwd:
   path.join(repoRoot, "migration") })`) defines `outDir: "registry/dist"` for the registry entry
   and `outDir: "guildctl/dist"` for guildctl — **not** `migration/dist`. tsup also bundles each
   entry (`cli: "registry/cli.ts"`) into a **single file**; there is no `commands/` subdirectory in
   the output at all.
2. I built (already present in this worktree) and ran the real tsup artifact,
   `migration/registry/dist/cli.js`. `grep -n "UI_DIR" registry/dist/cli.js` shows the exact
   unmodified line: `var UI_DIR = path9.join(__dirname, "..", "..", "ui-dist");` at bundle line
   2634. Since the bundle lives at `migration/registry/dist/cli.js`, `__dirname` =
   `migration/registry/dist`, and `path.join(__dirname, "..", "..", "ui-dist")` =
   `migration/ui-dist` — the **correct** real UI output directory.
3. **Live-tested it**: spawned `node registry/dist/cli.js serve --port 39871` (zero code changes)
   against the already-built `migration/ui-dist/`, then `GET /` →
   **`200`, real `index.html` body** (`<!doctype html><html lang="en">...`). No manual copy, no
   fix applied. The bug as described in `spec.md`'s Source Context does not reproduce against the
   pipeline `build:dist` actually runs.
4. Separately, `migration/dist/registry/cli.js` — the exact path `SC-002`, `GETTING-STARTED.md`
   (lines 65/131/186/188/189), and `setup.ts` (lines 325/328/330) all hardcode as "the" built CLI
   — is **not produced by `npm run build:dist` at all**. The only script that emits
   `migration/dist/**` (tsc-per-file layout, `outDir: "dist"` in `migration/tsconfig.json`, which
   *would* produce `migration/dist/registry/commands/serve.js` and reproduce the described bug) is
   `migration/package.json`'s own `"build": "tsc -p tsconfig.json"` script — and
   `scripts/build-dist.mjs` never invokes it. `assembleTarball()` (build-dist.mjs:183) copies
   `path.join(repoRoot, "migration", "dist")` into the tarball unconditionally, without ever
   populating it in the same run.

**Consequence**: on a genuinely clean checkout, `npm run build:dist` either crashes
(`copyFilteredDirectory` calls `fs.readdir` on a nonexistent `migration/dist`, which throws ENOENT
with no absent-directory guard, unlike the `docs/`-absent handling added for #116) or — if a stray
`migration/dist` happens to exist locally from a prior manual `npm run build` (as it does in this
worktree right now) — ships **stale** content unrelated to the current source tree. Either way, the
literal `SC-002` acceptance command (`node migration/dist/registry/cli.js serve` after `build:dist`)
targets a file the documented build never reliably creates, and the actual shipped artifact
(`migration/registry/dist/cli.js`) already works today with the unmodified `UI_DIR` computation.
This is a real, more severe, pre-existing packaging defect that #123's diagnosis conflated with a
different (and already-working) code path.

**Fix location**: `spec.md` "Source context" (serve.ts bullet) — correct the build-layout premise
(cite `migration/tsup.config.ts` outDir, not a hypothetical `migration/dist/registry/commands/`
path); `spec.md` SC-002/Acceptance Scenario 4 — either scope this feature to include the
`build-dist.mjs` → `migration/dist` wiring gap (promote `tasks.md` T008 from optional to required,
and add a Step 0/step that runs `migration`'s `build` (tsc) or repoints `assembleTarball()` at
`registry/dist` + `guildctl/dist`), or explicitly descope SC-002/AS4 to "no regression to the
already-working tsup path" and file the packaging-path mismatch as a separate issue. `tasks.md`
T005 — the "built-layout `__dirname` shape... as if running from `.../dist/registry/commands/
serve.js`" test fixture (case a, e) exercises a directory shape (`dist/registry/commands/`) that no
real build produces; if kept, it should be relabeled as testing the *tsc* build path specifically
(dev-only, not the shipped pipeline), and a **second** fixture matching the real tsup single-file
`registry/dist/cli.js` layout should be added since that is what actually ships.

### I1 — ISSUE: `plan.md` cites an out-of-bounds line range for the `run [phase]` action, contradicting `tasks.md`'s (accurate) citation for the same code

**Artifacts**: `plan.md` Summary (line 13) and "Technical Approach Per User Story" → US1 (line 92:
*"Module: `migration/guildctl/cli.ts`, `run [phase]` action (command at line 666, action lines
670–738)"*); `tasks.md` T003 (*"wrap the `switch (phase) { … }` body (lines 671–719...)"*).

`migration/guildctl/cli.ts` is **723 lines total** (verified: `wc -l`). Line 738 does not exist in
the file. The actual `run [phase]` action (`program.command("run [phase]")` at line 666,
`.action(async (phase, opts) => { switch (phase) { … } })` at line 670) closes at line 720
(`});`), with the `switch` body spanning lines 671–719 exactly as `tasks.md` T003 states. `plan.md`'s
"670–738" appears twice (Summary and Technical Approach) and is wrong both times — it does not
match the actual file, and it does not match `tasks.md`'s own citation for the identical code. Since
`tasks.md` (the artifact an implementer actually executes) is correct, this does not block
implementation, but it is a real, mechanically-verifiable inaccuracy in `plan.md` on the very
line range the fix is centered on.

**Fix location**: `plan.md` lines 13 and 92 — change "670–738" to "670–720" (or "671–719" for the
switch body specifically, matching `tasks.md`).

### I2 — ISSUE: `spec.md`'s Governing Document section attributes text to constitution Principle VI that Principle VI does not contain; Principle III's actual text ("without human intervention") sits awkwardly against US3's manual-operator fix

**Artifacts**: `spec.md` line 22 (Governing Document); `.specify/memory/constitution.md` lines
72–90 (Principle III) and 125–142 (Principle VI); `plan.md` Constitution Check table (III and VI
rows).

`spec.md` line 22 states: *"**Governing document**: `.specify/memory/constitution.md` —
principally **I** ... and **VI (Fail-Closed Automation: the operator escape hatch must be
actionable; do not refuse a documented recovery path with a non-actionable error)**."* This reads
as a paraphrase of Principle VI's content. It is not. Principle VI's actual five bullets
(constitution.md:129–138) are: `auto-run` must halt on systemic executor errors;
credential/provider preflight must fail closed with redaction; timed-out agents must be
terminated, not left as zombies; output must be silence-first; bounded canaries (`--wave`,
`--limit`) must remain available. None of these address a manual escape-hatch command's error
message being actionable — that framing does not appear anywhere in Principle VI's text.

The principle whose literal text is closest to US3's concern is actually **III**: *"Claims MUST be
recoverable without human intervention: lease expiry, run-ID cleanup, owner-ID cleanup, and
stale-run reconciliation all release work back to the pool"* (constitution.md:83–84). But this
cuts the other way from how `plan.md`'s Constitution Check table uses it — Principle III's bar is
*automatic* recovery (no human involved), whereas #124's fix is precisely a **human operator**
manually running `release --id ... --agent operator --reason "crashed"`. `plan.md`'s III row
("US3 keeps `releaseTask`'s claim-release path registry-mediated... it makes the existing
registry-mediated recovery path... reach the state it was designed to reach") sidesteps this
tension by focusing on "registry-mediated," which is true, but doesn't reconcile the "without human
intervention" clause with a fix whose entire scenario is a human intervening. `plan.md`'s VI row is
more careful — it cites the real line 131 quote and explicitly labels the escape-hatch framing as
"the general fail-closed-not-silent principle" (an added gloss, not a quote) — but `spec.md`'s
Governing Document section presents the same gloss as if it were the constitution's own words.

This doesn't change whether the code fix is a good idea (it is), but it weakens the spec's own
evidentiary rigor — ironic for a feature whose stated governing principle is "Evidence Over
Assertion."

**Fix location**: `spec.md` line 22 — either quote Principle III/VI's actual bullets and explain
the reasoning-by-extension explicitly (rather than presenting an invented paraphrase as the
principle's content), or drop the specific quotation marks framing.

### I3 — ISSUE: US2 Acceptance Scenario 4 / SC-002 has no required implementing task — `tasks.md` T008 (the only task that would satisfy it) is explicitly marked optional

**Artifacts**: `spec.md` US2 Acceptance Scenario 4, SC-002; `tasks.md` T008.

Acceptance Scenario 4 (spec.md:56) requires: *"Given `build:dist` is the documented one-shot
build, When it runs, Then it builds the UI as part of the kit build so `serve` works immediately
(or... GETTING-STARTED.md documents the exact build step)."* SC-002 requires the same, unqualified:
*"`node migration/dist/registry/cli.js serve` after `build:dist` returns `200` at `/` and real data
at `/api/artifacts` with no manual `ui-dist` copy."* Both are stated as mandatory (SC-002 is a
numbered Success Criterion with no "SHOULD" downgrade, unlike I1's counterpart in the Wave-3
analysis of `spec.md` FR-013).

`tasks.md` T008 is the only task that touches `scripts/build-dist.mjs` (the file that would need to
build the UI as part of `build:dist`), and it is explicitly labeled *"Optional / out of plan.md's
stated file scope"* and *"Not required for FR-005/006/007 or for T005/T009 to pass — those are
satisfied by T006/T007 alone."* No other task wires `build:ui` into `build:dist`. This means the
task list, by its own admission, does not fully satisfy SC-002/AS4 — and per B1 above, the gap is
worse than `tasks.md` acknowledges (T008 as scoped only adds a UI build step; it does not fix the
separate `migration/dist` vs. tsup-output-directory mismatch that also blocks SC-002's literal
command).

**Fix location**: `tasks.md` — promote T008 (and extend it per B1) from optional/[P] to a required
task gating T009's verification of SC-002, or `spec.md` — downgrade SC-002/AS4 to explicitly scope
out the full `build:dist` wiring (matching how Wave 3's spec handled the analogous FR-013 doc gap).

### I4 — ISSUE: `spec.md`'s FR-007/Edge-Cases claim of a "silent 404" is only true for one of `serve.ts`'s three UI-serving branches

**Artifacts**: `spec.md` Edge Cases (#123, "UI not built at all"), FR-007; `tasks.md` T005(d)
(*"current code has no `fs.existsSync(UI_DIR)` check at the reader call sites (serve.ts lines 222,
229, 232), so the failure mode today is a silent 404"*).

Verified against `migration/registry/commands/serve.ts` as it exists today: the `/` and
`/index.html` route (lines 221–227) **already** emits a named, actionable message on a missing UI —
`res.writeHead(404); res.end("UI not built. Run from the workspace root: npm --prefix migration/ui
run build");` (line 224) — via `serveStatic`'s boolean return, not a bare 404. Only the
asset/SPA-fallback branch (lines 229–234) is genuinely silent (`res.writeHead(404); res.end("Not
found");`, no diagnostic). So the claim "the failure mode today is a silent 404" is accurate for one
of the two code paths and inaccurate for the other; FR-007/T005(d) should test that the *existing*
`/` message is preserved (or improved) rather than treating it as wholly new behavior, and should
add the missing diagnostic specifically to the SPA-fallback branch.

**Fix location**: `spec.md` Edge Cases entry and `tasks.md` T005(d)/T007 — note that `/` already has
a named error (serve.ts:224) and scope the "add a named error" work to the SPA-fallback branch
(serve.ts:229–234) plus updating the existing message's build command if the chosen UI_DIR fix
changes it.

## Nits

### N1 — NIT: FR-001's "fails its own postcondition check" is not implemented by T003; only "throws" is

**Artifacts**: `spec.md` FR-001, Edge Cases ("#122 — phase that logs failure but does not throw");
`plan.md` US1 "Edge case handling" (acknowledges this as "a residual risk... not a gap"); `tasks.md`
T003 (implements a `try/catch` only).

FR-001 requires catching a phase that "fails its own postcondition check (quality gate /
completion / planning-readiness / etc.)" generically, and the Edge Cases section says the wrapper
"must still detect the failed postcondition... do not assume 'throw' is the only failure signal."
T003's actual implementation is a `try { switch } catch { process.exitCode = 1 }` — it detects
**only** thrown errors, not a postcondition recorded-but-not-thrown. `plan.md` is explicit that this
is acceptable today because every current phase throws on failure (verified true for
`inventory.ts:461`), but the spec/edge-case wording ("must... not assume throw is the only failure
signal") reads as a requirement the implementation doesn't actually meet — it's a documented
known-gap, not a defect, but the FR wording overclaims relative to what's built. Not blocking.

**Fix location**: `spec.md` FR-001 — add the same "no phase in the current codebase does this today;
if one is added later, the wrapper must be revisited" caveat that `plan.md` already carries, so the
requirement doesn't silently overclaim.

### N2 — NIT: `plan.md`/`tasks.md`'s `releaseTask` line-range citations are off by one from the actual closing brace, and `releaseClaimedArtifactsForOwner`'s citation is likewise one line short

**Artifacts**: `plan.md` line 15 (*"`releaseTask` (lines 215–252)"*), line 124 (*"lines 215–252"*);
`tasks.md` T011 (*"lines 215–255"*); `plan.md` line 134/`tasks.md` T012 (*"lines 258–277"*).

Verified against `migration/registry/commands/artifacts.ts`: `releaseTask` spans lines 215–256
(closing brace at 256, `return releaseClaimByArtifactId(...)` at 255); `releaseClaimedArtifactsForOwner`
spans 258–278 (closing brace at 278). `plan.md`'s "215–252" and "258–277" both end one-to-four lines
short of the real closing brace; `tasks.md`'s "215–255" is closer but still one line short. None of
this affects correctness — the guard line (226), throw block (227–230), and SQL filter (268–269)
that the fix actually targets are all cited exactly right in every artifact — this is purely a
function-boundary rounding inaccuracy.

**Fix location**: none required; noted for completeness only.

### N3 — NIT: `spec.md`'s Edge Cases entry for the bulk-release path cites `artifacts.ts:258` for `releaseClaimedArtifactsForOwner` but the SQL filter it discusses is at 268–269, not 258

**Artifact**: `spec.md` line 81 (*"`releaseClaimedArtifactsForOwner` (artifacts.ts:258) bulk-releases
with the same `status = 'in-progress'` SQL filter (lines 268–269)"*).

Line 258 is the function's `export function` declaration line (accurate as a function-start
citation), and 268–269 (the SQL filter) is cited correctly right after it in the same sentence — so
this is not actually an error, just worth flagging that a reader skimming only the first citation
might expect the filter at 258. Verified both numbers are individually correct
(function start: 258; filter: 268–269).

**Fix location**: none required — this is a correctly-written citation on closer reading, included
here only because it was checked.

## Verified-Accurate Citations (no issue — spot-checked for the report)

- `cli.ts`: `preflight` `process.exit(1)` on `verdict === "fail"` (180) ✓; `doctor` config-load
  catch → `process.exit(1)` (195) ✓; `doctor` combined-checks → `process.exit(1)` (237) ✓;
  `program.command("run [phase]")` (666) ✓; `.action(async (phase, opts) => {...})` (670) ✓;
  `switch (phase)` body (671–719) ✓ (matches `tasks.md` T003, not `plan.md`'s "670–738" — see I1);
  `case "inventory": await runInventory(db());` (682–684) ✓; `default:` branch's own
  `process.exit(1)` for unknown phase (716–718) ✓.
- `inventory.ts`: `recordInventoryCompletion(db, { status: "failed", ... })` (453) ✓; quality-gate
  throw `Inventory quality gate failed` (460–461) ✓.
- `serve.ts`: comment "ui-dist is one level up from registry/dist/..." (33) ✓; `UI_DIR = path.join(
  __dirname, "..", "..", "ui-dist")` (34) ✓; `UI_DIR` read sites (222, 229, 232) ✓ — though see I4
  for the "silent 404" characterization of these sites.
- `artifacts.ts`: `releaseTask` guard `artifact.status !== "in-progress"` (226) ✓; throw text
  `Cannot release "<id>": status is "<status>", expected "in-progress".` (227–230, exact match) ✓;
  initial lookup only selects `status`, not `claimed_by` (222–224, confirming the widening plan/tasks
  describe is genuinely needed) ✓; `releaseClaimedArtifactsForOwner` SQL filter `WHERE status =
  'in-progress' AND claimed_by = ?` (268–269) ✓; parameterized `status-changed` event insert
  (249–252) ✓, reason flows through bound params (no SQL-injection surface) ✓.
- `guildctl/commands/release.ts`: `runRelease` imports and calls the *same* `releaseTask` from
  `registry/commands/artifacts.ts` (line 2, line 42/54) — confirms the US3 fix transparently also
  fixes `guildctl release --id <id>` (a second CLI entry point not named anywhere in spec/plan/tasks,
  but reassuringly not a scope gap since it shares the exact function being fixed). `--all-stuck`'s
  `getStuckArtifacts` query (release.ts:26–33) filters `status = 'in-progress'` only, consistent with
  `tasks.md` T012's explicit, intentional non-widening of the bulk path.
- Constitution: Principle I "Exit code zero is not completion evidence. Phases MUST verify their own
  postconditions" (46–47) ✓ matches spec.md's framing; Principle VI line 131 "Credential and provider
  preflight MUST fail closed" ✓ (accurately quoted by `plan.md`, not by `spec.md` — see I2).
- Existing test pattern: `migration/test/cli-phase-aliases.test.ts` uses `spawnSync` against
  `["--import", "tsx", scriptPath, "run", phase]` (source-layout invocation, not built) ✓ — confirms
  US1's new test can reuse this pattern without needing a built-layout fixture (unlike US2's tests,
  which explicitly need one and get the built-layout shape wrong per B1).
- No scope creep found beyond #122/#123/#124: every FR/task traces to exactly one of the three
  sub-issues; T008/T012/T015 are all directly required by an Edge Case or explicitly optional
  follow-through, not unrelated additions.
- No direct technical contradiction between US1/US2/US3 — the three stories touch disjoint files
  (`cli.ts`, `serve.ts`, `artifacts.ts`) and disjoint test files, and all "Recommended Delivery Order"
  / "MVP" framing is internally consistent between `plan.md` and `tasks.md`.

## Coverage Summary

| Requirement | Task(s) | Notes |
|---|---|---|
| FR-001..FR-004 (#122) | T002–T004 | Covered; tests-first; see N1 (postcondition-without-throw is an acknowledged non-gap) |
| FR-005..FR-007 (#123) | T005–T009 (T008 optional) | See B1 (root-cause premise false against real build), I3 (SC-002/AS4 uncovered by a required task), I4 (partial "silent 404" mischaracterization) |
| FR-008..FR-010 (#124) | T010–T013 | Covered; tests-first; citations accurate (see N2 for minor line-range rounding) |
| NFR-001 | T004 | Covered (green-path regression assertion) |
| NFR-002 | T005(e), T006 | Nominally covered, but the "built layout" fixture tests the wrong directory shape — see B1 |
| NFR-003 | T004, T009, T013, T014 | Covered |
| SC-001 | T004 | Covered |
| SC-002 | T009 (+ T008, optional) | **Not achievable via required tasks alone** — see B1, I3 |
| SC-003 | T013 | Covered |
| SC-004 | T014 | Covered |

**Metrics**: 10 FRs, 3 NFRs, 4 SCs, 15 numbered tasks (+ checkpoints/verify tasks) — all have at
least one mapped task except SC-002, which maps only to an optional task. 1 BLOCKER, 4 ISSUE,
3 NIT findings.

## Next Actions

- **Resolve B1 before `/speckit-implement` touches US2.** Re-diagnose the actual `build:dist` →
  `migration/dist` gap (tsup outputs to `registry/dist`/`guildctl/dist`, not `migration/dist`;
  nothing runs the tsc `build` script that would produce `migration/dist/registry/commands/
  serve.js`), decide whether this feature's scope grows to include the packaging-path fix or
  explicitly descopes SC-002, and correct `spec.md`'s Source Context narrative either way — it is
  currently describing a bug that a live test shows does not reproduce against the shipped pipeline.
- I1–I4 should be fixed but don't block starting US1 or US3, which have no BLOCKER findings and
  whose code-location citations verified clean.
- Suggested commands: edit `spec.md`'s Source Context/SC-002/Governing-Document sections and
  `plan.md`'s US1 line citations directly (localized edits, no regeneration needed); re-run
  `/speckit-analyze` after edits to confirm B1 clears, ideally re-verifying with the same live
  `node registry/dist/cli.js serve` smoke test used here.

## Findings (severity-tagged)

- **[blocker]** B1 — US2/#123's stated root cause (`migration/dist/registry/commands/serve.js`
  build layout) is falsified by a live test against the real `build:dist`/tsup pipeline; the real
  packaged CLI (`migration/registry/dist/cli.js`) already serves the UI correctly today with zero
  code changes, while the path `SC-002` actually names (`migration/dist/registry/cli.js`) is never
  produced by `npm run build:dist` at all.
- **[issue]** I1 — `plan.md` cites `cli.ts` lines "670–738" for the `run [phase]` action; the file
  is 723 lines total and the action actually closes at line 720, contradicting `tasks.md`'s own
  (accurate) "671–719" citation for the same code.
- **[issue]** I2 — `spec.md`'s Governing Document section attributes an "operator escape hatch must
  be actionable" framing to constitution Principle VI, which does not appear anywhere in Principle
  VI's actual text (constitution.md:125–142); Principle III's actual "without human intervention"
  clause (83–84) sits in tension with US3's manual-operator recovery command, unaddressed by
  either spec.md or plan.md.
- **[issue]** I3 — US2 Acceptance Scenario 4 and SC-002 require `build:dist` to produce a working
  UI, but `tasks.md`'s only task touching the packaging pipeline (T008) is explicitly marked
  optional and not required for any other task to pass — SC-002 has no required implementing task.
- **[issue]** I4 — `spec.md`/`tasks.md`'s "silent 404" characterization of `serve.ts`'s missing-UI
  behavior is only true for the SPA-fallback branch (serve.ts:229–234); the `/` route already emits
  a named, actionable error today (serve.ts:224).
- **[nit]** N1 — FR-001's "fails its own postcondition check" requirement is broader than what T003
  implements (throw-only detection); `plan.md` already documents this as an accepted residual risk,
  but `spec.md`'s FR wording doesn't carry the same caveat.
- **[nit]** N2 — Minor one-to-four-line rounding inaccuracies in `releaseTask`/
  `releaseClaimedArtifactsForOwner` function-boundary citations across `plan.md`/`tasks.md`; the
  operative guard/filter line numbers inside those functions are all correct.
- **[nit]** N3 — `spec.md`'s Edge Cases citation of `artifacts.ts:258` for
  `releaseClaimedArtifactsForOwner` is a correct function-start citation, not an error; included
  only because it was checked.

## Verdict

**CHANGES_REQUESTED** — B1 must be resolved (re-diagnose the #123 root cause against the actual
`build:dist`/tsup pipeline and either fold the real packaging gap into this feature's scope or
explicitly descope `SC-002`) before `/speckit-implement` proceeds on US2. US1 and US3 have no
blocking findings and are implementable as specified today.
