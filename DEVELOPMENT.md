# Migration Guild development guide

This file is for people changing the **kit itself**, not for users running a migration workspace.

## What this repository contains

Migration Guild has two parallel concerns:

1. **Repository-local maintainer artifacts** used while developing the kit
2. **Packaged kit artifacts** copied into user workspaces by `setup.ts`

The split matters because not everything in this repository ships.

## Source of truth by area

| Path | Purpose | Ships |
| --- | --- | --- |
| `.github/agents/` | Repo-local maintainer agents for working on the kit itself | No |
| `.github/prompts/` | Repo-local maintainer prompt shortcuts for working on the kit itself | No |
| `.github/agent-instructions.md` | Repo-local Agent context for this repository | No |
| `package/agents/` | Agent definitions installed into migration workspaces | Yes |
| `package/skills/` | Skill definitions and shipped skill assets installed into migration workspaces | Yes |
| `package/prompts/` | Prompt shortcuts installed into migration workspaces | Yes |
| `package/instructions/` | Path-scoped instructions installed into migration workspaces | Yes |
| `migration/` | Registry CLI, guildctl CLI, OpenAI-compatible runtime files, test suite | Yes |
| `setup.ts` | Installer entrypoint that copies `package/` into a target workspace | Yes, as compiled `dist/setup.js` |
| `scripts/build-dist.mjs` | Builds the distributable tarball | Dev tool |

## Shipping model

The distributable kit is built from **`package/` plus selected top-level docs and the compiled installer**.

`scripts/build-dist.mjs` assembles:

- `dist/setup.js`
- `README.md`
- `GETTING-STARTED.md`
- `AGENTS.md`
- `package/` without source-only clutter such as `node_modules`, raw TypeScript, local `.env`, repo-only working trees, or maintainer-only architecture notes

Important consequence:

- If a migration capability should exist in user workspaces, it must be represented in **`package/`**
- If something is only for maintaining this repository, keep it at the repo root (for example `.github/agents/documentation-agent.agent.md`)

## Repository layout

### Top-level docs

- `README.md` — user-facing overview
- `GETTING-STARTED.md` — setup and first-run guide
- External maintainer-only notes — deeper architecture and agent customization reference material kept outside public repository history
- `DEVELOPMENT.md` — maintainer workflow and packaging rules
- `CHANGELOGS.MD` — repository-level change log for ongoing development

### Branching policy

- `dev` is the default and integration branch. All new PRs and fixes target `dev` first; direct commits to `dev` are allowed (ungated).
- `main` is release-only. Nothing lands on `main` except promotion merges from `dev` (PR) or an emergency quickfix PR that must then be back-merged into `dev` immediately so `main` never drifts ahead.
- `main` is protected by a GitHub ruleset (`protect-main-pr-only`): PR required, no force-push, no deletion, no bypass actors.
- A pre-commit hook ships in `.githooks/` (enable with `git config core.hooksPath .githooks`): staged-diff secret scan, direct-commit guard on `main`/`master`, and the repo build+test gate.

### Runtime and packaging paths

- `migration/` — canonical source for the registry and guildctl CLIs, test suite, and runtime code
- `dist/` — compiled installer and assembled tarball output
- `package/mock/` — packaged sample fixture content for setting up a separate test workspace

## Core workflows

### 1. Update repo-local maintainer behavior

Use the root `.github/` tree only when you are changing how Agent helps maintain **this repository itself**.

Typical examples:

- dev-only agents
- repo-local prompt shortcuts
- maintainer instructions

These changes do not ship.

### 2. Update shipped migration behavior

Use `package/` when you are changing what users receive after running the installer.

Common paths:

- `package/agents/`
- `package/skills/`
- `package/prompts/`
- `package/instructions/`
- `package/agent-instructions.md`

Do not mirror shipped agents, skills, prompts, or instructions into root `.github/`. `package/` is the source of truth for shipped Agent runtime behavior.

### 3. Test shipped behavior

Do not use this repository root as a migration workspace.

