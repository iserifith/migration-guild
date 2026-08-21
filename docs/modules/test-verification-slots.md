# Test Generation & Verification Slots — Deep Dive

*Subsystem: tests-first codegen phases, bounded verify-slot leases, verification records, and characterization/mock fixtures that feed verification.*

---

## Purpose / Overview

This subsystem answers two related questions about every migrated artifact:

1. **"Were its tests written before its code?"** — the migration pipeline enforces a
   tests-first ordering by moving artifacts through an explicit `analyzed →
   tests-written → migrated` status ladder (migration/registry/types.ts:36). The
   `guildctl migrate` command drives three agent pools in lockstep: analyzers
   (`planned`), test writers (`analyzed`), and code writers (`tests-written`).
   Test generation is therefore not an afterthought inside codegen; it is a
   *queue position*. An artifact cannot be claimed for code-writing until it has
   reached `tests-written`.

2. **"Was its own output actually checked?"** — after migration, verification
   records whether the artifact's output was compiled/run, by what method, and
   why not if it wasn't. This is deliberately **powerless triage input**: it never
   writes `artifacts.status`, never writes `acceptance_evidence` as a gate, and
   never unlocks arbitration on its own (see the module docstring in
   migration/registry/commands/verification.ts:7-15; Constitution IV requires
   independent verifier-produced runtime evidence).

Because verify steps spawn real subprocesses (compilers, test runners), the
system bounds their concurrency with a **verify slot lease table**
(`verify_slots`, migration/registry/commands/verifySlot.ts) so at most
`verification.max_concurrent` verify subprocesses are live at once.

Feeding all of this are **fixtures**: captured characterization snapshots of
legacy behavior (spec 002) and expanded mock legacy source trees under
`package/mock/` (spec 008) used to exercise the pipeline end-to-end.

---

## Architecture / Data Model

### Tables & files

| Thing | Where | Shape |
|---|---|---|
| Verification record | `artifact_verifications` table, one row per artifact (last-write-wins) | `state`, `method`, `reason`, `detail`, `scope_json`, `budget_ms`, `duration_ms`, `run_id`, `determined_at` |
| Verify slot lease | `verify_slots` table | `slot_id`, `run_id`, `artifact_id`, `acquired_at`, `lease_expires_at`, `released_at` |
| Fixture file on disk | `<workspace>/<evidence.output_dir>/characterization/<id>.json` | `{ seam, input, output, capturedAt, contentSha256 }` (`CharacterizationFixture`, migration/registry/commands/fixture-file.ts:5-11) |
| Fixture evidence row | `acceptance_evidence` with `evidence_type='characterization-fixture'`, `content_sha256`, `output_path` pointing at the fixture file | written by `addCharacterizationFixtureEvidence` (migration/registry/commands/evidence.ts:199) |
| Runtime evidence row | `acceptance_evidence` with `evidence_type='runtime'`, HMAC-signed `authenticity`, `log_sha256` | written by `addVerifierRuntimeEvidence` (migration/registry/commands/evidence.ts:167) |
| Audit trail | `events` rows of type `'evaluated'` appended alongside every verification write | migration/registry/commands/verification.ts:168-185 |

### Module map

```
guildctl/commands/migrate.ts        three-pool orchestrator (analyze → test-write → code-write)
  └─ preClaim: { fromStatus: "analyzed" }   ← tests-first enforced here
registry/commands/claim.ts          claim lease + deriveExpectedOutputPaths
guildctl/commands/capture-fixture.ts runCaptureFixture / CLI wrapper
registry/commands/fixture-file.ts    writeFixtureFile / readFixtureFile / sha256Json
registry/commands/evidence.ts        addCharacterizationFixtureEvidence, compareToFixture,
                                     addVerifierRuntimeEvidence
guildctl/commands/verify.ts          runVerifyCommand (CLI entry)
guildctl/verify.ts                   runVerify (--command path), buildVerificationScope,
                                     runArtifactVerification (stack-check path),
                                     verifyAtClaimClose, signRuntimeEvidence, redactSecrets
registry/commands/verification.ts    setVerification / getVerification / listVerification /
                                     resetVerification (the record itself)
registry/commands/verifySlot.ts      acquireVerifySlot / withVerifySlot / releaseVerifySlot
guildctl/config.ts                   resolveVerificationBudgetMs, resolveVerifyMaxConcurrent
guildctl/stack.ts                    resolvePerArtifactVerify, expandVerifyArgs/WorkingDir
package/mock/*                       mock legacy fixtures (java/python)
```

### Key vocabularies

- **Verification states** (closed): `verified | unverified | verification-failed`
  (`VERIFICATION_STATES`, migration/registry/commands/verification.ts:17).
