# How Migration Guild works behind the scenes

This guide explains what the kit is actually doing when you run the pipeline: which processes start, what gets written to the registry, how phases coordinate, and how failures are surfaced.

---

## Mental model

Migration Guild is **not** one long in-process migration engine. It is an **orchestrator** around:

1. A local workspace with `legacy/`, `modern/`, and `migration/`
2. A SQLite registry (`migration/registry.db`)
3. agent CLI subprocesses spawned for each phase
4. Optional Microsoft OpenAI-compatible runtime files for batch, eval, tracing, and retrieval

The registry is the source of truth. Agents are disposable workers.

---

## Workspace layout

| Path                    | Purpose                                                            |
| ----------------------- | ------------------------------------------------------------------ |
| `legacy/`               | Read-only source code being migrated                               |
| `modern/`               | Write target for migrated tests and production code                |
| `__MIGRATION_GUILDCTL__/`     | Orchestrator CLI that runs phases                                  |
| `migration/registry/`   | Registry CLI and state-management logic                            |
| `migration/registry.db` | SQLite database tracking artifacts, events, dependencies, and runs |
| `.github/agents/`       | Agent definitions used by agent CLI                              |
| `.github/instructions/` | File-level constraints applied during migration                    |

---

## The two CLIs

### `guildctl`

`node __MIGRATION_GUILDCTL__/dist/cli.js ...`

This is the operator-facing orchestrator. It:

- loads `.env` from the workspace root automatically
- opens the registry database
- runs pipeline phases (`inventory`, `plan`, `bootstrap`, `migrate`, `review`, `remediate`)
- spawns agent CLI subprocesses
- prints dashboards, progress, and operator guidance

`run` with no phase prints the next recommended phase. In normal operation, bootstrap is optional because migration auto-runs bootstrap when `modern/` is not scaffolded.

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

Implemented in `__MIGRATION_GUILDCTL__/commands/inventory.ts`.

Inventory has three parts:

1. **Local file scan**: Migration Guild walks `legacy/` itself and registers every `.java` file in the registry.
2. **Classification**: each registered artifact is classified with role/framework metadata.
3. **Pre-plan audit refresh**: Migration Guild scans each source artifact for JVM compatibility and risky dependency usage, then persists the findings in the registry.

Classification can happen in two modes:

- **Local Agent agent**: `context-agent`

After inventory, artifacts usually have:

- `kind`
- `path`
- `tier`
- `role`
- `framework`
- `status = pending`

The audit refresh writes:

- `jvm_audit_findings`
- `dependency_findings`
- `operator_state.pre_plan_audit`

That makes the planning gate state queryable per artifact before waves are assigned.

## 2. Planning

Implemented in `__MIGRATION_GUILDCTL__/commands/plan.ts`.

Planning is split into three sub-steps:

1. **Planning readiness gate** refreshes audit state and checks for blockers
2. **Stack advisor** proposes legacy-to-target framework mappings
3. **Planner** assigns dependencies and wave numbers

There are now three gates inside planning:

1. **Critical JVM audit gate** — blocks planning when internal, removed, or otherwise critical JVM API findings remain open
2. **Framework mapping confirmation gate** — unconfirmed framework mappings must be confirmed or edited before planning proceeds
3. **Dependency modernization gate** — risky dependency findings must have an approved upgrade/replacement strategy before wave assignment starts

Warning-only JVM findings stay visible but do not block planning.

After planning, first-class artifacts should have:

- dependency edges in `dependencies`
- a `wave`
- `status = planned`

Useful operator commands:

```bash
node migration/registry/dist/cli.js list-jvm-findings --severity critical
node migration/registry/dist/cli.js list-dependency-findings --unresolved-only
node migration/registry/dist/cli.js approve-dependency-strategy --finding-id <id> --strategy replace --target-dependency <coord> --approved-by <name> --rationale <text>
```

## 3. Bootstrap (optional explicit phase)

Implemented in `__MIGRATION_GUILDCTL__/commands/bootstrap.ts`.

Bootstrap scaffolds the minimal target module in `modern/` using the packaged target-module assets. It is safe to run explicitly, and migration also runs it automatically when required.

Current behavior:

1. Detect target type (`web`, `service`, or `library`) from first-class artifacts
2. Scaffold or keep existing Gradle/module files as needed
3. For non-library targets, create deterministic Spring app/resource files (`<AppName>Application.java`, `application.yml`)
4. Return a structured created/skipped result and treat an already-scaffolded module as a skip, not an error

## 4. Migration

Implemented in `__MIGRATION_GUILDCTL__/commands/migrate.ts`.

Migration runs three pools:

1. **analyze-agent** advances `planned` first-class artifacts to `analyzed`
2. **test-writer-agent** writes target-side tests for `analyzed` artifacts
3. **code-writer-agent** writes production code for `tests-written` artifacts

Each pool is executed by spawning multiple agent CLI subprocesses in parallel. Each subprocess is tracked in the registry `runs` table.

Important detail: Migration Guild itself does **not** migrate files directly. It starts workers, then watches registry state and event output.

## 5. Review

Implemented in `__MIGRATION_GUILDCTL__/commands/review.ts`.

Review repeatedly looks for first-class artifacts with `status = migrated`, then spawns `review-agent` processes for them in batches. It keeps polling until:

- no migration work remains
- no migrated artifacts remain unreviewed
- no review runs are still active

If review runs but no registry progress occurs, the phase is treated as stalled rather than silently successful.

## Exception path — Remediation

Remediation is not part of the happy-path phase sequence. It exists to repair artifacts when normal phase advancement is no longer safe.

Typical triggers:

- a worker run exited non-zero
- a recorded PID disappeared
- an artifact stayed `in-progress` long enough to be considered stalled
- review moved an artifact to `needs-rework`
- an artifact is `blocked` and needs an explicit operator-facing reason

The intended split is:

- `migration-orchestrator` detects abnormal state and pauses normal advancement
- `remediation-agent` inspects the affected artifact and chooses one safe repair action

Typical remediation outcomes:

- release the claim so the artifact can be retried
- move the artifact back to `planned` for another migration pass
- leave the artifact `blocked` with a reason
- escalate to a human when automatic repair is unsafe

Remediation is intentionally **registry-only**. It should not repair a bad state by editing files directly. If another pass is needed, the artifact is requeued and the normal migration/review agents do the code work. The `legacy/` tree must remain read-only throughout; if it was changed accidentally, restore it before continuing.

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

Claims are **transactional** and lease-backed:

1. find the next artifact in the requested source status
2. ensure all dependencies are already in terminal dependency states
3. update the row to `in-progress`
4. set artifact claim bookkeeping (`claimed_by`, `claimed_at`, `claimed_from`)
5. create an active claim row with `claim_id`, `claim_token`, owner, run link, and lease expiry
6. append a `claimed` event with claim metadata

Because this is done inside a SQLite transaction, parallel sessions cannot claim the same artifact. A partial run is recovered by reconciling stale claims (expired lease or stopped owning run), which returns the artifact to its `claimed_from` status.

If nothing is claimable:

- exit code `2` means work still exists, but is blocked or already in flight
- exit code `4` means everything is finished for that scope

---

## Why the event log matters

The registry has an append-only `events` table plus a trigger:

- any artifact status change writes a `status-changed` event automatically

That means the dashboard does **not** depend on agents printing well-behaved logs. Even if an agent is chatty, quiet, or inconsistent, the operator still sees progress whenever registry state changes.

This is what powers:

- `guildctl watch`
- recent-event rendering
- phase progress output during long runs

---

## How Agent subprocesses are spawned

Implemented in `__MIGRATION_GUILDCTL__/runner.ts`.

For each spawned worker, Migration Guild:

1. resolves the strict OpenAI-compatible runtime config for the phase
2. sets the configured API key/base URL/model environment
3. spawns the agent CLI as a child process
4. records the run in `runs`
5. optionally writes stdout/stderr to a log file
6. records final exit code when the process exits

Run logging now uses deterministic timestamped filenames and richer metadata blocks, including run owner/phase/model context, claim summaries, and written-file snapshots.

Each run stores:

- `agent`
- `owner_id`
- `phase`
- `model`
- `prompt`
- `log_file`
- `pid`
- `started_at`
- `finished_at`
- `exit_code`
- `termination_reason`
- `status` (`running`, `completed`, `failed`)