Instead:

1. Create a fresh workspace outside this repository.
2. Install the kit there with `npx guildctl-setup` or by unpacking the built tarball.
3. Copy a fixture into that external workspace when you need a reproducible migration scenario.

Use `package/mock/` for maintained sample content instead of recreating `legacy/` or `modern/` at the repo root.

#### Run the repository test suites

From the Migration Guild repository root, install both test suites and run them with one command:

```bash
(cd migration && npm install) && (cd migration/ui && npm install) && npm test
```

### 4. Update installer behavior

`setup.ts` is the installer source. It:

- copies packaged agents, prompts, skills, and instructions into `.github/`
- writes `.github/agent-instructions.md` with the selected target framework
- optionally clones or copies legacy source into `legacy/`

If setup behavior changes, update:

- `setup.ts`
- packaged files under `package/` if the installed workspace should change
- user-facing docs if setup flow or resulting layout changes

### 5. Build the repo

Common commands:

```bash
npm run build
npm run build:dist
```

What they do:

- `npm run build` compiles `setup.ts` to `dist/setup.js`
- `npm run build:dist` runs the cross-platform dist builder, builds `migration/`, rebuilds `dist/setup.js`, then assembles `dist/__GUILDCTL_KIT_TGZ__`

Install locations (all three, up front):

- repo root: `npm install`
- `migration/`: `cd migration && npm install`
- `migration/ui/`: `cd migration/ui && npm install`

`npm run build:dist` performs the two nested installs automatically before its `tsup` and `build:ui` steps, so a fresh clone only needs the root `npm install` before running it. The root `npm test` gate, however, runs the `migration/` and `migration/ui/` suites directly and needs all three installs done once (see "Run the repository test suites").

## Source of truth

- `migration/` is the canonical source for CLI runtime code
- `package/` contains shipped Agent artifacts (agents, skills, prompts, instructions) but NOT runtime code
- Do not mirror runtime code between directories

For Agent artifacts, `package/` is the shipped source of truth and root `.github/` is repo-only maintainer context. Do not reintroduce mirrored runtime copies under root `.github/`.

## Inventory classification quality contract

Stack packs must provide a structured `classification.yaml` and reference it from `stack.yaml` with `classification_spec: classification.yaml`.

Required fields:

- `frameworks.allowed`: canonical source framework identifiers accepted in the registry.
- `frameworks.aliases`: normalization map for human/model variants.
- `frameworks.fallback`: canonical no-evidence fallback. Java uses `plain-java`; never use broad `Java-EE` as fallback.
- `frameworks.ambiguous`: canonical value for equal-precedence conflicting evidence.
- `roles.allowed`: registry role vocabulary only; do not invent stack-specific roles like `servlet`.
- `modules.source_roots`: stack-defined source-root regex rules that derive `artifact.module` from build/source-set ownership, not package names. Java examples: `legacy/app/src/main/java/...` → `app`, `legacy/app/src/test/java/...` → `app-test`, `legacy/it-selenium/src/test/java/...` → `it-selenium-test`, `legacy/db-utils/src/main/java/...` → `db-utils`.
- `signals`: deterministic source/path regex signals with `framework`, `role`, `priority`, `confidence`, and human-readable `evidence`.
- `quality.fallback_max_percentage`: advisory concentration threshold for large inventories unless the stack explicitly sets `fallback_concentration: error`.
- `quality.fallback_min_confidence` and `quality.fallback_required_evidence`: fallback records must prove high-confidence negative evidence. A mostly plain-code project can pass; files with configured framework signals may not silently fall through to fallback.
- `tags.generic` / `tags.meaningful`: lifecycle tags such as `analyzed` are generic and do not count as classification evidence.

Runtime contract:

- `guildctl` owns source scanning and first-class artifact registration.
- The context agent classifies that expected ID set only; it must not register extras unless a future orchestrator explicitly delegates second-class discovery. Inventory snapshots the registry before agent execution and rolls back any agent-created first- or second-class records on failure, while preserving legitimate pre-existing second-class artifacts.
- Classifications should be submitted via `registry batch-classify --file <json>`.
- `batch-classify` validates all rows before mutation, rejects duplicates/unknown IDs/unsupported frameworks/unsupported roles/missing evidence, supports `--dry-run`, and applies accepted records transactionally.
- The agent must run `registry mark-inventory-complete` after successful batch application. Exit code zero alone is not completion evidence.
- `guildctl run inventory` runs validation and refuses to print `Inventory complete` when quality fails.
- `guildctl run plan` independently re-runs the inventory-quality gate before stack-advisor/planner work.

Existing workspaces should run `node migration/dist/registry/cli.js migrate` (or rerun any guildctl phase, which applies schema idempotently) to create `artifact_classifications`, then rerun inventory so classifications are normalized under the active stack pack. Workspaces from the older package-derived-module scanner should clear and rescan inventory rather than reusing IDs/modules such as `org.apache...`: current Java module semantics are build/source-set ownership. Safe reset sequence for a failed inventory is:

```bash
# from the workspace using the packaged runtime paths
node migration/dist/registry/cli.js migrate
sqlite3 .guild/registry.sqlite "DELETE FROM artifact_classifications; DELETE FROM artifact_tags WHERE artifact_id IN (SELECT id FROM artifacts WHERE kind='legacy-source'); DELETE FROM artifacts WHERE kind='legacy-source'; DELETE FROM operator_state WHERE key='inventory_completion';"
GUILDCTL_INVENTORY_TIMEOUT_MINUTES=45 node migration/dist/guildctl/cli.js run inventory
node migration/dist/guildctl/cli.js run plan
```

Preserve hand-curated second-class descriptor/config artifacts unless they were created by the failed inventory run; inventory failure cleanup now handles newly-created unauthorized records automatically.

## Claim lease and run lifecycle notes

Recent runtime behavior depends on lease-backed claims and run-linked ownership.

Operator/runtime expectations:

- Claims are now represented by `artifact_claims` rows with `claim_id` + `claim_token` and lease timestamps.
- Worker runs are recorded with stable run IDs and ownership metadata (`owner_id`, `phase`) before subprocess launch.
- Worker agents are expected to claim exactly one artifact per run, heartbeat before finalizing, then advance status with claim credentials.
- Claim cleanup can happen by run ID, owner ID, lease expiry, or stale-run reconciliation.

Environment knobs introduced for migration pool reliability:

- `GUILDCTL_ANALYZE_TIMEOUT_MINS`
- `GUILDCTL_TEST_TIMEOUT_MINS`
- `GUILDCTL_CODE_TIMEOUT_MINS`
- `GUILDCTL_CLAIM_LEASE_MINS`

If any of the above semantics change, update both maintainer docs (`DEVELOPMENT.md`, `CHANGELOGS.MD`) and any external maintainer-only runtime architecture notes.

## Always-on supervisor staleness sweep (015-supervisor-staleness-sweep, issue #218)

`runAutoQueue` (`migration/guildctl/supervisor/queue.ts`) re-invokes the same
`reapDeadRuns`/`reconcileStaleClaims` pair it already runs once at startup at
loop-iteration boundaries, so a claim or run that goes stale mid-`auto-run`
session self-heals without an operator running `guildctl doctor`/`guildctl
repair`.

- New environment variable: `GUILDCTL_SWEEP_INTERVAL_MINS` — minutes between
  periodic sweeps, default `10`. Unset, empty, `0`, negative, or non-numeric
  values all fall back to the default (`resolveSweepIntervalMs()`), following
  the same parsing convention as `GUILDCTL_STALL_MINS`
  (`migration/guildctl/monitoring.ts`). Not exposed as a CLI flag.
- Findings merge into the existing `AutoQueueResult.recoveredArtifacts` array
  (deduplicated against the startup sweep); no new field was added to keep
  existing JSON-output consumers unaffected.
