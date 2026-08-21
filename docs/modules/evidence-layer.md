# The Evidence Layer

This module documents how Migration Guild files, protects, and consumes evidence: the
on-disk layout under `.guild/`, the `acceptance_evidence` table that is the *real* system
of record, the cryptographic binding between rows and log files, and the downstream gates
(arbitration approval, freshness, fixture comparison, verification records) that read it.

The single most important structural fact: **`.guild/evidence` is not the system of
record — the SQLite registry is.** The filesystem holds immutable, hash-chained *log
artifacts*; the database holds the queryable, signed *claims* about them. Every gate in
the codebase reads the database and then spot-checks the file against its recorded
digest. Nothing ever trusts the file alone.

---

## 1. On-disk layout: `.guild/`

`guildctl init` scaffolds the workspace via `scaffoldGuildConfig`
(`migration/guildctl/config.ts:383`):

```ts
const guildDir = path.join(root, ".guild");
fs.mkdirSync(path.join(guildDir, "prompts", "default"), { recursive: true });
fs.mkdirSync(path.join(guildDir, "runs"), { recursive: true });
fs.mkdirSync(path.join(guildDir, "evidence"), { recursive: true });
```

alongside `.guild/config.yaml` and (by default) `.guild/registry.db`
(`config.ts:390`). The doctor's readiness check asserts the runs directory exists and is
writable (`migration/guildctl/cli.ts:210-211`).

### 1.1 `.guild/evidence`

The default output root comes from config defaults
(`migration/guildctl/config.ts:76`):

```ts
evidence: { output_dir: ".guild/evidence", include_git_diff: true, ... },
```

Subdirectories are created lazily by producers, by convention rather than scaffold:

| Path | Producer | Naming scheme |
|---|---|---|
| `.guild/evidence/<ts>-<uuid8>-runtime.log` | `runVerify` (`migration/guildctl/verify.ts:177`) or the supervisor default `outputDir` of `${workspaceRoot}/.guild/evidence` (`migration/guildctl/supervisor/loop.ts:523`) | epoch-ms + 8-char UUID slice |
| `.guild/evidence/runtime/*.log` | `recordStackCheckEvidence` for stack-pack checks; note the **different** default dir: `<workspaceRoot>/.guild/evidence/runtime` (`verify.ts:479`), suffix `-stack-verify.log` |
| `.guild/evidence/characterization/<id>.json` | `runCaptureFixture` (`migration/guildctl/commands/capture-fixture.ts:118`), composed as `${cfg.evidence.output_dir}/characterization`; fixture files named by a fresh random id (`capture-fixture.ts:71`) |

Two naming schemes coexist (flat timestamped logs at the root vs. typed
subdirectories). This is historical accretion, not design: the supervisor's default
outputDir writes runtime logs directly into `.guild/evidence/` with no `runtime/`
segment (`loop.ts:523`), while the per-artifact stack-check path defaults to
`.guild/evidence/runtime/` (`verify.ts:360-361`, `verify.ts:479`). Consumers never glob
either directory — they follow `output_path` columns on evidence rows — so the
inconsistency is harmless but worth knowing when reading a workspace by hand.

### 1.2 `.guild/runs`

Two distinct things share this directory conceptually:

1. **Run ledger directories** written by `createRunLedger`
   (`migration/guildctl/workspace.ts:147-162`). Each run gets an ISO-timestamped
   directory containing `input.json`, `config.snapshot.yaml` (API keys scrubbed via
   `sanitizedConfigSnapshot`, `config.ts:369-381`), `prompt.final.md`, `response.md`,
   and `evidence/init-evidence.json` plus `report.md` when an `EvidenceReport` from
   `collectInitEvidence` (`workspace.ts:94`) was supplied.

