# Phase 1 Data Model: Truthful Run State

**Feature**: `001-truthful-run-state` | **Date**: 2026-07-31

**Source**: entities from [spec.md](./spec.md) § Key Entities, resolved against the decisions in
[research.md](./research.md). The authoritative DDL delta is
[contracts/registry-schema.md](./contracts/registry-schema.md); this document explains the entities,
their rules, and their state transitions.

**Storage**: the existing per-workspace SQLite registry (WAL). Three entities are persisted as new
schema; three are derived read-models over rows that already exist; two are in-memory value objects
produced by a resolver and never stored.

| # | Entity | Kind | Backing |
|---|--------|------|---------|
| 1 | Artifact Verification Record | persisted | new table `artifact_verifications` |
| 2 | Attempt Outcome | persisted | new columns on `runs` |
| 3 | Blocked Condition | persisted | existing `artifact_tags` + `events` |
| 4 | Verification Scope | derived | `artifact_claims` + `source_dependencies` + `dependencies` |
| 5 | Repeat-No-Progress Condition | derived | query over `runs` ⋈ `artifact_claims` |
| 6 | Agent Context Record | derived | existing `agent_context` + filesystem resolution |
| 7 | Resolved Runtime Configuration | value object | `resolveAgentLaunch()` |
| 8 | Effective Limit | value object | `resolveLimit()` |
| 9 | Environment Value Divergence | value object | environment loader |

---

## 1. Artifact Verification Record *(persisted — new table)*

One row per artifact, carrying the latest verification outcome. Distinct from, and never a substitute
for, the artifact's migration status.

| Field | Type | Rules |
|-------|------|-------|
| `artifact_id` | TEXT, PK, FK → `artifacts(id)` ON DELETE CASCADE | one current record per artifact |
| `state` | TEXT NOT NULL | `CHECK (state IN ('verified','unverified','verification-failed'))` |
| `method` | TEXT NOT NULL | how it was determined; e.g. the stack check id, or `none` when not attempted |
| `reason` | TEXT | machine-readable slug; **required** when `state <> 'verified'`, must be NULL-able but never empty for the other two states |
| `detail` | TEXT | human-readable failure detail; secrets redacted before write |
| `scope_json` | TEXT | JSON array of the paths the check actually covered (audit trail for FR-003/FR-005) |
| `budget_ms` | INTEGER | effective budget applied, so FR-004's "effective value is reported" is answerable from the row |
| `duration_ms` | INTEGER | wall-clock the check consumed |
| `run_id` | TEXT, FK → `runs(run_id)` ON DELETE SET NULL | the attempt that determined it |
| `determined_at` | TEXT NOT NULL DEFAULT `datetime('now')` | FR-002's "time it was determined" |

**Reason vocabulary** (closed set — the machine-readable half of FR-002):

| Reason | Applies to | Meaning |
|--------|-----------|---------|
| `not-attempted` | unverified | no record exists; the read-model default |
| `no-stack-check` | unverified | active stack pack declares no `verify:` block |
| `tree-incomplete` | unverified | check could not run because declared dependencies are not yet migrated (FR-006) |
| `budget-exhausted` | unverified | wall-clock budget elapsed (FR-004) |
| `agent-reported-unverifiable` | unverified | the agent stated it could not verify its own output (FR-007) |
| `check-failed` | verification-failed | the bounded check ran and did not pass (FR-003) |
| `check-error` | verification-failed | the check could not execute (missing tool, malformed template) |

**Validation rules**:

- `state = 'verified'` requires a non-null `duration_ms` and a non-empty `scope_json` — a verified
  claim must be able to say *what* it covered.
- `reason` MUST be non-empty when `state <> 'verified'`, and MUST be one of the vocabulary values.
- Writes are last-write-wins per artifact (`ON CONFLICT (artifact_id) DO UPDATE`). History is not
  kept in this table; the audit trail is the `events` row written alongside.
- `detail` passes through the existing `redactSecrets()` before persistence.

**Read-model default (FR-002)**: consumers MUST read verification through the helper that
`LEFT JOIN`s this table and coalesces a missing row to
`{ state: 'unverified', reason: 'not-attempted', method: 'none' }`. No backfill of existing
workspaces is required or performed.

**State transitions**:

```text
        (no row)
           │  read-model coalesces to unverified/not-attempted
           ▼
      unverified ──────────► verified              check ran, passed, in budget
           │  ▲                  │
           │  │                  └──► unverified   re-migration invalidates (see below)
           │  └───────────────────────┐
           ▼                          │
   verification-failed ───────────────┘            re-attempt after rework
```

- Any state may transition to any other; the record always reflects the latest determination.
- **Invalidation rule**: when an artifact re-enters `in-progress` or `needs-rework`, its verification
  record is reset to `unverified` / `not-attempted`. This mirrors the constitution's content-bound
  evidence rule (Principle I) — a verification of superseded output must not survive the change.
