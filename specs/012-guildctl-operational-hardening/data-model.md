# Phase 1 Data Model: guildctl Operational Hardening

This feature is almost entirely behavioral (fixing how existing entities are used), not a new domain
model. One new entity is introduced (Verify Slot); the rest of this document describes how existing
registry entities are read or written differently by these fixes.

## New Entity

### Verify Slot (US5 / #151)

A bounded lease granting permission to run one verify subprocess at a time, mirroring the existing
`ArtifactClaim` lease shape in `migration/registry/commands/claim.ts`.

| Field | Type | Notes |
|---|---|---|
| `slot_id` | opaque string (UUID, no dashes) | Primary key, generated the same way as `claim_id` (`makeOpaqueId()`). |
| `run_id` | string | The run holding this slot; foreign-key-equivalent to `runs.run_id`. |
| `artifact_id` | string | The artifact this verify invocation is checking; informational, for observability/debugging. |
| `acquired_at` | timestamp | Set on successful acquisition. |
| `lease_expires_at` | timestamp | `acquired_at` + a bounded ceiling (reuse `verification.budget_seconds` from existing config, or a small fixed multiple of it) so a crashed holder doesn't permanently consume a slot. |
| `released_at` | timestamp, nullable | Set when the holder releases the slot on process settle; `NULL` while held. |

**Invariants**:
- At most `verification.max_concurrent` rows may have `released_at IS NULL` and
  `lease_expires_at > now()` at any moment — enforced by the acquire function's own atomic
  insert-if-under-limit check (same transactional pattern `claimArtifactById` already uses to
  enforce one-claim-per-artifact).
- A slot with `lease_expires_at <= now()` and `released_at IS NULL` is stale and MUST be treated as
  available for reclamation by the next acquire attempt (mirrors existing lease-expiry reconciliation
  for artifact claims).

**State transitions**: `(no row)` → `held` (acquired_at set, released_at NULL) → `released`
(released_at set) — a strictly linear lifecycle per slot row; a new row is created for each
acquisition rather than a row being reused across holders.

## Modified Entity Usage (no schema change)

### Artifact / Claim (`artifacts`, `claims` tables)

- **US3 (#155)**: `blocked` is added to the set of statuses `--resume` will accept when reclaiming an
  artifact via `claimArtifactById`. No new column; this is a change to which existing `status` values
  a particular call site treats as eligible.
- **US4 (#156)**: The existing `expected_output_paths` column on a claim (already populated per
  `claim.ts:69`) becomes an input to a new check performed before a migrate session is allowed to
  write `status = "migrated"`: if the warden's restore for this run touched a path within
  `expected_output_paths`, the write is redirected to the existing failed/needs-redelivery status
  instead. No new column.

### Run Operator Credential (`run_operator_credentials` table)

- **US1 (#153)**: No schema change. `createRunOperatorCredential` — already capable of minting a
  credential for any existing `runs` row — is now also invoked from the `arbitrate` CLI path (via
  `runArbitrate`) for a manual, single-command-scoped run, rather than only from
  `supervisor/loop.ts`. If no run exists yet for a standalone `arbitrate` invocation, one is created
  first (reusing whatever run-creation helper `auto`'s supervisor already uses to create its own runs)
  so `createRunOperatorCredential`'s existing `runs` row precondition is satisfied.

### Remediation confirmation signal (US2 / #154)

A new piece of state is needed so the supervisor loop can distinguish "remediation still trying" from
"remediation already confirmed no defect, stop looping." Two shapes were considered:

1. **A new `event` type** (e.g. `remediation-confirmed-no-defect`) appended via the existing
   `appendEvent` mechanism (already used throughout `commands/evidence.ts` and elsewhere) — read by
   `supervisor/loop.ts` on the next blocked-verify decision point.
2. **A new column on the artifact or claim row** recording this boolean/timestamp directly.

**Decision**: prefer (1), a new event type, consistent with the constitution's Principle III framing
that all migration state — "artifacts, classifications, waves, dependencies, claims, runs, events,
evidence" — belongs in the registry's existing state vocabulary, and events are the lowest-friction
way to add a new signal without a schema migration touching a hot table (`artifacts`/`claims`). The
supervisor loop already reads prior events/evidence to make its next-action decision at each blocked
branch (lines noted in research.md), so consuming one more event type is additive, not a new read
path.

## Entity Relationship Summary

```text
Run ──< RunOperatorCredential        (existing; US1 reuses)
Run ──< VerifySlot                    (new; US5)
Artifact ──< ArtifactClaim ──< expected_output_paths   (existing; US4 reads it)
Artifact ──< Event (remediation-confirmed-no-defect)   (new event type; US2)
Artifact ── status ∈ {..., blocked, migrated, ...}      (US3 widens resume-eligible set; US4 gates a write)
```

No fixes in this feature require a new top-level entity beyond Verify Slot, and none require removing
or renaming an existing entity or column.