- A periodic sweep that recovers something writes one distinctly-labeled
  `[guildctl]` line live (via `AutoQueueOptions.write`, threaded from
  `runAutoRunCommand` in `migration/guildctl/commands/auto-run.ts`); a clean
  sweep is silent; a sweep that throws is caught, reported as a non-fatal
  warning line, and never aborts the queue.
- Scope boundary: this applies to `auto-run`'s queue loop only. Standalone
  `guildctl auto` (`migration/guildctl/commands/auto.ts`), `guildctl doctor`,
  and `guildctl repair` are unchanged.

## Truthful run state (001-truthful-run-state)

Run/claim lifecycle and reporting changes from this feature:

- `runs` gained eight attempt-outcome columns (`files_written_count`, `files_written_source`,
  `status_from`, `status_to`, `budget_consumed`, `cleanup_outcome`, `survivor_pids`,
  `outcome_label`), all nullable/defaulted so existing rows and consumers keep working. A new
  `artifact_verifications` table carries verification state as a fact distinct from migration
  status — never a gate, never a substitute for `acceptance_evidence`.
- `finishRun` (`migration/registry/commands/runs.ts`) validates these fields' domains and
  rejects `outcome_label: "succeeded"` when `status_from` equals `status_to`.
- Agents now spawn as process-group leaders (`detached: true`) in both the manual runner
  (`migration/guildctl/runner.ts`) and the autonomous paths (`migration/guildctl/commands/auto.ts`).
  Terminating an attempt terminates the whole tree it started (`terminateProcessGroup()` in
  `migration/guildctl/util.ts`), not only the direct child — this was a structural gap before
  (`proc.kill()` only reached the harness shim, not the binary it spawned).
  Operator `SIGINT`/`SIGTERM` is forwarded into the group.
- Per-phase timeout knobs (`GUILDCTL_ANALYZE_TIMEOUT_MINS` and siblings) are resolved through
  the single `resolveEffectiveLimit()` in `migration/guildctl/limits.ts` rather than being
  read ad hoc per phase command; `guildctl limits` reports the four-tier precedence
  (per-phase setting → environment override → project configuration → built-in default) before
  a run.
- `AutonomousLimitError` (`migration/guildctl/limits.ts`) distinguishes a descriptor-derived
  limit termination from every other autonomous review failure — only the former routes through
  a non-throwing per-artifact close-out; every other review failure (identity mismatch,
  malformed marker) still fails closed by propagating out of `runAuto`.

New `migration/test/` suites added by this feature: `registry-schema-delta.test.ts`,
`run-outcome-plumbing.test.ts`, `runtime-resolution.test.ts`, `process-group-primitives.test.ts`,
`verification-state.test.ts`, `verification-bounds.test.ts`, `preflight-resolved-path.test.ts`,
`env-precedence.test.ts`, `limit-knob-naming.test.ts`, `attempt-outcome.test.ts`,
`process-tree-termination.test.ts`, `context-retrieval.test.ts`, and the shared (non-`.test.ts`)
fixture helper `truthful-run-state-fixtures.ts`.

Maintainer checklist answers for this feature: repo-only (registry/guildctl runtime, no new
shipped Agent artifact except the `package/agent-instructions.md` and packaged-agent doc
updates, and the `verify:` stack-pack blocks); `package/` updated for the four context-consuming
agents and `stacks/*/stack.yaml` ↔ `package/stacks/*/stack.yaml` parity; `migration/` updated
extensively (see above); this file and `CHANGELOGS.MD` updated.

## Operational hardening (012-guildctl-operational-hardening)