2. **The `runs` SQL table** in the registry (schema migration columns in
   `migration/registry/db/schema.ts:63-70`: `files_written_count`, `outcome_label`,
   `survivor_pids`, etc.). Rows are created by `startRun` / finished by `finishRun`
   (`migration/registry/commands/runs.ts:84,184`), carrying an optional `log_file`
   path. The UI's run-log viewer streams that path over `/api/runs/<id>/log`
   (`migration/registry/commands/serve.ts:253-271`, client side
   `migration/ui/src/api.ts:196-198`).

So "a run" lives in two places: mutable bookkeeping + outcome columns in SQLite, and an
immutable prompt/response snapshot under `.guild/runs/<timestamp>/`. Run IDs are also
referenced from evidence rows via `acceptance_evidence.run_id`.

### 1.3 Why the warden must exclude `.guild/evidence`

Both the manual runner and the supervisor snapshot the workspace before an agent runs
and revert unauthorized writes afterwards ("warden"). Evidence logs are written *during*
agent execution windows by verify subprocesses, so they must be excluded from
enforcement:

```ts
// migration/guildctl/supervisor/loop.ts:491
const wardenExcludedPaths = transientWardenExclusions(opts.workspaceRoot,
  [path.resolve(opts.outputDir ?? `${opts.workspaceRoot}/.guild/evidence`),
   ...activeSqliteWardenExclusions(db)]);
```

The same exclusion exists in the manual runner (`migration/guildctl/runner.ts:424`).
A characterization test pins this: `migration/test/warden.test.ts:98` asserts a
snapshot does **not** contain `.guild/evidence/runtime.log`. Without the exclusion the
warden would delete freshly written evidence logs mid-run — and worse,
`validateRuntimeEvidence` would then fail its own digest re-check (see §4), turning a
successful verification into an unapprovable artifact.

---

## 2. What counts as evidence

### 2.1 The row shape

Every piece of acceptance evidence is one row in `acceptance_evidence`, typed by
`EvidenceType` (`migration/registry/types.ts:174-181`):

```
"runtime" | "test-command" | "build-command" | "static-check"
| "review-verdict" | "benchmark-result" | "characterization-fixture"
```

with fields `evidence_id`, `artifact_id`, `run_id`, `produced_by`, `command`,
`exit_code`, `pass` (0|1), `summary`, `output_path`, `output_excerpt`, `log_sha256`,
`duration_ms`, `authenticity`, `content_sha256`, `signature_json`
(`types.ts:183-201`).

Per-type provenance rules split the vocabulary into three ownership classes:

**Tool-owned types.** `runtime` and `characterization-fixture` can only be inserted by
their owning tools; the generic CLI path refuses them
(`migration/registry/commands/evidence.ts:84-98`):

```ts
const TOOL_OWNED_EVIDENCE_TYPES = new Set(["runtime", "characterization-fixture"]);
const TOOL_OWNED_EVIDENCE_COMMANDS = {
  runtime: "guildctl verify",
  "characterization-fixture": "guildctl capture-fixture",
};
export function addAcceptanceEvidence(db, opts) {
  if (TOOL_OWNED_EVIDENCE_TYPES.has(opts.evidenceType)) {
    throw new RegistryError(3, `${opts.evidenceType} evidence must be recorded by ${...}`);
  }
  return insertAcceptanceEvidence(db, opts);
}
```

Why: these two types carry cryptographic authenticity material (`authenticity`,
`log_sha256` / `content_sha256`) that an arbitrary agent cannot be trusted to
fabricate honestly. Everything else an agent claims about itself is allowed through
the generic path but is *structurally incapable of gating approval* (§4).

- `addVerifierRuntimeEvidence` (`evidence.ts:167`) enforces a 64-hex `log_sha256` and
  non-empty `authenticity`, defaulting `produced_by` to `"guildctl-verify"`.
- `addCharacterizationFixtureEvidence` (`evidence.ts:199`) defaults producer to
  `"guildctl-capture-fixture"` and carries `content_sha256` from
  `writeFixtureFile` (`migration/registry/commands/fixture-file.ts:32-45`, which hashes
  only the JSON-stable `output`, via `sha256Json`).

