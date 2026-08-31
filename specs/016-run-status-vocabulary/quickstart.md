# Quickstart: Validating the Run Status Vocabulary Feature

## Prerequisites

- A migration workspace with the registry initialized (any existing dev/test registry fixture works; no new fixture data is required beyond what spec-013's approval tests already set up).
- `npm test` runnable from repo root (root `package.json` `test` script runs both `migration` and `migration/ui` suites, per the constitution's Development Workflow gate).

## Registry-layer validation

1. Seed (or reuse an existing test fixture with) one artifact with an active claim whose `heartbeat_at` is within 5 minutes of "now," one artifact with an active claim whose `heartbeat_at` (or `claimed_at` fallback) is older than 5 minutes, one artifact with no active claim, one artifact at `pending-approval`, and one artifact with a recorded `rejected` arbitration decision.
2. Call the new registry-layer read function directly (unit test level) and assert:
   - The recent-heartbeat artifact resolves to `working`.
   - The stale-heartbeat artifact resolves to `idle` (not `working`).
   - The no-claim artifact resolves to `idle`.
   - The `pending-approval` artifact resolves to `waiting-for-approval`.
   - The `rejected`-decision artifact resolves to `rejected`.
   - An artifact crafted to satisfy both an active recent claim AND a `rejected` decision resolves to `rejected` (precedence, FR-005).

## API validation

3. Start the registry HTTP server (`migration/registry/commands/serve.ts`, same way spec-013's `test/approval-dashboard-parity.test.ts`-style tests already do) against the seeded fixture.
4. `GET /api/run-status` and confirm the response is a JSON array where every entry has exactly one of the four labels, matching the registry-layer function's output for the same fixture (parity, mirroring spec-013's approval-dashboard-parity precedent).

## UI validation

5. Run `npm --prefix migration/ui test` (or the relevant `*.test.tsx` file) and confirm:
   - The new `RunStatusBadge` component renders each of the four labels distinctly (visually distinguishable, per FR-009's "single, consistent visual vocabulary").
   - A component-level test simulates a poll-cycle refetch (advancing the existing `pollIntervalMs` timer, same pattern as any existing polling hook test) and confirms a `working` badge transitions to `idle` without a manual reload, once the underlying data crosses the threshold (SC-003, FR-011).
   - The existing `ApprovalsPanel` continues to pass its existing tests unmodified (regression guard for FR-007/SC-004).

## End-to-end manual check (optional, for a human reviewer)

6. Start the dashboard against a live/dev registry, claim an artifact so its heartbeat is fresh, and confirm the dashboard shows it as "working." Let the process stop heartbeating (or manually age the row) past 5 minutes and confirm the dashboard's next poll shows "idle" without a manual browser refresh.