- **Reasons** (closed vocabulary `VERIFICATION_REASONS` in registry/types.ts):
  includes `not-attempted`, `no-stack-check`, `tree-incomplete`,
  `budget-exhausted`, `check-error`, `check-failed`, `agent-reported-unverifiable`.
- **Statuses relevant to tests-first**: `planned → analyzed → tests-written →
  migrated …` (registry/types.ts:36).

---

## Step-by-step Flow

### A. Tests-first codegen (`guildctl migrate`)

1. `migrate.ts:runMigrateCommand` loads the active stack pack and prints three
   pools: Pool 0 Analyzers, Pool 1 **Test writers**, Pool 2 Code writers
   (migration/guildctl/commands/migrate.ts:193-195).
2. The test-writer prompt is `"Write tests for next analyzed task"` plus the
   pack's stack instruction suffix via `readStackInstruction(pack, "tests")`
   (migrate.ts:222-224).
3. Each pool session spawns through `runWithProviderFallback(...)` with
   `preClaim: { fromStatus: "analyzed", tier: "first-class", wave }` for test
   writers (migrate.ts:293) and `fromStatus: "tests-written"` for code writers
   (migrate.ts:325). The preclaim mechanism (registry/commands/claim.ts) only
   lets a session claim artifacts whose status matches `fromStatus`, which is
   what makes the ordering structural rather than advisory.
4. On success the pool summary reports `advancedStatus: "tests-written"`
   (migrate.ts:304); failed sessions set `releaseClaimsOnFailure: true`.
5. Codegen prompts get per-artifact disposition guidance appended later by
   `promptForArtifact` once the claim reveals the artifact (migrate.ts:225-237).

### B. Capturing a characterization fixture (`guildctl capture-fixture`)

1. `runCaptureFixtureCommand` (migration/guildctl/commands/capture-fixture.ts:101)
   starts a run (`phase: "capture-fixture"`) and mints a run operator credential.
2. `runCaptureFixture` (same file :35) executes the operator-supplied seam
   command in the workspace. **On non-zero exit it returns
   `{ captured: false, reason }` and records nothing** — a seam needing a live
   runtime is skipped, never fabricated (FR-005 of spec 002).
3. stdout is JSON-parsed, falling back to raw trimmed stdout (:60-67).
4. `writeFixtureFile` (fixture-file.ts:32) writes
   `<dir>/<timestamp>-<rand>.json` containing seam/input/output/capturedAt and
   `sha256Json(output)`; returns the path + content hash.
5. `addCharacterizationFixtureEvidence` persists an evidence row with
   `evidence_type='characterization-fixture'` and the content hash. Capture
   twice → two independent rows (confirmed by
   migration/test/evidence-characterization.test.ts:197).

### C. Consuming a fixture (Migrate/Arbiter side)

`compareToFixture(db, artifactId, candidateOutput)`
(migration/registry/commands/evidence.ts:240):

```ts
const latestFixture = getLatestCharacterizationFixture(db, artifactId);
if (!latestFixture || !latestFixture.output_path) {
  throw new RegistryError(2, `No characterization-fixture evidence found ...`);
}
const match = JSON.stringify(fixture.output) === JSON.stringify(candidateOutput);
```

- Picks the latest passing fixture row, reads the file from disk, compares
  serialized outputs. Throws a distinguishable `RegistryError` when no fixture
  exists so callers can treat absence as non-blocking (FR-007) versus a real
  mismatch. Freshness reuses the shared evidence-freshness contract — a fixture
  file whose content no longer hashes to its recorded `content_sha256` is stale
  (test: evidence-characterization.test.ts:313).
- Note: `compareToFixture` currently has no production caller wired into the
  migrate phase itself (grep shows only its definition); it is the library API
  spec 002 US2 defines for Migrate-phase consumers.

### D. Verifying an artifact

Two entry paths converge on the same primitives:

**Path 1 — explicit commands** (`guildctl verify --command …`):
`runVerifyCommand` (guildctl/commands/verify.ts:19) starts a run, mints an
operator credential, splits `--command` flags on `;;`
(`configuredCommands`, :14), then calls `runVerify`
(guildctl/verify.ts:122). For each command it:
1. holds one verify slot via `withVerifySlot` around `execAsync` (:147-155),
2. scrubs env (`scrubVerificationEnv`, allowlist PATH/HOME/etc., :82),
3. redacts secrets from captured output (`redactSecrets`, :114),
4. writes a log file, computes `sha256(log)`, signs canonical JSON with the
   operator token (`signRuntimeEvidence`, HMAC-SHA256, :75),
5. appends a signed `runtime` acceptance-evidence row.

**Path 2 — stack-pack default check**: when no `--command` is given, the CLI
resolves `resolvePerArtifactVerify(loadActiveStack(...))` (a pack without a
`verify:` block yields `undefined`, guildctl/stack.ts:163) and calls
`runArtifactVerification` (guildctl/verify.ts:523), which:

1. short-circuits `agentReportedUnverifiable` → `unverified/agent-reported-unverifiable` (FR-007);
2. builds the scope with `buildVerificationScope` (:253) — **registry rows only,
   zero filesystem globbing** (FR-005 enforcement point): own outputs come from
   the latest claim's `expected_output_paths`; dependency paths come from one hop
   of `source_dependencies ∪ dependencies` (never the transitive closure);
   unmigrated one-hop deps land in `unmigratedDependencies`;
3. containment check: any path resolving outside the workspace root aborts with
   `verification-failed/check-error` (:319-325, FR-005);
4. missing check → `unverified/no-stack-check`; incomplete tree →
   `unverified/tree-incomplete` (FR-006: neither blocks advancement);
5. expands placeholder args/working_dir (`expandVerifyArgs`/
   `expandVerifyWorkingDir`), probes toolchain availability (`probeAvailability`
   — unavailable toolchain is also `unverified/no-stack-check`);
6. runs the check under `withVerifySlot` with a budget; timeout kills the whole
   process group (`terminateProcessGroup`) → `unverified/budget-exhausted`;
7. exit code in `pass_exit_codes` (default `[0]`) → `verified` with
   `scope = ownOutputPaths + dependencyPaths` and `durationMs`; otherwise
   `verification-failed/check-failed`;
8. if `recordEvidence` was requested and a run credential was supplied, a signed
   runtime evidence row is also written (`recordStackCheckEvidence`, :468) —
   this is what lets a stack check back an arbitration approval.

Every terminal outcome funnels through the local `finish()` helper which calls
`setVerification` (unless `persist: false`).

### E. Recording the verification record

`setVerification` (registry/commands/verification.ts:133):
- authorizes via **active claim token OR run operator credential**
  (`requireAuthorization`, :89) — a privileged-looking `agent` name never bypasses;
- validates: `verified` requires `durationMs` and a non-empty `scope`;
  any other state requires a reason from the closed vocabulary (:103-131);
- upserts last-write-wins into `artifact_verifications` and appends an
  `evaluated` events audit row in one transaction;
- redacts secrets from `detail` before persisting (:139).

The read model (`READ_MODEL_SQL`, :23) LEFT-JOINs so a missing row coalesces to
`unverified/not-attempted/none` without backfilling history (FR-002).

`resetVerification` (:251) blanks a record back to unverified when the artifact
re-enters `in-progress` or `needs-rework` — called from
registry/commands/artifacts.ts:207 (Constitution I: content-bound evidence must
not survive superseded output).

### F. Claiming a verify slot

`acquireVerifySlot` (registry/commands/verifySlot.ts:117):
1. resolves `maxConcurrent` from `GUILDCTL_VERIFY_MAX_CONCURRENT` env →
   `verification.max_concurrent` config → default (`resolveVerifyMaxConcurrent`,
   guildctl/config.ts:445);
2. lease ceiling = `max(budgetMs * 2, 30_000)` (:129) — a legitimate long check
   is never reclaimed mid-flight, but a crashed holder frees up promptly;
3. loop: `reclaimStale` (mark expired unreleased rows released) then
   `tryAcquire` (:81) — a single atomic
   `INSERT … SELECT … WHERE (live count) < max_concurrent` statement, so two
   racing sessions cannot both squeeze under the cap;
4. pool full → poll (`pollMs`, min 10ms) until `maxWaitMs` elapses, then throw
   `verify slot not acquired within …`.

`withVerifySlot` (:172) releases in a `finally` — exactly once, on resolve or
reject. `releaseVerifySlot` (:156) is idempotent (`AND released_at IS NULL`).

Crucially, the skip paths in `runArtifactVerification` (no check, unavailable
tool, incomplete tree, containment error) return **before** acquiring a slot —
they never spawn a subprocess, so they must not consume capacity
(guildctl/verify.ts:632-638 comment).

---

## Invariants & Edge Cases

- **Verification never gates.** No outcome of `runArtifactVerification` blocks a
  status transition; `verifyAtClaimClose` (guildctl/verify.ts:711) catches even
  recording failures and returns `null`. Confirmed by test
  "setVerification never touches artifact status, evidence, or arbitration"
  (migration/test/verification-state.test.ts:269).
- **Agent self-report wins.** If the existing record's reason is
  `agent-reported-unverifiable`, `verifyAtClaimClose` returns it untouched — no
  later check may overwrite it with `verified` (:724-728).
- **Verified must say what it covered.** Non-empty `scope` + `durationMs` are
  mandatory for state `verified` (verification.ts:111-118; test
  verification-state.test.ts:122).
