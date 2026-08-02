# Contract: guildctl CLI

**Interface**: `guildctl <command>` — the operator-facing orchestrator.

**Output discipline**: Constitution VI requires silence-first output — one final summary per run,
detail available through the registry and run logs. This contract adds exactly **one** unconditional
runtime line per phase run (the resolved provider/model line), followed only when needed by a bounded
conditional divergence block. Everything else lives inside the existing summary or on a command the
operator explicitly invoked.

---

## A. `guildctl preflight` — NEW (FR-011–FR-019)

```text
guildctl preflight [--offline] [--json] [--budget-seconds <n>]
```

Validates the runtime path a phase run will actually take, then reports what it resolved.

### Stages

Executed in order, sharing one wall-clock budget, stopping at the first failure:

| # | Stage id | What it asserts | Fails when |
|---|----------|-----------------|------------|
| 1 | `resolution` | harness, provider base URL, model, and credential variable resolve through `resolveAgentLaunch()` — the same function the runner calls | any value missing or unresolvable; harness name unknown; credential variable unset |
| 2 | `authorization` / `model-availability` / `response` | one minimal end-to-end model request through the resolved launch path, asserting a **non-empty completion in the response body** | see status mapping below |

**Stage 1 is the FR-011 commitment**: preflight and the runner share one resolver, so preflight
cannot drift from what a run does. A duplicate resolution path in preflight would violate this
contract even if it produced the same answer today.

**Stage 2 is the FR-012 commitment**: proving the adapter *starts* is explicitly not a pass. Today's
`checkHarness()` `--version` probe does not satisfy the end-to-end request and cannot be reused as the
preflight verdict. The adapter and provider request are one live path under one shared budget; preflight
must not bill two completions for separate harness and provider stages.

### Provider status → stage mapping (FR-016)

| Provider response | Stage reported | Verdict |
|-------------------|----------------|---------|
| `401`, `403` | `authorization` | fail |
| `429`, or a body indicating exhausted quota | `authorization` | fail |
| `404`, or a model-not-found body | `model-availability` | fail |
| network error, malformed body, empty completion | `response` | fail |
| budget elapsed | `response` | fail, citing the elapsed budget |
| `2xx` with non-empty completion | — | pass |

Every failure includes the provider-reported reason when one is available. An unknown model is
reported distinctly from an authorization failure (spec edge case).

### Verdicts

Three verdicts, not two:

| Verdict | Meaning | Exit |
|---------|---------|------|
| `pass` | every stage asserted successfully | `0` |
| `fail` | any stage failed | `1` |
| `unvalidated` | `--offline`: live stages skipped and labelled, never passed | `0` |