---

## Failure visibility and silent-failure protection

This is the most important operational behavior.

### What Migration Guild treats as visible failure

- a spawned Agent process exits non-zero
- a run times out
- a recorded PID is no longer alive
- review makes no registry progress while migrated files remain
- migration ends with first-class artifacts still not advanced

On timeout, worker processes are terminated (`SIGTERM`, then `SIGKILL` fallback) and the run is recorded as failed.

### How this is surfaced

- run rows are marked `failed`
- exit codes are stored in `runs`
- per-run log files are preserved when logging is enabled
- migration/review now reject failed worker batches instead of treating them as mere lack of progress
- `guildctl watch` highlights long-running `in-progress` artifacts
- `guildctl release` can return stuck claims to their pre-claim state

### Stale and stuck work

There are two related but different concepts:

| Concept            | Detected from                               | Meaning                               |
| ------------------ | ------------------------------------------- | ------------------------------------- |
| **failed run**     | `runs` table / dead process / non-zero exit | the worker process itself ended badly |
| **stuck artifact** | artifact still `in-progress` for too long   | work was claimed but not advanced     |

Commands involved:

- `node migration/registry/dist/cli.js list-runs`
- `node __MIGRATION_GUILDCTL__/dist/cli.js watch`
- `node __MIGRATION_GUILDCTL__/dist/cli.js release --id "<artifact-id>"`

Environment knobs:

- `GUILDCTL_STALL_MINS` — when `watch` starts flagging claims as stalled
- `GUILDCTL_STALE_RUN_MINS` — when PID-less running rows are reaped as failed
- `GUILDCTL_REVIEW_TIMEOUT_MINS` — review worker timeout
- `GUILDCTL_ANALYZE_TIMEOUT_MINS` — analyze worker timeout
- `GUILDCTL_TEST_TIMEOUT_MINS` — test-writer worker timeout
- `GUILDCTL_CODE_TIMEOUT_MINS` — code-writer worker timeout
- `GUILDCTL_CLAIM_LEASE_MINS` — default lease duration for active claims

---

## What `guildctl watch` is showing you

Implemented in `__MIGRATION_GUILDCTL__/commands/watch.ts`.

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
node __MIGRATION_GUILDCTL__/dist/cli.js status
node __MIGRATION_GUILDCTL__/dist/cli.js watch
node migration/registry/dist/cli.js list-runs --agent review-agent
node __MIGRATION_GUILDCTL__/dist/cli.js release --id "<artifact-id>"
```

Because the registry is persistent and claims are explicit, recovery is usually a matter of correcting state and rerunning workers, not starting over.

The modernization gates are also explicit operator-visible failures:

- planning stops on critical JVM findings with a remediation command
- planning stops on unresolved dependency modernization strategies with an approval command
- migration refuses to start when unresolved dependency strategies still exist in planned work

---

## OpenAI-compatible runtime

The runtime layer is intentionally narrow:

- config resolves one OpenAI-compatible `base_url`, `model`, and `api_key_env`
- registry remains local
- file I/O remains local
- claims and status updates remain local
- no batch queue, eval scoring, tracing, embeddings, or vendor-specific agent threads

---

## Design principles

Migration Guild is built around a few core ideas:

1. **Registry first** — database state is more important than agent console output
2. **Agents are workers, not authorities** — they do work, but the registry decides progress
3. **Parallelism must be safe** — claiming is atomic and dependency-aware
4. **Recovery must be cheap** — stuck claims can be released and retried
5. **The legacy tree stays untouched** — migration always writes into `modern/`

That is the core architecture: a local, restartable migration pipeline whose control plane is SQLite and whose execution plane is spawned AI workers.

---

## Minimal CI and optional deployment follow-up

This repository change only documents the follow-up plan; it does not implement CI/CD or deployment modernization yet.

### Minimal CI validation path

- build the migrated output
- run migrated and retained tests
- run the target workspace static checks that already exist
- fail CI if dependency policy checks disagree with the approved modernization strategy state in the registry

### Optional deployment modernization path

- start from a supported Java 17+ runtime/container baseline
- move runtime configuration out of source defaults
- add health checks suitable for the target workload
- verify the deployed artifact uses only the approved modernized dependency set