**Agent-attested types.** `test-command`, `build-command`, `review-verdict`,
`benchmark-result` go through the CLI wrapper `runEvidenceAdd`
(`migration/guildctl/commands/evidence.ts:60`), which restricts `--type` to exactly
those four (`evidence.ts:6-12`), infers `pass` from `--exit-code` unless
`--pass/--fail` is explicit (`inferPass`, `evidence.ts:50-58`), and appends an
`evidence-submitted` event attributed to role `"critic"`.

**Derived static-check.** The drift gate records `static-check` evidence itself via
the generic insert, as producer `"guildctl-drift-gate"`, attaching
`content_sha256` of the modernized file and a JSON API-signature diff
(`supervisor/loop.ts:196-206`).

### 2.2 Verification records are deliberately *not* evidence

A separate `verification` table records bounded per-artifact check outcomes with states
`verified | unverified | verification-failed` (`types.ts:216-229`). The schema comment
is load-bearing:

> Verification state is a fact distinct from migration status, and is triage input
> only: it can never satisfy the arbitration gate, substitute for acceptance evidence,
> or unlock a status transition.

`runArtifactVerification` (`verify.ts:523`) maps every failure mode to a recorded fact
and never throws: missing pack → `unverified/no-stack-check`; incomplete dependency
tree → `unverified/tree-incomplete` (FR-006); budget kill → `unverified/budget-exhausted`;
an agent's self-report wins permanently (`agent-reported-unverifiable` short-circuits
even later checks in `verifyAtClaimClose`, `verify.ts:724-728`).

However, when a caller passes `recordEvidence: true` plus a run credential, a passing
or failing stack check *also* mints a fully signed `runtime` acceptance-evidence row
via `recordStackCheckEvidence` (`verify.ts:468-514`), produced by
`"guildctl-verify-stack"`, writing into `.guild/evidence/runtime/`. That opt-in is the
bridge: verification bookkeeping alone cannot approve anything, but the same check can
simultaneously produce real evidence that can.

---

## 3. Filing flow walkthrough: `guildctl auto` end-to-end

1. **Run opens.** `runAuto` (`loop.ts:467`) generates `auto-<uuid12>` and calls
   `startRun`, then mints the run-bound operator credential:
   `createRunOperatorCredential(db, runId)` (`loop.ts:500`, implementation
   `migration/registry/commands/claim.ts:19`). This HMAC token is the root of all
   runtime-evidence signatures for the run.

2. **Verify executes.** The default verifier closes over the loop's runId/token and
   calls `runVerify` (`loop.ts:519-527`). For each configured command it spawns under
   a scrubbed environment (`scrubVerificationEnv`, `verify.ts:82`), redacts secret
   values from output (`redactSecrets`, `verify.ts:114`), formats a log block, hashes
   it (`sha256(log)` → `log_sha256`), writes the log to `outputDir`, signs the
   canonical tuple, and inserts the row (`verify.ts:164-202`).

3. **Signing.** `signRuntimeEvidence` (`verify.ts:75-80`) computes
   `hmac-sha256:<HMAC(operatorToken, canonicalJSON)>` over
   `{artifact_id, run_id, command, exit_code, pass, log_sha256}`
   (`runtimeEvidenceCanonical`, `verify.ts:64-73`). The signature therefore binds
   evidence to *both* the artifact and the run — an attacker cannot transplant a log
   from another run without failing the run-binding check (§4).

4. **Gate decision.** If verification passed, the loop calls
   `approveArtifactWithEvidence` passing the fresh `evidence_ids`
   (`loop.ts:654-658`, `978-982`); on failure it calls `rejectArtifactWithEvidence`
   (`loop.ts:666-670`), which flips the artifact to `needs-rework` inside a transaction
   (`evidence.ts:729-762`).