- Verification state never drives a migration status transition, and no migration status transition
  is gated on it (FR-006, spec Out of Scope).

**Relationships**: 1:1 with `artifacts`; N:1 with `runs`. **Not** related to `acceptance_evidence` —
research R11 fixes these as separate records, and arbitration reads only the latter.

---

## 2. Attempt Outcome *(persisted — new columns on `runs`)*

One agent attempt's honest close-out, so FR-030 and FR-033 are answerable from recorded state without
reading logs. A run already *is* an attempt (`runs.run_id` ⋈ `artifact_claims.run_id`), so no new
table is introduced.

| Field | Type | Rules |
|-------|------|-------|
| `files_written_count` | INTEGER | count of files the attempt wrote; `0` is a meaningful value, distinct from NULL (not determined) |
| `files_written_source` | TEXT | `warden-snapshot` \| `git-diff` \| `unavailable` — which mechanism produced the count (research R10) |
| `status_from` | TEXT | artifact status when the attempt began |
| `status_to` | TEXT | artifact status after cleanup; equal to `status_from` means no advance |
| `budget_consumed` | INTEGER | `CHECK (budget_consumed IN (0,1))`; 1 when any provider tokens were recorded |
| `cleanup_outcome` | TEXT | `clean` \| `survivors` \| `not-applicable` |
| `survivor_pids` | TEXT | JSON array of PIDs that outlived termination; NULL unless `cleanup_outcome = 'survivors'` |
| `outcome_label` | TEXT | `CHECK (outcome_label IN ('succeeded','released-retryable','no-progress','failed'))` |

**`outcome_label` derivation** (FR-031 — the label is computed, never chosen by the agent):

| Condition | Label |
|-----------|-------|
| exit 0, status advanced, warden clean | `succeeded` |
| terminated at a limit, `files_written_count = 0`, `status_from = status_to` | `no-progress` |
| terminated at a limit with `files_written_source = 'unavailable'` | `released-retryable` |
| claim released for retry, some work or a recoverable failure | `released-retryable` |
| non-zero exit with a warden violation or systemic error | `failed` |

**Validation rules**:

- `no-progress` requires `files_written_count = 0` **and** `status_from = status_to`. A terminated
  attempt that wrote files is `released-retryable`, not `no-progress`.
- `succeeded` MUST NOT be assigned when `status_from = status_to`, which is what removes the
  success-equivalent label from a no-progress termination.
- `cleanup_outcome = 'survivors'` MUST carry a non-empty `survivor_pids`, and MUST be reported next
  to the claim disposition (FR-039) — a released claim is never printed alone.
- All columns are nullable or defaulted so pre-existing `runs` rows and every current consumer
  (`listRuns`, dashboard, `serve`) keep working.

**Relationships**: 1:1 with `runs`; N:1 to `artifacts` through `artifact_claims`.

---

## 3. Blocked Condition *(persisted — existing tables)*

A named condition on an artifact identifying an out-of-scope path that blocked the work (FR-010).

- **Name**: `artifact_tags` row with tag `blocked:out-of-scope-path`.
- **Payload**: an `events` row of the existing type `filesystem-violation`, whose `event_data` JSON
  carries `{ "out_of_scope_paths": [...], "claim_id": "...", "run_id": "..." }`.

**Rules**: the warden's existing restore-and-fail behaviour is unchanged; this record is purely
additive. The tag is cleared when the artifact next completes an attempt without an out-of-scope
blockage. Recording this condition MUST NOT add the path to any allow-list — broadening write
authorization is out of scope.

---

## 4. Verification Scope *(derived — value object)*

The unit a bounded check is allowed to cover. Computed per attempt, recorded into
`artifact_verifications.scope_json`, never stored on its own.

```text
VerificationScope {
  artifactId:      string
  ownOutputPaths:  string[]   // artifact_claims.expected_output_paths for the active claim
  dependencyPaths: string[]   // output paths of one-hop declared dependencies
  workspaceRoot:   string
}
```

**Construction rules**:

- `ownOutputPaths` comes from the claim's recorded `expected_output_paths` (already produced by
  `deriveExpectedOutputPaths`). No filesystem discovery.
- `dependencyPaths` is one hop only — `source_dependencies` (signals `import`, `inheritance`,
  `manual`) plus `dependencies` — never the transitive closure (research R3).
- Every path is asserted inside `workspaceRoot` before use; a path that resolves outside is dropped
  and recorded as `check-error`. This is the enforcement point for FR-005.
- Explicitly **not** the whole modernized tree; nothing in scope construction consults `modern/` as
  a whole.
- If any one-hop dependency artifact has not reached a migrated-or-later status, the check is not run
  and the record is written as `unverified` / `tree-incomplete` (FR-006). The artifact still
  advances.

---

## 5. Repeat-No-Progress Condition *(derived — query)*

FR-034's counted, queryable condition. Defined as a query, not a stored counter, so it cannot drift
from the rows it summarizes:

```text
count of runs r joined to artifact_claims c on c.run_id = r.run_id
where r.outcome_label = 'no-progress'
group by c.artifact_id
```

Exposed through the registry CLI and surfaced in status output. An artifact with a count ≥ 2 is
reported as a repeat-waste condition for operator review.

---

## 6. Agent Context Record *(derived — existing table + resolution)*

Backed by the existing `agent_context` table (`artifact_id`, `agent`, `file_path`, `summary`,
`updated_at`), which is **unchanged**. What is new is the resolved response (FR-040–FR-043):

```text
ContextResponse {
  form:   "file" | "summary" | "none"
  path?:  string   // present when form = "file"; resolves as written on this host
  content?: string // file contents (form = "file") or stored summary (form = "summary")
  reason?: string  // present when form = "none": "no-context-record" | "no-locatable-file-or-summary"
  fallback?: string // present when form = "none": the documented fallback to use instead
}
```

**Resolution rules** (deterministic, no filesystem search):

1. normalize stored `file_path` separators for the host; 2. resolve relative paths against the
workspace root; 3. try the canonical layout `migration/artifacts/<slug>/context/<agent>.md` rebuilt
via `idToSlug`; 4. fall back to `summary`; 5. otherwise `none`.

**Validation rules**: a `summary` that is empty or whitespace-only is treated as **absent** (spec
edge case), yielding `form: "none"`. `form` is always present, so a caller never infers which form it
received.

---

## 7. Resolved Runtime Configuration *(value object)*

What a run will actually use, as opposed to what project configuration declares. Produced by the
single shared `resolveAgentLaunch()` used by both the runner and preflight (FR-011).

```text
ResolvedRuntimeConfig {
  harness:        { name, command, targetCommand, source: "environment" | "config" }
  providerBaseUrl: string
  model:          string
  credentialEnv:  string        // variable NAME only; the value is never carried here
  agentEnv:       Record<string,string>   // exactly the env the agent process receives
  divergences:    ConfigDivergence[]
}

ConfigDivergence { setting, declaredValue, resolvedValue }
```

**Rules**: the credential *value* never enters this object, so it cannot leak into a log or a JSON
dump (FR-019). `divergences` is computed whenever a resolved value differs from the project
configuration declaration, and is reported even when the live check succeeds (FR-014, FR-025).

---

## 8. Effective Limit *(value object)*

Per phase and limit kind, the limit that will actually be enforced (FR-027–FR-029).

```text
EffectiveLimit {
  phase:            string
  kind:             "inactivity" | "ceiling"
  knob:             string   // the knob an operator changes, e.g. "GUILDCTL_CODE_TIMEOUT_MINS"
  effectiveValueMs: number   // what is enforced
  requestedValueMs: number   // what was asked for, before any floor
  source:           "per-phase-setting" | "env-override" | "project-configuration" | "built-in-default"
  floorApplied:     boolean
  precedenceOrder:  string[] // same order for every phase, for display
}
```

**Rules**:

- The termination message reads `knob`, `effectiveValueMs`, and `source` from the same object the
  enforcement used, which is what makes FR-028 structural: the message cannot name a knob that does
  not govern.
- `floorApplied = true` when `effectiveValueMs > requestedValueMs` because of the phase's enforced
  minimum; floors are 5 minutes for analyze/test/code-writing/remediation and 1 minute for review/inventory.
  The report states the enforced value, not the requested one (spec edge case). Unparseable values
  normalize to the built-in default before floor application.
- The record is display-only and never persisted.

---

## 9. Environment Value Divergence *(value object)*

One variable defined in more than one source with differing values (FR-022, FR-023).

```text
EnvDivergence {
  variable:    string
  projectValue: string   // "<redacted>" when secret
  ambientValue: string   // "<redacted>" when secret
  winner:      "project-file" | "ambient"
  secret:      boolean
}
```

**Rules**:

- Computed for every run, **before** either side is applied, and reported regardless of which side
  won and regardless of whether the ambient opt-in is active.
- `secret` is decided by the existing `isSensitiveEnvName` predicate; when true, both values are
  replaced with `<redacted>` while the variable name and winner are still reported.
- Variables present in only one source are not divergences and are not reported.
- Never persisted — the divergence report is run output, not registry state.

---

## Entity relationship summary

```text
artifacts ──1:1── artifact_verifications          (new; state/method/reason/time)
    │                      │
    │                      └──N:1── runs          (which attempt determined it)
    │
    ├──1:N── artifact_tags                        (blocked:out-of-scope-path condition)
    ├──1:N── events                               (filesystem-violation payload)
    ├──1:N── artifact_claims ──N:1── runs         (attempt outcome columns live on runs)
    ├──1:N── source_dependencies / dependencies   (one hop → Verification Scope)
    └──1:N── agent_context                        (unchanged; resolution is new)

acceptance_evidence ── unchanged, and deliberately unlinked to artifact_verifications
                       (arbitration gate reads only this; see research R11)
```
