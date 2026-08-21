# Events & Changelog: The Registry's Observability Surface

## Overview

Every meaningful thing that happens to an artifact in the Migration Guild is recorded twice, in two deliberately different mediums:

1. **The `events` table** — a structured, append-only SQLite log. Each row is a typed, agent-attributed, JSON-payload-carrying record (`migration/registry/registry_schema.sql`, `CREATE TABLE events`). This is the machine-readable audit trail consumed by `guildctl watch`, the `/api/events` HTTP endpoint, the UI, and a dozen analytical queries.
2. **The per-artifact `changelog.md`** — a human-readable Markdown file under `migration/artifacts/<slug>/changelog.md`, newest-entry-first, indexed by a small `changelogs` table. This is the narrative surface an operator reads.

The two are written by entirely separate modules and are **not** synchronized: `appendEvent` (`migration/registry/commands/events.ts:appendEvent`) writes only to SQLite; `appendChangelog` (`migration/registry/commands/changelog.ts:appendChangelog`) writes only to the filesystem + `changelogs` table. Nothing in the codebase calls both.

The `events` table schema (fresh DBs get it from `registry_schema.sql`; existing DBs are upgraded by the table-rebuild in `migration/registry/db/schema.ts:ensureRemediationNoDefectEventType`):

```sql
CREATE TABLE events (
    event_id     TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    ts           TEXT NOT NULL DEFAULT (datetime('now')),
    artifact_id  TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    type         TEXT NOT NULL CHECK (type IN (...39 types...)),
    agent        TEXT NOT NULL,
    model        TEXT,
    summary      TEXT NOT NULL,
    event_data   TEXT
);
```