Nine operator-facing fixes landed across the registry + guildctl runtime (issues #150, #151,
#153–#159). What a maintainer needs to know:

- **Runtime evidence authenticity is HMAC-bound to the producing run's operator token.** A
  credential from any other run (including the ad-hoc run `guildctl arbitrate` mints when no
  `--run-id`/`--operator-token` is supplied) can never validate that evidence —
  `validateRuntimeEvidence` rejects it with "Approval run credential does not match runtime
  evidence." This is by design; manual arbitration succeeds when the operator supplies the
  evidence run's own credential via the new flags.
- **Verify concurrency is lease-gated by the `verify_slots` table** (atomic
  insert-if-under-limit acquire, release-on-finally, stale-lease reclamation). The cap is
  `verification.max_concurrent` (default `max(os.cpus().length - 1, 1)`), overridable via
  `GUILDCTL_VERIFY_MAX_CONCURRENT`. Both verify spawn sites (`runVerify`'s exec path and
  `runArtifactVerification`'s structured check) hold a slot for the subprocess lifetime.
- **The `migrated` write in `setArtifactStatus` is gated by `wardenRestoredOwnOutput()`** — if a
  `filesystem-violation` restore touched the claim's own `expected_output_paths`, the write
  throws `RegistryError` and the artifact routes to blocked/failed instead of a false
  `migrated`.
- **`claimArtifactById` takes an explicit `fromStatuses: Status[]`** and records the artifact's
  actual status as `from_status`, so release-return and resume-eligibility stay consistent
  (`blocked` is resume-eligible; unsupported states produce a clean `RegistryError`).
- **The supervisor stops re-verifying after a `remediation-confirmed-no-defect` event** for the
  artifact; the event type is admitted to existing DBs by a CHECK-widening table rebuild
  (`ensureRemediationNoDefectEventType`), following the `acceptance_evidence` precedent.
- **Preflight's probe budget is `PREFLIGHT_PROBE_MAX_TOKENS = 256`** and
  `isReasoningTokenExhaustion()` distinguishes the empty-completion-with-reasoning-tokens shape
  (reports "model needs a larger token budget") from a generic empty completion.
- **`setup.ts` is non-TTY-safe**: an up-front `!process.stdin.isTTY` short-circuit plus a
  per-`ask()` `close`/EOF backstop resolving each remaining prompt to its documented default
  (with a stderr note). GETTING-STARTED's non-interactive note matches this behavior.

**Maintainer lesson — root ↔ `package/` byte parity.** `.env.example` and `stacks/**/stack.yaml`
exist in BOTH the repo root and `package/` (the parity tests treat root as the source of truth).
Editing only the root copy breaks the full suite's packaging/parity tests. After touching either,
mirror root → `package/` (or edit `package/` and promote) before running `npm test`.

## Approval gate + attempt history (013-approval-gate-attempt-state)

High-risk artifacts now require a human approval step, and every migrate attempt is persisted.
What a maintainer needs to know:

- **A new artifact status `pending-approval` sits between `migrated`/`reviewed`.** An approving
  arbitration verdict on an above-cutoff high-risk artifact holds it at `pending-approval`
  instead of promoting to `reviewed`. Claim eligibility is unaffected by construction
  (`claimNextTask`/`claimArtifactById` use explicit `from_status` allow-lists that do not
  include `pending-approval`), so held artifacts are never claimable; the supervisor surfaces
  them as "held for approval" with a distinct `heldForApproval` count, never as blocked/failed.
- **Human decisions live in the `approval_decisions` table** (decision_id, artifact_id,
  operator, operator_token_hash, run_id, decision ∈ approved/rejected, reason — NULL on
  approve, required on reject — evidence_snapshot_json, decided_at), written by
  `recordApprovalDecision` in `migration/registry/commands/approval.ts`. Approve →
  `reviewed`; reject → `needs-rework`.
- **CLI path:** `guildctl approve --list` (backed by `listPendingApprovals`) shows the held set
  with risk reason codes + arbiter verdict; `guildctl approve <id> [--reject --reason ...]`
  resolves it. `guildctl arbitrate` output gained additive `artifactStatus`/`heldForApproval`
  fields reporting the actual post-verdict status.
- **Attempt history lives in `attempt_records`** ((artifact_id, attempt_no) PK, run_id, phase,
  outcome ∈ succeeded/failed/budget-exhausted, failure_kind/signature, started/finished
  timestamps), written from the supervisor loop; the persisted retry budget survives restarts
  with no double-counting.
- **Mission Control API:** `GET /api/approvals` (exactly the `listPendingApprovals` set),
  `GET /api/approvals/history`, `POST /api/approvals/<id>/decision` (dashboard decisions use a
  mission-control operator identity; `RegistryError` → clean 4xx JSON).

Maintainer checklist answers for this feature: repo-only runtime change (registry/guildctl/
supervisor/UI — no new shipped Agent artifact, no `package/` capability change required);
`package/` NOT updated (no user-workspace-facing capability added; the approve CLI and gate are
runtime behavior in `migration/`); `migration/` updated (schema: `pending-approval` status +
`approval_decisions`/`attempt_records` tables + widened event-type CHECKs; approval gate in
evidence path; `approve` command; supervisor held-handling + `heldForApproval` count; Mission
Control approvals API + Approvals panel); `DEVELOPMENT.md` updated (this section — claim/run
lifecycle semantics changed via the new `pending-approval` status); `CHANGELOGS.MD` updated
(Spec 013 entry under Unreleased).

New `migration/test/` suites added by this feature: `arbitrate-manual-approval.test.ts`,
`verify-stack-default.test.ts`, `auto-resume-blocked.test.ts`,
`warden-revert-blocks-migrated.test.ts`, `verify-slot-concurrency.test.ts`,
`stale-dist-path-consistency.test.ts`, `preflight-reasoning-model-budget.test.ts`, and
`setup-non-tty-fallback.test.ts` (plus extensions to `supervisor-failures.test.ts` and
`preflight-resolved-path.test.ts`).

Maintainer checklist answers for this feature (per fix): all nine are repo-runtime changes —
(1)–(5), (7), (9) touch `migration/` only (registry commands, guildctl supervisor/verify/
preflight, `registry_schema.sql`); (6) also touches shipped prompt/agent templates under
`package/` (the stale-path sweep) — `package/` updated; (8) is docs-only (`README.md`,
`GETTING-STARTED.md`); the javac memory bound touches `stacks/java-spring/stack.yaml` with the
`package/stacks/` parity copy restored. `migration/` updated as above; this file and
`CHANGELOGS.MD` updated.

### Spec 016 — run status vocabulary on the operator dashboard (#220)

- **Four-state label, derived at read time, no schema changes:** a new
  `queryRunStatusForUI` function in `migration/registry/commands/queries.ts` computes
  `working` | `idle` | `waiting-for-approval` | `rejected` per non-terminal artifact
  (precedence in that order) from `artifact_claims.state`/`heartbeat_at`/`claimed_at` and
  the existing spec-013 `listPendingApprovals`/`arbitration_decisions` read paths — no new
  tables/columns, no duplicated query logic.
- **`WORKING_RECENCY_THRESHOLD_MS`** (5 minutes, `migration/registry/types.ts`) governs the
  `working`/`idle` split. Deliberately separate from `guildctl doctor`'s 60-minute
  `danglingClaimThresholdMs` and from issue #218's supervisor sweep interval (default 10
  minutes) — the three answer different questions ("actively progressing right now" vs.
  "probably abandoned" vs. "how often the supervisor re-checks staleness") and are not
  reconciled by this feature (see spec.md Assumptions).
- **Mission Control API:** `GET /api/run-status` — array of `{ artifact_id, label,
  heartbeat_age_ms }`, one entry per non-terminal artifact.
- **UI:** a shared `RunStatusBadge`/`RunStatusLegend` component
  (`migration/ui/src/components/RunStatusBadge.tsx`) renders the four-state vocabulary,
  wired into the Artifacts tab (per-artifact "Run status" column) and the dashboard header
  legend via a new `useRunStatus()` hook polling on the existing 5s cadence — no new polling
  mechanism. The existing `ApprovalsPanel` approve/reject data path and behavior are
  unchanged (regression-tested by `test/approval-dashboard-parity.test.ts` and
  `ApprovalsPanel.test.tsx`, run unmodified).

Maintainer checklist answers for this feature: repo-only runtime change (registry + Mission
Control UI — no new shipped Agent artifact, no `package/` capability change required);
`package/` NOT updated (no user-workspace-facing capability added); `migration/` updated
(`queryRunStatusForUI` + `GET /api/run-status` + `RunStatusBadge` UI, no schema changes);
`DEVELOPMENT.md` updated (this section); `CHANGELOGS.MD` updated (Spec 016 entry under
Unreleased).

New `migration/test/` suites added by this feature: `run-status.test.ts` (registry-layer
derivation, precedence, FR-006 recency-fallback, terminal-status exclusion) and
`serve-run-status.test.ts` (`GET /api/run-status` HTTP plumbing). New
`migration/ui/src/components/RunStatusBadge.test.tsx` covers the four-state rendering and
the poll-cycle badge update (SC-003/FR-011).

## Docs expectations for this repo

Use docs by audience:

- **Users of the kit** → `README.md`, `GETTING-STARTED.md`
- **Maintainers of the kit** → `DEVELOPMENT.md`, `CHANGELOGS.MD`

When a change affects maintainer workflow, packaging, source-of-truth boundaries, or repo-local automation, capture it in `DEVELOPMENT.md`.

When a change is notable enough that future maintainers should see it in chronological form, add it to `CHANGELOGS.MD` under `Unreleased` using a human-readable date heading with the related items listed beneath it, for example `### April 10, 2026`. These headings group unreleased development batches; they are not release dates.

## Documentation agent

This repository has a repo-local `documentation-agent`.

Current intent:

- keep maintainer docs current while the broader docs set is still evolving
- avoid touching shipped kit files just to document repo-only workflows
- keep the workflow lightweight locally until repository/CI automation is provisioned

Current doc targets:

- `DEVELOPMENT.md`
- `CHANGELOGS.MD`

### Run it manually

```bash
agent --agent documentation-agent --yolo -p \
  "Review the staged changes for the current commit in this repository. Update only DEVELOPMENT.md and CHANGELOGS.MD when the staged behavior changes require maintainer workflow notes or an unreleased changelog entry grouped under the appropriate human-readable date heading. If no such docs changes are needed, do not edit anything."
```

Then review only the maintainer docs:

```bash
git status --short -- DEVELOPMENT.md CHANGELOGS.MD
```

### Future automation

- Preferred end state: run the documentation agent after CI, not in `pre-commit`
- Until repo/CI provisioning is available, keep this as a manual maintainer step

### Agent binary selection

Migration Guild supports multiple agent harnesses (adapters). Each adapter wraps a specific agent CLI and conforms to the same contract: `--agent`, `--model`, `--yolo`/`--read-only`, `-p <prompt>`. See **[package/harness/HARNESS.md](package/harness/HARNESS.md)** for the full guide, setup instructions, and troubleshooting.

Available harnesses:

| Harness | RSS/agent | Best for |
|---|---|---|
| `goose` | ~113MB | Remediation, review, audit — memory-constrained VPS |
| `opencode` (default) | ~478MB | Codegen, test-writer — rich tooling, granular permissions |
| `codex` | varies | OpenAI-native environments |
| custom (`AGENT_CMD`) | varies | Any CLI that accepts the harness contract |

Set in `.guild/config.yaml`:
```yaml
harness: goose   # or opencode, codex
```

Or override per-run with `AGENT_CMD`:
```bash
AGENT_CMD=/path/to/agent agent --agent documentation-agent --yolo -p "<prompt>"
```

## Practical maintainer checklist

When making a change, ask:

1. Is this repo-only, or should it ship?
2. If it should ship as an Agent artifact, did I update `package/`?
3. If it changes CLI/runtime code, did I update `migration/`?
4. If it changes maintainer workflow, did I update `DEVELOPMENT.md`?
5. If it is worth recording for later context, did I add it to the correct `Unreleased` date group in `CHANGELOGS.MD`?
