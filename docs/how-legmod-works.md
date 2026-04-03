# How legmod works behind the scenes

This guide explains what the kit is actually doing when you run the pipeline: which processes start, what gets written to the registry, how phases coordinate, and how failures are surfaced.

---

## Mental model

legmod is **not** one long in-process migration engine. It is an **orchestrator** around:

1. A local workspace with `legacy/`, `modern/`, and `migration/`
2. A SQLite registry (`migration/registry.db`)
3. Copilot CLI subprocesses spawned for each phase
4. Optional Microsoft Foundry integrations for batch, eval, tracing, and retrieval

The registry is the source of truth. Agents are disposable workers.

---

## Workspace layout

| Path | Purpose |
|---|---|
| `legacy/` | Read-only source code being migrated |
| `modern/` | Write target for migrated tests and production code |
| `migration/legmod/` | Orchestrator CLI that runs phases |
| `migration/registry/` | Registry CLI and state-management logic |
| `migration/registry.db` | SQLite database tracking artifacts, events, dependencies, and runs |
| `.github/agents/` | Agent definitions used by Copilot CLI |
| `.github/instructions/` | File-level constraints applied during migration |

---

## The two CLIs

### `legmod`

`node migration/legmod/dist/cli.js ...`

This is the operator-facing orchestrator. It:

- loads `.env` from the workspace root automatically
- opens the registry database
- runs pipeline phases (`inventory`, `plan`, `migrate`, `review`)
- spawns Copilot CLI subprocesses
- prints dashboards, progress, and operator guidance

### `registry`

`node migration/registry/dist/cli.js ...`

This is the lower-level state API. Agents use it to:

- register artifacts
- claim work atomically
- update statuses
- add tags, dependencies, and context
- inspect wave plans, blockers, and recent runs

---

## What happens when you run a phase

## 1. Inventory

Implemented in `migration/legmod/commands/inventory.ts`.

Inventory has two parts:

1. **Local file scan**: legmod walks `legacy/` itself and registers every `.java` file in the registry.
2. **Classification**: each registered artifact is classified with role/framework metadata.

Classification can happen in two modes:

- **Local Copilot agent**: `context-agent`
- **Foundry batch**: if inventory provider is configured as Foundry and batch is enabled

After inventory, artifacts usually have:

- `kind`
- `path`
- `tier`
- `role`
- `framework`
- `status = pending`

## 2. Planning

Implemented in `migration/legmod/commands/plan.ts`.

Planning is split into two sub-phases:

1. **Stack advisor** proposes legacy-to-target framework mappings
2. **Planner** assigns dependencies and wave numbers

There is a human confirmation gate between them. Unconfirmed framework mappings must be confirmed or edited before planning proceeds.

After planning, first-class artifacts should have:

- dependency edges in `dependencies`
- a `wave`
- `status = planned`

## 3. Migration

Implemented in `migration/legmod/commands/migrate.ts`.

Migration runs two pools:

1. **test-writer-agent** writes target-side tests first
2. **code-writer-agent** writes production code for `tests-written` artifacts

Each pool is executed by spawning multiple Copilot CLI subprocesses in parallel. Each subprocess is tracked in the registry `runs` table.

Important detail: legmod itself does **not** migrate files directly. It starts workers, then watches registry state and event output.

## 4. Review

Implemented in `migration/legmod/commands/review.ts`.

Review repeatedly looks for first-class artifacts with `status = migrated`, then spawns `review-agent` processes for them in batches. It keeps polling until:

- no migration work remains
- no migrated artifacts remain unreviewed
- no review runs are still active

If review runs but no registry progress occurs, the phase is treated as stalled rather than silently successful.

---

## The registry state machine

The main artifact status values are defined in `migration/registry_schema.sql`.

Common path for first-class source files:

```text
pending
  -> planned
  -> analyzed
  -> in-progress
  -> tests-written
  -> migrated
  -> reviewed
  -> completed
```

Other terminal or exceptional states:

- `needs-rework`
- `blocked`
- `skipped`

Not every artifact uses every state. For example, some flows skip `analyzed`, and second-class config artifacts may move differently.

---

## How work is claimed safely

Claiming is implemented in `migration/registry/commands/claim.ts`.

Claims are **transactional**:

1. find the next artifact in the requested source status
2. ensure all dependencies are already in terminal dependency states
3. update the row to `in-progress`
4. record `claimed_by`, `claimed_at`, and `claimed_from`
5. append a `claimed` event

