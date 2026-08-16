# Contract: Registry CLI

**Interface**: `node migration/dist/registry/cli.js <command>` — the command surface agents in
installed workspaces use, and the one guildctl and Mission Control read through.

**Conventions**: exit `0` success, `1` error, `2` not found. `--json` emits one JSON document on
stdout and nothing else. Existing commands keep their current behaviour unless marked CHANGED.

---

## A. Verification state (FR-001–FR-009)

### `set-verification` — NEW

Records the outcome of a bounded per-artifact check.

```text
set-verification --id <artifact-id> --state <verified|unverified|verification-failed>
                 --method <string> [--reason <slug>] [--detail <text>]
                 [--scope <json-array>] [--budget-ms <n>] [--duration-ms <n>]
                 [--run-id <id>] [--claim-token <token>] [--json]
```

| Rule | Behaviour |
|------|-----------|
| Authorization | Requires an active claim token or a valid run operator credential, exactly as status transitions do (Constitution III). A privileged-looking actor name does not bypass it. |
| `--reason` | **Required** when `--state` is not `verified`; must be in the closed vocabulary. Exit `1` otherwise. |
| `verified` | Requires `--duration-ms` and a non-empty `--scope`. Exit `1` otherwise. |
| `--detail` | Redacted through `redactSecrets()` before write. |
| Upsert | Last-write-wins per artifact; also appends an `events` row for the audit trail. |
| **Never** | Does not change `artifacts.status`. Does not write `acceptance_evidence`. Does not unlock any gate. |

**Reason vocabulary**: `not-attempted`, `no-stack-check`, `tree-incomplete`, `budget-exhausted`,
`agent-reported-unverifiable`, `check-failed`, `check-error`.

### `get-verification` — NEW

```text
get-verification --id <artifact-id> [--json]
```

Always returns a record, even when no row exists (FR-002):

```json
{
  "artifact_id": "ART-0042",
  "state": "unverified",
  "reason": "not-attempted",
  "method": "none",
  "detail": null,
  "scope": [],
  "budget_ms": null,
  "duration_ms": null,
  "determined_at": null
}
```

Exit `2` only when the **artifact** does not exist. A missing verification row is exit `0` with the
coalesced default — this is the contract that makes "never blank or absent" true.

### `list-verification` — NEW

```text
list-verification [--state <state>] [--reason <slug>] [--limit <n>] [--json]
```

Lists artifacts by verification state; with no filter, returns the counts for all three states plus a
`total`. This is the query behind FR-008 and SC-005 — an operator obtains the verified / unverified /
verification-failed split from a single call, and can list the artifacts in any one state.

```json
{ "counts": { "verified": 118, "unverified": 141, "verification-failed": 12, "total": 271 },
  "artifacts": [ { "id": "ART-0042", "path": "modern/…", "state": "unverified", "reason": "tree-incomplete" } ] }
```

### Review and arbitration visibility (FR-009) — CHANGED

`get-artifact`, `show-status`, and `list-artifacts` gain `verification_state` and
`verification_reason` fields, read through the coalescing `LEFT JOIN`. Review and arbitration
consumers can therefore treat `unverified` and `verification-failed` as triageable conditions.