- **Missing row ≠ blank.** Reads coalesce to `unverified/not-attempted/none`
  (test verification-state.test.ts:153).
- **History lives in events, not the table.** Last-write-wins per artifact plus
  an appended `evaluated` event per write (test :176).
- **Reset on rework.** Re-entering `in-progress`/`needs-rework` resets the
  verification (artifacts.ts:207; test :231); reset is idempotent (:256).
- **Slot cap is atomic.** Enforced inside one SQL statement, not read-then-write
  (verifySlot.ts:88-104; confirmed by migration/test/verify-slot-concurrency.test.ts:28).
- **Stale leases self-heal.** Expired unreleased slots are reclaimed on next
  acquire (test :77 uses an injected clock past the 240s ceiling).
- **Slots wrap subprocess lifetime only.** Skip paths don't consume slots;
  `withVerifySlot` frees the slot even when the wrapped check throws (test :102).
- **Failed seams are skipped, not fabricated.** `runCaptureFixture` returns
  `captured:false` on seam failure (test evidence-characterization.test.ts:171).
- **Fixtures are append-only evidence.** Two captures produce two rows (test :197);
  staleness is detected by re-hashing the file against `content_sha256` (:313).
- **Secret hygiene throughout.** Env scrubbing, log/output redaction, and
  detail redaction before persistence (verification-state.test.ts:207).

## Gotchas

- `compareToFixture` does naive `JSON.stringify` equality — key order matters;
  semantically-equal objects with different serialization will mismatch.
- `getLatestCharacterizationFixture` picks the newest **pass=1** fixture row;
  there is no per-seam selection — the latest capture wins regardless of seam.
- `countLiveVerifySlots` uses the wall clock while tests inject synthetic clocks;
  mixing them (as verify-slot-concurrency.test.ts:85 notes) gives meaningless
  liveness counts.
- `runVerify` (`--command` path) executes operator strings via `execAsync`
  (shell) deliberately — "the operator asked for these" — whereas the stack-check
  path spawns with `shell: false` and a closed placeholder vocabulary. Don't
  conflate their security models.
- The lease ceiling is derived from the *budget*, so shrinking
  `verification.budget_seconds` also shrinks how long a holder keeps its slot.
- `resetVerification` keeps `budget_ms` and `method` columns untouched — only
  state/reason/detail/scope/duration/determined_at are cleared.
- Mock legacy fixtures live under `package/mock/<name>/src/main/java/...`; the
  inventory scanner derives module names from a `^legacy/([^/]+)/src/main/java/`
  workspace layout, so tests copy fixture trees into `legacy/<fixture-name>/src`
  (migration/test/mock-fixture-waves.test.ts:34-42).

## Extension Points

- **New verification reasons/states**: extend `VERIFICATION_REASONS` /
  `VERIFICATION_STATES` in registry/types.ts; validation in
  `validateInput` enforces the closed vocabulary automatically.
- **New stack-pack checks**: add a `verify:` block to a pack
  (`cmd`, `args`, `working_dir`, `availability_args`, `budget_seconds`,
  `pass_exit_codes`, `unavailable_note`); placeholders expand against
  `{artifact_path, output_paths, dependency_paths, module, workspace_root}`.
- **New evidence types**: follow the `characterization-fixture` precedent — a
  dedicated typed insert helper (like `addCharacterizationFixtureEvidence`)
  rather than widening the caller-asserted path's CHECK list (test
  evidence-characterization.test.ts:100 pins that separation).
- **More mock fixtures**: drop new trees under `package/mock/` following the
  existing layout; spec 008 asks for view-bearing modules, cross-module
  dependencies, and "renamed-not-modernized" bait fixtures.
- **Concurrency tuning**: `GUILDCTL_VERIFY_MAX_CONCURRENT` env override and
  `verification.max_concurrent` config; `pollMs`/`maxWaitMs`/`now`/`sleep` are
  all injectable in `AcquireVerifySlotOptions` for testing.

## What the tests confirm

- migration/test/verify-slot-concurrency.test.ts — cap enforcement, release
  freeing capacity, idempotent release, stale-lease reclaim, finally-release.
- migration/test/verification-state.test.ts — full lifecycle of the
  verification record (states, reasons, scope/duration requirements, coalesced
  reads, audit events, redaction, reset, authorization, close-out formatting).
- migration/test/verification-bounds.test.ts — budget/concurrency resolution.
- migration/test/evidence-characterization.test.ts — schema widening,
  capture/skip/duplicate-capture, compareToFixture match/mismatch/no-fixture,
  freshness-vs-hash.
- migration/test/mock-fixture-waves.test.ts — real scanner + wave planner over
  the `legacy-customer-utils`/`legacy-customer-reports` mock pair produces ≥2
  waves with the dependency ordered first (spec 008 SC-003).