Three indexes back the three access patterns: `idx_events_artifact` (per-artifact history), `idx_events_type` (type-filtered analytics like "count all `run-reaped`"), and `idx_events_ts` (the poller's timestamp cursor) — all created in `migration/registry/db/schema.ts:ensureRemediationNoDefectEventType` and in the base SQL.

## Event taxonomy

The canonical list lives in **two places that must stay in sync**: the TypeScript union `EventType` (`migration/registry/types.ts:~40-92`) and the SQL CHECK constraint (base schema + the rebuild function). `appendEvent` validates against a third copy, `VALID_EVENT_TYPES` (`migration/registry/commands/events.ts:5-46`). The schema test `migration/test/registry-schema-delta.test.ts:229` asserts the DDL contains new types (e.g. `'filesystem-violation'`).

| Type | Phase | Meaning | Emitted by |
|---|---|---|---|
| `planned` | Planning | Wave assignment | via generic `registry append-event` CLI |
| `claimed` | Claim/lease | Artifact claimed (pool or explicit id) | `claim.ts` raw INSERTs (`:623-639`, `:872-894`) |
| `claim-heartbeat` | Claim/lease | Lease renewed | `claim.ts:heartbeatClaim` (`:293-313`) |
| `claim-completed` | Claim/lease | Claim finished successfully | `claim.ts:finishClaimRecord` via `completeClaimForArtifact` (`:259-266`) |
| `claim-released` | Claim/lease | Claim released, status restored | `claim.ts:releaseClaimRecord` (`:238-245`) |
| `claim-expired` | Claim/lease | Lease lapsed, artifact returned | same as above with `expired = true` |
| `run-reaped` | Claim/lease | Dead/stale run reaped | `runs.ts:reapStaleRuns` INSERT..SELECT (`:283-304`) |
| `registered` | Intake | Artifact registered | generic CLI |
| `analyzed` / `scaffolded` / `migrated` | Migration pipeline | Stage completions | generic CLI (agents call it) |
| `proposal-submitted` / `evidence-submitted` / `critique-issued` | Society review | builder/critic handoffs | `guildctl/commands/evidence.ts:runEvidenceAdd` (`:75-88`) emits `evidence-submitted`; others generic |
| `arbitration-approved` / `arbitration-rejected` | Arbitration | Critic verdict | `registry/commands/evidence.ts` (`:515-517`, `:745-747`) |
| `approval-gated` | Approval | Operator approval required | `registry/commands/evidence.ts:537-539` |
| `approval-approved` / `approval-rejected` | Approval | Operator decision | `registry/commands/approval.ts:287-298` |
| `conflict-opened` / `conflict-resolved` | Conflicts | Dependency conflicts | generic CLI |
| `benchmark-recorded` | Benchmarks | Benchmark verdict | `registry/commands/benchmark.ts:119` |
| `reviewed` / `remediated` | Review/remediation | Stage completions | generic CLI |
| `blocked` / `unblocked` | Blocking | Blocker lifecycle | supervisor loop (`guildctl/supervisor/loop.ts` — 9 `blocked` sites: `:146-152`, `:167-173`, `:348`, `:383`, `:541`, `:725`, `:755`, `:991`) |
| `completed` | Terminal | Artifact done | generic CLI |
| `issue-opened` / `issue-resolved` | Issues | Human/agent issue tracking | generic CLI; heavily *queried* by `registry/commands/queries.ts` (`:153-157`, `:265-272`, `:879-989`) |
| `tag-added` / `tag-removed` | Metadata | Tag lifecycle | generic CLI |
| `context-written` | Context | Agent context file written | generic CLI |
| `status-changed` | Any | Status transition (see below) | `registry/commands/artifacts.ts:setArtifactStatus` (`:222-231`) and legacy release path (`:326-329`) |
| `evaluated` | Verification | Verification attempt recorded | `registry/commands/verification.ts:169-170` |
| `auto-completed` / `auto-rework` | Supervisor automation | Auto-advance / auto-rework decisions | supervisor loop (`:184-190`, `:307-309`, `:568-570`, `:606`); drift gate also emits `auto-rework` (`loop.ts:184-191`) |
| `filesystem-violation` | Sandbox enforcement | Warden restored/deleted out-of-scope writes | `guildctl/warden.ts:291-302` |
| `thread-created` | Dialogue (Track 3) | Agent dialogue thread opened | generic CLI; test-covered in `migration/test/agent-dialogue-events.test.ts:34-55` |
| `dependency-strategy-set` | Modernization | Dependency strategy decision | `registry/commands/modernization.ts:331-332` |
| `remediation-confirmed-no-defect` | Remediation | Remediation found nothing to fix | generic CLI; the newest CHECK addition (US2/#154), added by the table rebuild in `schema.ts:150-211` |

Note the deliberate asymmetry documented in `registry/commands/dispositions.ts:18` and `:232`: **dispositions emit no events rows** because `events.artifact_id` is NOT NULL and dispositions are workspace-wide, not per-artifact.

## Emit sites per phase — how events actually get written

There are **two write mechanisms**, and knowing which one a call site uses matters:

### 1. `appendEvent` — the validated public API (`migration/registry/commands/events.ts:appendEvent`)

Validates in order: id shape (`validateId`), event type against `VALID_EVENT_TYPES`, artifact existence, and that `data` parses as JSON (`:63-75`) — then does a plain INSERT. Used by: the drift gate and supervisor loop (`guildctl/supervisor/loop.ts`, 13 sites), the warden (`guildctl/warden.ts:291`), approval (`registry/commands/approval.ts:287`), arbitration (`registry/commands/evidence.ts:515,537,745`), benchmark (`registry/commands/benchmark.ts:119`), guildctl evidence CLI (`guildctl/commands/evidence.ts:75`), and the `registry append-event` CLI command (`registry/cli.ts:306-326`) which is how external agents emit the taxonomy types not hardcoded in library code (`planned`, `registered`, `analyzed`, `migrated`, `reviewed`, `completed`, etc.).

### 2. Raw `INSERT INTO events` inside the owning command's transaction

Several hot paths inline the INSERT to stay inside the same transaction as the state mutation:

- `registry/commands/claim.ts` — `claimed` (`:623`, `:872`), `finishClaimRecord` for `claim-completed`/`claim-released`/`claim-expired` (`:184-207`), `claim-heartbeat` (`:293-313`). All pack a consistent JSON envelope: `{claim_id, run_id, owner_id, attempt_no, lease_minutes}` (heartbeats add `lease_minutes`; finishes add `from_status` and `state`).
- `registry/commands/runs.ts:283-304` — `run-reaped` via `INSERT ... SELECT` so one reap fans out one event **per claimed artifact** on the run.
- `registry/commands/artifacts.ts:setArtifactStatus` — `status-changed` (`:210-231`). **Conditional**: the event is only written if `opts.agent || opts.reason || opts.model` is provided (`:210-211`); bare `setArtifactStatus(db, id, status)` calls mutate status silently. The event payload is `{previous_status, new_status, reason}` and the summary follows the exact format `"X -> Y"` that `guildctl watch` regex-parses for coloring.
- `registry/commands/artifacts.ts:326-329` — the legacy (no `artifact_claims` row) release path writes a `status-changed` with **no** `event_data` column at all.
- `registry/commands/verification.ts:166-170` — `evaluated`, with a comment noting the events CHECK list is deliberately extended alongside.
- `registry/commands/modernization.ts:331` — `dependency-strategy-set`.

### The changelog half (`migration/registry/commands/changelog.ts`)

`appendChangelog` (`:14-46`): validates id, verifies the artifact exists, prepends a `## YYYY-MM-DD — <type> (<agent>)` heading + entry to `migration/artifacts/<slug>/changelog.md` (creating the dir if needed), then upserts `{artifact_id, file_path, last_entry, updated_at}` into `changelogs` with `ON CONFLICT DO UPDATE`. `getChangelogPath` (`:48-56`) throws `RegistryError(2)` if no changelog row exists — note it returns the *recorded* path, which may be stale if the file was moved.

## Consumption paths

### `guildctl watch` (`migration/guildctl/commands/watch.ts`)

A 2-second `setInterval` full-screen re-render (`runWatch`, `:98-119`). Its event view is narrow and opinionated: `getRecentEvents` (`:44-53`) selects **only `type = 'status-changed'`**, joined to `artifacts` for path/module, latest 12, reversed for chronological display. `renderEvents` (`:55-73`) regex-parses the summary with `/^(\S+) (?:→|->) (\S+)$/` to colorize the target status via `STATUS_COLOR` (`:22-34`). Watch also shows active sessions with a stall warning (threshold `GUILDCTL_STALL_MINS`, default 10, read at import time — `:20`) and reuses `printStatusSummary`/`printWavePlan` from `guildctl/dashboard.ts`.

### `guildctl status` (`migration/guildctl/commands/status.ts`)

`runStatus` (`:123-130`) reads **no events at all** — it is pure artifact/run aggregate SQL (`phaseState` `:14-24`, `verificationSplit` `:77-91`, `printRepeatWaste` `:107-121`, plus dashboard helpers) plus next-step advice (`printNextSteps` `:26-61`). Event-derived signal reaches status only indirectly (e.g. `runs.outcome_label = 'no-progress'`, which correlates with supervisor `blocked`/`auto-rework` events).

### Other consumers

- **`registry get-events` / `show`** (`registry/cli.ts:476-481`, `:153`) → `getEventsQuery` (`registry/commands/queries.ts:92-120`), which JSON-parses `event_data` before returning — unlike `getEvents` (`registry/commands/events.ts:90-113`), which returns the raw string. Same query shape (`ORDER BY ts DESC`, optional type filter and limit).
- **`/api/events` HTTP endpoint** (`registry/commands/serve.ts:189`, query in `registry/commands/queries.ts:607-629`) → consumed by the UI's `useEvents` hook (5 s polling). The full UI flow — backend watermark poller in `guildctl/poller.ts`, stateless REST, React hooks — is documented in `docs/modules/ui-registry-live-data-flow.md` and not duplicated here.
- **Analytics**: `guildctl/commands/society-report.ts:77` counts `run-reaped` events; `registry/commands/queries.ts` builds issue-open/unresolved views from `issue-opened`/`issue-resolved` pairs (`:153-157` etc.); `registry/commands/benchmark.ts:53` counts events for coverage stats.
- **Gate logic reads events**: `registry/commands/artifacts.ts:36-43` scans recent `filesystem-violation` events; `registry/commands/evidence.ts:714` reads event timestamps for recency decisions; `registry/commands/queries.ts:137,298` correlate `unblocked` events.

## Invariants & edge cases

- **Append-only, no retention/pruning.** There is no `DELETE FROM events` anywhere in the codebase (only the table-rebuild migration copies rows). The log grows monotonically; `ON DELETE CASCADE` from `artifacts` is the only row-lifetime mechanism. Heartbeats make this worse: every lease renewal is an event row.
- **Triple-maintained type list.** `EventType` union, SQL CHECK, and `VALID_EVENT_TYPES` must all agree. Adding a type to only the TS union will pass typecheck but fail at runtime with `RegistryError(1)`; the CHECK widening requires the table-rebuild dance in `schema.ts:ensureRemediationNoDefectEventType` because SQLite cannot ALTER a CHECK constraint.
- **`ts` is second-resolution SQLite time** (`datetime('now')`), not the client clock. The UI poller's watermark cursor (`guildctl/poller.ts`) initializes `lastTs` to a formatted current time; events written in the same second as poller start can be skipped or double-delivered across that boundary.
- **`status-changed` is conditional** (`artifacts.ts:210-211`) — a status change without agent/reason/model leaves no event. Watch's "Recent Events" can therefore lag actual status.
- **Summary format is a de-facto contract**: watch's colorizer regex (`watch.ts:65`) depends on `"from -> to"` shape; `setArtifactStatus` appends the reason after it, which the regex tolerates (it anchors on start only — actually it anchors both ends, so summaries with a reason fall back to uncolored text; the bare `"X -> Y"` form from the legacy release path colors fine).
- **Reap fan-out**: one reaped run produces one `run-reaped` event *per artifact claim* on that run (`runs.ts:285-295` INSERT..SELECT), not one per run.
- **`event_data` is not uniformly present**: the legacy release path (`artifacts.ts:327`) omits the column entirely; consumers must null-check before `JSON.parse` (as `getEventsQuery` does, `queries.ts:118`).
- **Changelog is prepend-ordered, DB is append-ordered**: `appendChangelog` writes newest-first to the file (`changelog.ts:34`) while `getEvents` returns newest-first via `ORDER BY ts DESC` — same reading order, opposite write order.
- **Changelog date is wall-clock local-to-UTC** (`new Date().toISOString().slice(0,10)`, `changelog.ts:28`) while event `ts` is SQLite UTC — the two can disagree by a day near midnight.

## Gotchas

- **Two near-identical read functions with different output**: `getEvents` returns `event_data` as a raw JSON string; `getEventsQuery` returns it parsed. Pick deliberately.
- **`guildctl watch` shows only status changes.** If you're debugging why an artifact is blocked, watch won't show `blocked` events — use `registry get-events --id ...` or `/api/events`.
- **The stall threshold in watch is captured at module import** (`watch.ts:20`), so setting `GUILDCTL_STALL_MINS` at runtime after import has no effect (see `migration/test/env-precedence.test.ts:694`).
- **Warden's `filesystem-violation` event is paired with a `blocked:out-of-scope-path` tag** (`warden.ts:304`), but the tag write is best-effort (swallowed failure) — the event is the authoritative record.
- **Approval events imply a status change too**: `registry/commands/approval.ts:285` calls `setArtifactStatus` *before* `appendEvent`, so a `status-changed` and an `approval-approved`/`approval-rejected` row appear as a pair (the former only if agent/reason was threaded through).
- **`claim-heartbeat` volume**: long-running agents heartbeat on a lease cadence, so the events table is dominated by heartbeat rows on busy registries; type-filtered queries (`idx_events_type`) exist precisely for this.

## Extension points

- **Adding an event type** (the checklist, per the `remediation-confirmed-no-defect` precedent in `schema.ts:142-211`): (1) extend the `EventType` union in `migration/registry/types.ts`; (2) add to `VALID_EVENT_TYPES` in `registry/commands/events.ts`; (3) add to the CHECK in `registry_schema.sql` *and* extend/clone the table-rebuild guard in `schema.ts` for existing DBs; (4) extend `migration/test/registry-schema-delta.test.ts` and, for dialogue-style types, `migration/test/agent-dialogue-events.test.ts`.
- **Emitting from a new pipeline stage**: prefer `appendEvent` (validated, standalone) unless you must be transactional with a state mutation — then inline the INSERT inside the owning command's transaction, following `claim.ts:finishClaimRecord` as the pattern (consistent JSON envelope, `event_id` via `lower(hex(randomblob(8)))`).
- **New event-derived CLI/analytics**: follow `society-report.ts` (COUNT over `WHERE type = ...`) or the issue-pair correlation pattern in `queries.ts:153-157`; rely on `idx_events_type`.
- **New UI slice over events**: per `docs/modules/ui-registry-live-data-flow.md` — query in `queries.ts`, endpoint in `serve.ts`, fetch wrapper in `ui/src/api.ts`, hook in `ui/src/hooks.ts`.

## Related tests

- `migration/test/registry-api-queries.test.ts` — `appendEvent` validation (invalid type, unknown artifact, non-JSON data) and `getEventsQuery` filtering/limiting (`:215-300`).
- `migration/test/agent-dialogue-events.test.ts` — Track 3 types (`thread-created`) accepted; invalid types rejected (`:34-63`).
- `migration/test/registry-status-reason.test.ts:25` — reasoned `status-changed` events carry metadata.
- `migration/test/artifacts-release-pending.test.ts:100-103` — release must write a `status-changed` event.
- `migration/test/warden.test.ts:447` and `migration/test/auto-canary.test.ts:254,301` — `filesystem-violation` event payloads.
- `migration/test/drift-gate.test.ts` / `migration/test/approval-gate.test.ts` — `auto-rework` and `approval-gated` emission.
- `migration/test/verify-stack-default.test.ts:235-236` — `remediation-confirmed-no-defect` via `appendEvent`.
- `migration/test/dashboard-active-sessions.test.ts:78-94` — `claim-expired` interplay with the watch dashboard.