5. **Approval commits outputs.** On ungated approval,
   `commitPromotedArtifact` (`evidence.ts:597-626`) git-commits the artifact's claimed
   output paths plus approved companion outputs. It deliberately fails open — wrapped
   entirely in try/catch, documented as "a report, not a gate" — and scrubs
   `GIT_DIR`/`GIT_WORK_TREE` etc. from the child env so a hook-invoked commit cannot
   silently target the outer repo (`GIT_SCOPE_ENV`, `evidence.ts:568-571`).

---

## 4. Downstream consumer #1: the arbitration gate

`canApproveArtifact` (`evidence.ts:409-486`) is the single chokepoint every approval
passes through. Its requirements define "what counts" at approval time:

- Artifact status is exactly `migrated`.
- The **latest** runtime evidence (`getLatestExecutableEvidence`, ordered
  `created_at DESC, rowid DESC` — the rowid tiebreak matters because SQLite timestamps
  have second resolution) must exist, be `pass = 1`, and carry both `authenticity` and
  `log_sha256`.
- Arbiter independence: `produced_by !== arbiter` (`evidence.ts:456-462`) — the agent
  that ran the verifier can never approve its own output.
- Full cryptographic validation via `validateRuntimeEvidence` (`evidence.ts:638-672`),
  which re-hashes the file at `output_path` with `timingSafeEqual`, checks run-id
  binding, validates the operator token against the run
  (`validateRunOperatorCredential`, `claim.ts`), and recomputes the HMAC to compare.
  Any tampering with the log after recording breaks the digest match; any reuse across
  runs breaks the signature.

Note the deliberate asymmetry: only `EXECUTABLE_EVIDENCE_TYPES = ["runtime"]`
(`evidence.ts:73-75`) qualifies. Static-checks, test commands, benchmarks, review
verdicts — none of them can satisfy the gate no matter how many pass. Only
tool-signed runtime evidence counts, because it is the only kind whose honesty the
system can actually verify retroactively.

When explicit `evidenceIds` are supplied instead of the latest-row default,
`assertApprovalEvidenceIsIndependent` (`evidence.ts:373-407`) re-applies the same
checks to each supplied row (existence within the artifact, runtime type, pass=1,
authenticity present, independence, full validation).

`approveArtifactWithEvidence` (`evidence.ts:488-561`) wraps everything in one
transaction: freshness check → `canApproveArtifact` → independence assertion →
arbitration-decision insert → `arbitration-approved` event. Inside the same
transaction, high-risk artifacts above the human cutoff are diverted to
`pending-approval` with an `approval-gated` event instead of `reviewed` (US1 spec 013;
`resolveGateScope` from `./approval`). The git promotion happens *after* the
transaction commits, only for ungated approvals.

Rejections are symmetric but weaker by design: `rejectArtifactWithEvidence` only
requires that cited evidence IDs belong to the artifact
(`assertEvidenceIdsBelongToArtifact`) — rejecting on weak evidence needs no
cryptographic proof.

---

## 5. Downstream consumer #2: evidence freshness

Arbitration refuses to act on stale evidence via `checkEvidenceFreshness`
(`evidence.ts:674-727`), checked before *both* `canApproveArtifact` and
`approveArtifactWithEvidence`. Four staleness vectors:

1. **Static-check integrity**: the latest passing `static-check` must still exist on
   disk, share `run_id` with the latest runtime evidence ("Static-check and runtime
   evidence must belong to the same run"), and its file content must still hash to
   `content_sha256` — i.e., nobody edited the migrated file after the drift gate saw
   it.
2. **Fixture integrity**: the latest characterization fixture must still hash-match
   its recorded `content_sha256` — but explicitly *without* a run-binding requirement,
   because fixtures are captured against legacy code in earlier, unrelated runs
   (comment at `evidence.ts:698-702`, FR-009).
3. **Repair ordering**: if any `auto-rework` event postdates the latest runtime
   evidence (`created_at < repair.ts`), evidence is stale — a repaired artifact must
   produce fresh proof. The supervisor even works around second-resolution ties here
   (`loop.ts:926-929`: the helper "breaks same-second auto-rework-vs-evidence ties by
   rowid").
4. Absence of runtime evidence is treated as trivially fresh (`evidence.ts:679`), not
   stale — freshness refines existing evidence, it doesn't demand it.

---

## 6. Downstream consumer #3: fixture comparison (Migrate phase)

`compareToFixture` (`evidence.ts:240-254`) loads the latest passing
`characterization-fixture` row, reads its fixture JSON from disk, and compares
`JSON.stringify(fixture.output)` against candidate output. Failure modes are
deliberately distinguishable (comment at `evidence.ts:234-239`): no fixture at all
throws a `RegistryError(2)` so callers can treat "no target" as non-blocking (FR-007)
while "compared and mismatched" returns `{match:false, diff}`. Tests confirm all three
branches (`migration/test/evidence-characterization.test.ts:248-280`).

---

## 7. Downstream consumer #4: resume path

On `--resume`, `runAuto` consults `latestRuntimeEvidence` (`loop.ts:240-249`) before
deciding what to do: a `blocked` or migrated-with-no-failing-runtime artifact is
re-verified rather than re-claimed, driving review/arbitration purely from the fresh
verifier outcome (`loop.ts:557-618`). Evidence state, not status alone, decides the
resume strategy. A resumed artifact with surviving claims additionally re-runs the
drift gate and records another `static-check` evidence row before proceeding
(`loop.ts:586-618`).

---

## 8. Invariants summary

- **DB is truth, disk is proof.** Gates validate DB rows, then re-derive hashes/HMACs
  from disk. Neither alone suffices.
- **Runtime evidence is the only approval currency**, and only when tool-minted,
  run-bound, HMAC-signed, and fresher than any repair.
- **Producer/arbiter separation** is enforced at the row level (`produced_by`), not by
  infrastructure identity — cheap to enforce, sufficient given the HMAC already binds
  production to a run credential.
- **Verification records inform, evidence gates.** The two systems are kept
  intentionally separate; the only bridge is the explicit `recordEvidence` opt-in.
- **Fail-open where honest, fail-closed where cryptographic.** Git promotion and
  verification recording fail open (never crash an otherwise-good outcome); digest,
  signature, ownership, and freshness checks fail closed.

## 9. Extension points

- New evidence type: extend `EvidenceType` (`types.ts:174`); if it should be gated or
  hashed, add it to (or keep it out of) `EXECUTABLE_EVIDENCE_TYPES` /
  `TOOL_OWNED_EVIDENCE_TYPES`, and mirror in the CLI's `VALID_EVIDENCE_TYPES`
  (`guildctl/commands/evidence.ts:6`). Schema migration follows the
  `ensureCharacterizationFixtureEvidenceType` pattern (`db/schema.ts:85`), which adds
  the enum value via a CHECK-constraint rebuild.
- New log producer: write a log anywhere under `.guild/evidence`, insert a row with a
  digest, and consumers find it via `output_path` — no registry changes needed.
- Stack packs: a new pack's `verify:` block automatically gains evidence capability by
  running through `runArtifactVerification` with `recordEvidence: true`.

## 10. Test coverage

- `migration/test/evidence-gate.test.ts` — approval/rejection transactions, latest
  arbitration decision visibility, evidence listing.
- `migration/test/evidence-runtime.test.ts` — `runVerify` minting signed runtime rows.
- `migration/test/evidence-characterization.test.ts` — capture, compare (match /
  mismatch / no-fixture throw), fixture staleness via content-hash tampering.
- `migration/test/drift-gate.test.ts` — freshness rejection after `auto-rework`, and
  recovery with fresh evidence.
- `migration/test/arbiter-gate.test.ts` — independence, wrong-status, missing/
  failing-evidence branches of `canApproveArtifact`, including run/token validation.
- `migration/test/warden.test.ts:98` — evidence directories survive warden snapshots.
