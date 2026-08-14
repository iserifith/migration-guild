# Phase 1 Data Model: Characterization Test Automation

No new tables or top-level entities are introduced. This feature extends an existing entity
(`AcceptanceEvidence`) with a new `evidence_type` value and defines two derived, non-persisted
shapes used at the API boundary (capture input, comparison result).

## Extended Entity: `AcceptanceEvidence` (existing, `migration/registry/types.ts`)

| Field | Type | Notes for `characterization-fixture` rows |
|---|---|---|
| `evidence_id` | string | Unchanged — generated as for any evidence row. |
| `artifact_id` | string | The legacy/target artifact the fixture characterizes. |
| `run_id` | string \| null | Set to the capturing run's ID, following the `verify` pattern (`startRun`/`finishRun`). |
| `produced_by` | string | Agent/role that ran the capture, e.g. `"guildctl-capture-fixture"`. |
| `evidence_type` | `EvidenceType` | New value: `"characterization-fixture"` (see enum extension below). |
| `command` | string \| null | The seam invocation (test command/target) that was executed. |
| `exit_code` | number \| null | Exit code of the seam invocation. |
| `pass` | 0 \| 1 | For a *captured* fixture row: whether the seam ran cleanly. For a *comparison* fixture row (Decision 4): whether candidate output matched the fixture. |
| `output_path` | string \| null | Path to the full fixture JSON file under `.guild/evidence/characterization/`. |
| `output_excerpt` | string \| null | Short human-readable excerpt (e.g. first mismatched field, or "seam ran cleanly, N assertions captured"). |
| `content_sha256` | string \| null | Hash of the captured output (FR-004) / hash of the compared candidate output for a comparison row. |
| `authenticity` | string \| null | Signed as for `runtime` evidence, since capture is verifier/tool-owned, not caller-asserted (Decision 1). |

No new columns. No DB migration beyond widening the TypeScript union — the SQLite column
storing `evidence_type` is untyped text (confirmed: no `CHECK` constraint exists in
`migration/registry/db/schema.ts`), so this is purely an application-level, not
schema-level, change.

## New enum member: `EvidenceType` (`migration/registry/types.ts`)

```
export type EvidenceType =
  | "runtime"
  | "test-command"
  | "build-command"
  | "static-check"
  | "review-verdict"
  | "benchmark-result"
  | "characterization-fixture";   // new
```

Call sites requiring the mechanical extension (per spec Assumptions and research Decision 1/2):

- `migration/registry/types.ts` — the union above.
- `migration/registry/commands/evidence.ts` — `EXECUTABLE_EVIDENCE_TYPES` gains
  `"characterization-fixture"` alongside `"runtime"`, and `addAcceptanceEvidence()`'s guard that
  currently rejects caller-asserted `"runtime"` evidence is extended to also reject
  caller-asserted `"characterization-fixture"` evidence (must be recorded by the capture
  command, not `evidence add`).
- `migration/guildctl/commands/evidence.ts` — `VALID_EVIDENCE_TYPES` (the `evidence add`
  allowlist) is *not* extended with the new type (per Decision 1 — fixtures aren't asserted via
  `evidence add`); this file is touched only if its CLI help text enumerating evidence types is
  updated for discoverability.

## Non-persisted shape: Fixture file (`.guild/evidence/characterization/<evidence_id>.json`)

Referenced by `output_path`, not itself a registry entity:

```
{
  "seam": "string — identifies the test seam invoked (e.g. a test name/target)",
  "input": "the concrete input value(s) supplied to the seam",
  "output": "the concrete output the legacy code produced",
  "capturedAt": "ISO 8601 timestamp",
  "contentSha256": "hash of `output`, duplicated from the evidence row for standalone readability"
}
```

Validation rules:
- `seam` MUST be non-empty (FR-004: every fixture must identify what was invoked).
- `output` MUST be present when `pass = 1`; a failed capture (seam errored) may omit `output`
  but MUST still record `exit_code` and an `output_excerpt` explaining the failure (FR-005).
- `contentSha256` MUST equal the SHA-256 of the serialized `output`, matching the same
  content-hash convention `checkEvidenceFreshness()` already enforces for other evidence types.

## Non-persisted shape: Comparison result (Decision 3/4, returned by `compareToFixture()`)

```
{
  "match": boolean,
  "diff": "present only when match is false — human-readable description of what differed"
}
```

Not stored directly; a comparison run persists as a new `characterization-fixture` evidence row
(Decision 4) with `pass` set from `match` and `output_excerpt` set from `diff` when present.

## State / Lifecycle

- A `characterization-fixture` evidence row is immutable once written (consistent with every
  other evidence type — evidence is append-only; see spec FR-010 and Story 1 Scenario 4).
- `checkEvidenceFreshness()` treats the *latest* `characterization-fixture` row for an artifact
  as the one relevant to a freshness check, exactly as it already does for `runtime` and
  `static-check` rows — no new state machine.