Because this is done inside a SQLite transaction, parallel sessions cannot claim the same artifact.

If nothing is claimable:

- exit code `2` means work still exists, but is blocked or already in flight
- exit code `4` means everything is finished for that scope

---

## Why the event log matters

The registry has an append-only `events` table plus a trigger:

- any artifact status change writes a `status-changed` event automatically

That means the dashboard does **not** depend on agents printing well-behaved logs. Even if an agent is chatty, quiet, or inconsistent, the operator still sees progress whenever registry state changes.

This is what powers:

- `legmod watch`
- recent-event rendering
- phase progress output during long runs

---

## How Copilot subprocesses are spawned

Implemented in `migration/legmod/runner.ts`.

For each spawned worker, legmod:

1. chooses the effective provider for the phase (`copilot` or `foundry`)
2. sets provider environment variables if Foundry is selected
3. spawns the Copilot CLI as a child process
4. records the run in `runs`
5. optionally writes stdout/stderr to a log file
6. records final exit code when the process exits

Each run stores:

- `agent`
- `model`
- `prompt`
- `log_file`
- `pid`
- `started_at`
- `finished_at`
- `exit_code`
- `status` (`running`, `completed`, `failed`)

---

## Failure visibility and silent-failure protection

This is the most important operational behavior.

### What legmod treats as visible failure

- a spawned Copilot process exits non-zero
- a run times out
- a recorded PID is no longer alive
- review makes no registry progress while migrated files remain
- migration ends with first-class artifacts still not advanced

### How this is surfaced

- run rows are marked `failed`
- exit codes are stored in `runs`
- per-run log files are preserved when logging is enabled
- migration/review now reject failed worker batches instead of treating them as mere lack of progress
- `legmod watch` highlights long-running `in-progress` artifacts
- `legmod release` can return stuck claims to their pre-claim state

### Stale and stuck work

There are two related but different concepts:

| Concept | Detected from | Meaning |
|---|---|---|
| **failed run** | `runs` table / dead process / non-zero exit | the worker process itself ended badly |
| **stuck artifact** | artifact still `in-progress` for too long | work was claimed but not advanced |

Commands involved:

- `node migration/registry/dist/cli.js list-runs`
- `node migration/legmod/dist/cli.js watch`
- `node migration/legmod/dist/cli.js release --id "<artifact-id>"`

Environment knobs:

- `LEGMOD_STALL_MINS` — when `watch` starts flagging claims as stalled
- `LEGMOD_STALE_RUN_MINS` — when PID-less running rows are reaped as failed
- `LEGMOD_REVIEW_TIMEOUT_MINS` — review worker timeout

---

## What `legmod watch` is showing you

Implemented in `migration/legmod/commands/watch.ts`.

The watch dashboard redraws on an interval and combines:

- current status counts
- wave plan
- active `in-progress` sessions
- recent `status-changed` events

It is intentionally registry-driven. If the registry is moving, the watch view moves.

---

## Recovery model

If an agent crashes or gets wedged:

1. inspect recent runs
2. inspect watch / wave plan
3. release the stuck artifact if necessary
4. rerun the relevant phase

Typical operator commands:

```bash
node migration/legmod/dist/cli.js status
node migration/legmod/dist/cli.js watch
node migration/registry/dist/cli.js list-runs --agent review-agent
node migration/legmod/dist/cli.js release --id "<artifact-id>"
```

Because the registry is persistent and claims are explicit, recovery is usually a matter of correcting state and rerunning workers, not starting over.

---

## Optional Foundry features

Foundry is an integration layer, not a separate orchestration model.

When enabled, it can provide:

- per-phase model/provider routing
- batch inventory or embedding jobs
- evaluation scoring and auto-advance
- tracing for token/cost visibility
- semantic retrieval via stored embeddings
- Azure AI agent threads

The orchestration pattern stays the same:

- registry remains local
- file I/O remains local
- claims and status updates remain local
- only model execution is routed to Foundry

See also: `docs/foundry-api-reference.md`

---

## Design principles

legmod is built around a few core ideas:

1. **Registry first** — database state is more important than agent console output
2. **Agents are workers, not authorities** — they do work, but the registry decides progress
3. **Parallelism must be safe** — claiming is atomic and dependency-aware
4. **Recovery must be cheap** — stuck claims can be released and retried
5. **The legacy tree stays untouched** — migration always writes into `modern/`

That is the core architecture: a local, restartable migration pipeline whose control plane is SQLite and whose execution plane is spawned AI workers.
