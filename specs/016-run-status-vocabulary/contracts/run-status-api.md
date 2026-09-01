# Contract: `GET /api/run-status`

New read-only endpoint on the existing Mission Control registry HTTP server (`migration/registry/commands/serve.ts`), following the same dispatcher pattern as the existing `GET /api/approvals` (spec-013 US4, see `serve.ts` lines ~137-140).

## Request

```
GET /api/run-status
```

No query parameters, no request body, no authentication beyond whatever the existing dashboard endpoints already require (this endpoint introduces no new auth surface).

## Response

`200 OK`, `application/json`, body is an array of `RunStatusEntry`:

```jsonc
[
  {
    "artifact_id": "string",
    "label": "working" | "idle" | "waiting-for-approval" | "rejected",
    "heartbeat_age_ms": 12345 // or null
  }
]
```

One entry per non-terminal artifact (terminal statuses `migrated`, `reviewed`, `completed`, `skipped` are excluded per spec.md Assumptions). Every entry has exactly one `label` (FR-001, SC-002). Order is unspecified; callers join on `artifact_id` against data already fetched from `/api/status` or the artifact list.

## Errors

- No 4xx/5xx cases beyond the server's existing generic error handling — this is a pure read with no user input to validate.

## Backing implementation

- Registry-layer function (name TBD at implementation time, e.g. `queryRunStatusForUI`), added to `migration/registry/commands/queries.ts` following the `queryPendingApprovalsForUI`/`queryApprovalHistoryForUI` precedent immediately near it.
- MUST reuse `listPendingApprovals` (or the artifact status check it implies) for the `waiting-for-approval` branch and the existing `arbitration_decisions` read pattern (see `migration/registry/commands/approval.ts` lines ~180-215) for the `rejected` branch — no parallel/duplicated query logic (FR-007/FR-008).
- MUST NOT modify `recordApprovalDecision`, `listPendingApprovals`, or any claim/heartbeat write path.

## Consumption contract (UI side)

- `migration/ui/src/api.ts`: add a `fetchRunStatus()` function mirroring the existing `fetchApprovals()`-style function.
- `migration/ui/src/hooks.ts`: add a hook using the existing `pollIntervalMs`-driven shared fetch hook (same one backing `ApprovalsPanel`/other panels), so `/api/run-status` is re-polled on the dashboard's existing live-refresh cadence (FR-011).
- `migration/ui/src/types.ts`: mirror `RunStatusEntry` as a UI-side DTO type.
