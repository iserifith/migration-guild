# CLI Dashboard and State Projections

## Purpose and Overview

The Migration Guild requires high-fidelity, real-time observability of the entire migration pipeline. While a local API serves a React frontend, a core requirement is providing immediate visibility directly in the operator's terminal through CLI commands like `guildctl watch` and `guildctl status`.

The CLI dashboard and projection layer is responsible for translating the complex, normalized SQLite relational state (artifacts, claims, events, runs, verifications) into human-readable terminal output. Crucially, it does this entirely statelessly using raw, optimized SQL aggregate queries and direct terminal ANSI control codes, avoiding heavyweight ORMs or complex state synchronization logic in the backend process.

## Architecture and Scope

The CLI visualization layer spans three primary modules:

1. **The Shared View Layer (`migration/guildctl/dashboard.ts`)**: Defines the ANSI styling constants, color mappings, and the core projection functions (e.g., `printWavePlan`, `printStatusSummary`, `printInProgress`) used across multiple CLI commands.
2. **The Status Guide (`migration/guildctl/commands/status.ts`)**: A point-in-time snapshot generator that aggregates pipeline metrics and computes "next step" advice based on overall phase completion.
3. **The Watch Loop (`migration/guildctl/commands/watch.ts`)**: A live, polling dashboard that continuously clears and redraws the terminal screen, displaying recent events, active sessions, and active stall detection.

---

## Step-by-Step Flow and Mechanics

### 1. The Shared View Layer (`dashboard.ts`)

The projection queries are designed to be fast, performing aggregations directly in SQLite rather than pulling objects into memory.

- **Pipeline Ordering**: `printStatusSummary` does not sort alphabetically. It uses a hardcoded SQLite `ORDER BY CASE` expression to force the status counts into the exact logical order of the pipeline:
  ```sql
  ORDER BY CASE status
    WHEN 'pending'       THEN 1
    WHEN 'planned'       THEN 2
    WHEN 'in-progress'   THEN 3
    ...
  ```
- **Active Sessions and Age**: `printInProgress` queries artifacts joining active `artifact_claims` and running `runs`. It calculates session age entirely in SQL using SQLite's built-in julian day arithmetic:
  `CAST(ROUND((julianday('now') - julianday(c.claimed_at)) * 86400) AS INTEGER) AS age_seconds`
- **Wave Progress Calculation**: `printWavePlan` computes progress bars by aggregating `COUNT(*)` against `SUM(CASE WHEN status IN (...) THEN 1 ELSE 0 END)` directly in the query.

### 2. The Status Guide (`status.ts`)

When an operator runs `guildctl status`, the CLI evaluates what phase the project is currently in.

- **Phase State Calculation**: `phaseState` runs a single query summing the total artifacts, how many have waves planned, how many are migrated, and how many are reviewed.
- **Interactive Routing**: `printNextSteps` acts as an interactive wizard. Based on the `phaseState`, it outputs exactly which command the operator should run next (e.g., if `planned < total`, it tells them to run `guildctl run plan`).
- **Coalescing Verification Splits**: `verificationSplit` uses a `LEFT JOIN` on `artifact_verifications`. To prevent artifacts with no verification attempts from disappearing from the count, it uses `COALESCE(v.state, 'unverified')`.

### 3. The Watch Loop (`watch.ts`)

When an operator runs `guildctl watch`, it creates a live terminal dashboard.

- **Redraw Mechanic**: It uses standard ANSI escape codes (`\x1b[2J\x1b[H` bound to `CLEAR`) to clear the screen and move the cursor to the top left before every render cycle, running on a 2000ms `setInterval`.
- **Event Filtering**: The `getRecentEvents` query specifically narrows to `WHERE e.type = 'status-changed'`. It limits to 12 rows, ordered descending, but then reverses them in JS `[...events].reverse()` so the oldest event is at the top of the list and the newest is at the bottom, matching standard terminal append flow.
- **Stall Detection**: `renderActiveSessions` calculates age in minutes using `(julianday('now') - julianday(claimed_at)) * 1440`. If an active session's age exceeds `STALL_MINUTES` (read from `GUILDCTL_STALL_MINS`, defaulting to 10), it highlights the row in red and prints a command to forcefully release the claim.

## Invariants and Gotchas

- **Aggregate Supremacy**: Projections must be `COUNT`-shaped or `SUM`-shaped. On registries with thousands of artifacts, pulling all rows and mapping them in Node.js would cause noticeable lag. Functions like `printRepeatWaste` rely on `HAVING COUNT(*) >= 2` directly in SQLite.
- **Stateless Operation**: Neither `status.ts` nor `watch.ts` mutate any data, nor do they cache it. Every tick of the watch loop reads fresh from SQLite.
- **Status Change Event Dependency**: `watch.ts` builds its event list solely off the `status-changed` event type. If an agent fails and leaves a reason without transitioning the status, it will not appear in the "Recent Events" watch list.
- **Stall Constant Initialization**: The `STALL_MINUTES` constant in `watch.ts` is parsed strictly at module import time (`parseInt(process.env["GUILDCTL_STALL_MINS"])`). Changing the environment variable programmatically after the module has been required will have no effect on the current process.

## Extension Points

- To add a new metric to the summary, create a new `printX(db: Database.Database)` function in `migration/guildctl/dashboard.ts`. Ensure it queries the database efficiently using aggregates. Then, wire it into `runStatus` (in `status.ts`) or the `render` loop (in `watch.ts`).
- `STATUS_COLOR` mappings in both `dashboard.ts` and `watch.ts` control how UI text is highlighted. If a new artifact status is added to the state machine, it must be added to these maps to prevent it rendering uncolored.