**Explicitly NOT granted**: verification state is **triage input only**. It cannot approve, cannot
substitute for `acceptance_evidence`, and cannot unlock a status transition. The arbiter gate is
unchanged — see [registry-schema.md](./registry-schema.md#4-acceptance_evidence-and-arbitration_decisions--unchanged-stated-for-completeness)
for the required regression test.

---

## B. Agent context retrieval (FR-040–FR-044)

### `get-context` — NEW

```text
get-context --id <artifact-id> --agent <agent-name> [--json]
```

Always returns usable context when a record exists, and always labels which form it returned. The
`form` discriminator is mandatory, so a caller never has to infer it.

**`form: "file"`** — the stored file was located on this host:

```json
{ "form": "file",
  "path": "/workspace/migration/artifacts/art-0042/context/analyze-agent.md",
  "content": "## Summary\n…" }
```

`path` resolves as written on the current host — a record written on another operating system
resolves here whenever the underlying file is present (FR-042).

**`form: "summary"`** — the file could not be located here, but a stored summary exists (FR-040):

```json
{ "form": "summary", "content": "…stored summary text…" }
```

**`form: "none"`** — neither a locatable file nor a non-empty summary (FR-043):

```json
{ "form": "none",
  "reason": "no-locatable-file-or-summary",
  "fallback": "Read the legacy source at legacy/<path> directly; no analysis context was recorded." }
```

`reason` is `no-context-record` when the artifact/agent pair has no row at all, and
`no-locatable-file-or-summary` when a row exists but yields nothing usable.

**Resolution rules** — deterministic, and performing **no filesystem search**:

1. normalize the stored `file_path`'s separators for the host (accept `\` and `/`);
2. resolve a relative path against the workspace root;
3. try the canonical layout `migration/artifacts/<slug>/context/<agent>.md`, rebuilt from the
   artifact id via `idToSlug`;
4. fall back to the stored `summary`;
5. otherwise `none`.

A `summary` that is empty or whitespace-only counts as **absent** (spec edge case) and yields `none`.

Exit `0` for all three forms — `none` is an answer, not an error. Exit `2` only when the artifact does
not exist.

### `get-context-path` — CHANGED (backward compatible)

Keeps its current signature and its stdout shape (a bare path). Now re-pointed at the same resolver,
so it emits a path that resolves on this host instead of the stored spelling. When only a summary is
available it exits `2` with a message naming `get-context` as the command that returns usable
content — it no longer prints a path that does not exist.

### Packaged agent guidance (FR-044) — CHANGED

Four shipped agent definitions call `get-context-path` today and leave path repair to the agent:
`package/agents/code-writer-agent.agent.md`, `test-writer-agent.agent.md`, `codegen-agent.agent.md`,
`test-agent.agent.md`. Each is updated to call `get-context` and consume the returned `content`
directly. The guidance MUST NOT instruct an agent to convert separators, search for the file, or
repair a stored location.

---

## C. Attempt outcomes (FR-030–FR-034)

### `finish-run` — CHANGED

Accepts the attempt-outcome fields so cleanup writes them in the same transaction that closes the
run (FR-033 — the questions must be answerable from recorded state without reading logs):

```text
finish-run --run-id <id> --exit-code <n> [--reason <text>]
           [--files-written <n>] [--files-written-source <warden-snapshot|git-diff|unavailable>]
           [--status-from <status>] [--status-to <status>]
           [--budget-consumed <0|1>] [--cleanup-outcome <clean|survivors|not-applicable>]
           [--survivor-pids <json-array>] [--outcome-label <label>]
```

All new flags are optional; omitting them reproduces today's behaviour exactly. `--outcome-label` is
validated against its domain, and `succeeded` is rejected when `--status-from` equals `--status-to`
(FR-031).

### `list-runs` — CHANGED

Emits the new columns in `--json` output. Existing fields and their meanings are unchanged.

### `show-no-progress-attempts` — NEW

```text
show-no-progress-attempts [--min <n>] [--artifact <id>] [--json]
```

FR-034's counted, queryable condition — attempts that consumed provider budget while producing
neither files nor a status advance, counted per artifact:

```json
{ "min": 2,
  "artifacts": [ { "artifact_id": "ART-0042", "path": "legacy/…", "no_progress_attempts": 3,
                   "last_terminal_reason": "code-writer killed: CEILING after 1200s" } ] }
```

Computed from `runs` ⋈ `artifact_claims`, never from a stored counter, so it cannot drift from the
rows it summarizes.

---

## D. Commands explicitly NOT changed

`claim`, `heartbeat-claim`, `release`, `reap-claims`, `reconcile-claims`, `set-artifact-status`,
`approve-companion`, and every evidence command keep their current semantics. This feature adds
recorded facts and corrects reporting; it does not touch the coordination mechanisms the constitution
enforces in code.