`unvalidated` exists so that no green-check script can read an offline run as a pass (FR-018 and the
spec's "must not report a plain green"). It is distinguished by the verdict string, not the exit code.

**Fail-closed rule (FR-015)**: whenever the resolved path cannot obtain a model response —
unreachable endpoint, rejected or inactive credential, exhausted quota, unknown model — the verdict is
`fail`. Never `pass`, never a warning.

### Budget (FR-017)

The live portion completes within a bounded budget, default **30 seconds**, overridable with
`--budget-seconds`. On elapse the verdict is `fail` citing the elapsed budget — preflight never hangs.

### Output

```text
$ guildctl preflight
✗ preflight FAILED
  stage:     authorization
  harness:   opencode (package/harness/opencode.mjs)
  provider:  https://example-private.invalid/v1
  model:     pvt/hy3-tencent
  credential: EXAMPLE_PRIVATE_API_KEY (set, rejected by provider)
  reason:    provider returned 401: "Your credential is inactive"
  elapsed:   1.4s
```

```json
{
  "verdict": "fail",
  "failed_stage": "authorization",
  "resolved": { "harness": "opencode", "harness_command": "package/harness/opencode.mjs",
                "provider": "https://example-private.invalid/v1", "model": "pvt/hy3-tencent",
                "credential_env": "EXAMPLE_PRIVATE_API_KEY" },
  "divergences": [ { "setting": "model.model", "declared": "pvt/hy3-tencent", "resolved": "pvt/grok-4.5" } ],
  "stages": [ { "id": "resolution", "status": "pass" },
              { "id": "authorization", "status": "fail", "provider_reason": "…" } ],
  "elapsed_ms": 1412
}
```

**Reporting rules**:

- `resolved` is always printed, on pass and on fail (FR-013).
- `divergences` is reported **even when the live check succeeds** (FR-014), naming the setting, the
  declared value, and the resolved value.
- The launch environment is private process input, not part of the resolved report projection; callers
  MUST use the secret-free `ResolvedRuntimeReport` rather than serializing `ResolvedRuntimeConfig`.
- The credential **setting name** is always printed; the credential **value** never is, in any mode,
  on any path (FR-019). The value may exist only in the private process launch environment; it never
  enters the resolved report object or any output payload.

## B. `guildctl doctor` — CHANGED

Keeps its config, prompt-pack, git, and pipeline-state checks. Its three model/harness/credential
checks are replaced by delegation to `preflight`, so a green doctor implies a validated runtime path.
`doctor` runs preflight in offline mode when invoked with `--offline`, and reports the
`unvalidated` verdict rather than a tick.

---

## C. `guildctl limits` — NEW (FR-029)

```text
guildctl limits [--phase <phase>] [--json]
```

Reports each phase's effective limits, their sources, and the precedence order — **before** a run, so
an operator never has to trigger a termination to learn which knob governs.

```text
$ guildctl limits
Precedence (first match wins): per-phase setting → project configuration → built-in default

phase          kind         effective  knob                          source              floor
code-writing   ceiling      20m        GUILDCTL_CODE_TIMEOUT_MINS    per-phase-setting   —
code-writing   inactivity   120s       agent_limits.inactivity_…     project-config      —
review         ceiling      5m         GUILDCTL_REVIEW_TIMEOUT_MINS  per-phase-setting   applied (requested 2m)
```

**Rules**:

- `effective` is what will actually be enforced. When an enforced minimum raised the requested value,
  `floor` reads `applied` and states the requested value (spec edge case: "the effective value
  actually applied is reported, not the requested one").
- `knob` is the setting an operator changes to move `effective`. It is read from the same descriptor
  the enforcement uses.
- The precedence order shown is the one the resolver implements, printed identically for every phase.

---

## D. Termination messages — CHANGED (FR-027, FR-028)

A limit message names the knob that governed the limit that **fired**, its effective value, and the
source of that value.

```text
[guildctl] code-writer killed: CEILING after 1200s
           knob:   GUILDCTL_CODE_TIMEOUT_MINS = 20m (source: per-phase setting)
           note:   this overrides agent_limits.ceiling_seconds; changing that setting has no effect here
```

**Binding rule (FR-028)**: the message reads `knob`, `effectiveValueMs`, and `source` from the same
`EffectiveLimit` descriptor that enforcement used. It is therefore structurally impossible for the
message to name a knob that does not change the observed limit. The current message — which always
says "raise `agent_limits.ceiling_seconds`" even when a per-phase constant fired and overrides it —
violates this contract.

The same rule applies when the **inactivity** limit fires: the message names the inactivity knob and
its source (spec edge case).

**Not changed**: which knobs exist. The spec's Assumptions require the existing per-phase knobs and
the project-configuration ceiling to remain available; this contract fixes only which one is named
and makes the precedence discoverable.

---

## E. Attempt close-out summary — CHANGED (FR-007, FR-030–FR-032, FR-039)

Every agent attempt's closing summary states, in one place:

```text
[guildctl] code-writer attempt closed — NO PROGRESS
  files written:   0 (source: warden-snapshot)
  artifact status: migrated → migrated (unchanged)
  verification:    unverified (tree-incomplete; method: java-per-artifact)
  claim:           released, retryable
  process cleanup: clean (0 survivors)
  provider budget: consumed — 41,203 tokens; this spend is not recovered
  terminal reason: killed at CEILING (GUILDCTL_CODE_TIMEOUT_MINS = 20m)
```

**Rules**:

- All required facts appear together, including the artifact's verification state, method, and reason,
  so FR-007 and FR-030's questions are answerable from the summary alone, without opening logs or
  querying the registry (SC-010). Verification is shown separately from migration status and may be
  `verified`, `unverified`, or `verification-failed`.
- An attempt that wrote no files and did not advance status **MUST NOT** carry a success-equivalent
  label. `NO PROGRESS` and `released, retryable` are distinct statements: the first says the attempt
  did not succeed, the second says the work is safe to retry (FR-031).
- The provider-budget line states explicitly that consumed budget is not recovered (FR-032).
- The claim disposition and the process-cleanup outcome are printed **together**, always. A released
  claim is never printed alone, so it can never be read as evidence that spending stopped (FR-039).
- When cleanup fails, the line reads `process cleanup: FAILED — 1 survivor (pid 48211)`, and the
  claim is still reported as released (claim recoverability outranks cleanup completeness).

The same facts are written to the registry by `finish-run` in the same cleanup path (FR-033).

---

## F. Process-tree termination — CHANGED (FR-035–FR-038)

Terminating an attempt terminates **everything that attempt started**:

1. **graceful** — signal the whole process group (POSIX `SIGTERM` to `-pgid`; Windows
   `taskkill /PID <pid> /T`);
2. **forced** — after a bounded grace period (`agent_limits.termination_grace_seconds`, default 5s),
   escalate (`SIGKILL` to `-pgid`; Windows `taskkill /F /T`);
3. **confirm** — verify no process from that attempt remains (POSIX `kill(-pgid, 0)` → `ESRCH`;
   Windows `tasklist` filtered by PID);
4. **report** — any survivor is a cleanup failure naming each surviving PID. A survivor is never
   omitted and never treated as an acceptable outcome.

An attempt that was between processes at termination reports `clean (0 survivors)` — success, not an
error (spec edge case). A survivor that cannot be terminated at all (permission or platform limit) is
reported as a cleanup failure with the survivor identified, and the claim is still released.

---

## G. Run-start line — NEW (FR-024, FR-025)

Exactly one unconditional runtime line is emitted at the start of every run:

- For manual phase commands (`inventory`, `plan`, `migrate`, `review`, `remediate`, and
  `benchmark`), the phase command emits it once at phase entry, before any agent spawn. This keeps
  the emission at the phase-run seam even when tests inject a replacement `spawnAgent`.
- For autonomous queues, `commands/auto-run.ts` emits it once before queue dispatch. The per-artifact
  `commands/auto.ts`, `supervisor/queue.ts`, and shared `spawnAgent` helper emit nothing.

```text
[guildctl] runtime: harness=opencode provider=https://example-private.invalid/v1 model=pvt/hy3-tencent
```

When a resolved value diverges from the project configuration declaration, the same line states it:

```text
[guildctl] runtime: harness=opencode provider=https://example-private.invalid/v1 model=pvt/grok-4.5
           divergence: model.model declared pvt/hy3-tencent, resolved pvt/grok-4.5 (source: ambient environment)
```

If multiple environment variables diverge, the runtime line is followed by a bounded divergence block
with one entry per variable. The block is conditional; it is omitted when there is no divergence.

Credential values never appear on this line. When a project `.env` is absent entirely, the line is
still printed (spec edge case).

---

## H. `guildctl status` — CHANGED (FR-008, FR-034)

Status output gains the verification split and the repeat-waste count:

```text
Verification:  118 verified · 141 unverified · 12 verification-failed
               (list with: registry list-verification --state <state>)
Repeat waste:  3 artifact(s) with ≥2 no-progress attempts
               (list with: registry show-no-progress-attempts --min 2)
```

Both are `COUNT`-shaped queries so they stay fast on ~3,000-artifact registries, matching the sizing
the existing pipeline-state checks already assume. The operator obtains the split from this single
status query (SC-005) and can list the artifacts in any state from the named command.
