# Track 3 Agent Society Evidence Gate Implementation Plan

> **For Hermes:** Use `subagent-driven-development` to implement this plan task-by-task. Do not widen into demo polish before the evidence gate and benchmark spine are working.

**Goal:** Make Migration Guild visibly satisfy Track 3: Agent Society by adding an evidence-first acceptance gate, explicit agent negotiation/conflict records, and a single-agent-vs-guild benchmark path.

**Architecture:** Extend the existing SQLite blackboard. Builders can move artifacts to `migrated`, Critics produce evidence records and verdict events, and an Arbiter command promotes artifacts to `reviewed`/`completed` only when required evidence passes. Agent dialogue is represented as append-only events and evidence rows, not freeform chat. Benchmarks compare a single-agent baseline against the multi-agent guild pipeline on the same fixture.

**Tech Stack:** TypeScript, Node test runner, better-sqlite3, commander, existing `guildctl` CLI, mirrored runtime trees `migration/` and `package/tools/`, React dashboard.

---

## Track 3 Alignment Thesis

Migration Guild is a **blackboard society for legacy software modernization**.

It fits Track 3 because:

- **Distinct roles:** inventory, strategy, planning, analysis, test writing, building, criticism, arbitration, remediation.
- **Task division:** registry artifacts + waves + dependency readiness + claims assign work.
- **Dialogue:** events and evidence records form auditable agent-to-agent messages.
- **Conflict resolution:** claim leases resolve execution conflicts; evidence gate resolves acceptance conflicts.
- **Measured gain:** compare Guild mode against a single-agent baseline on completion, correctness, rework, time, and cost.

The judge-facing sentence:

> Migration Guild proves agent society value by structurally preventing the agent that writes code from approving it; independent Critics must produce executable evidence, and Arbiters accept only proof-backed modernization work.

---

## Existing Capabilities To Reuse

Already present in `package/tools/` and mirrored in `migration/`:

- `registry_schema.sql`
  - `artifacts` with statuses: `planned`, `analyzed`, `tests-written`, `migrated`, `reviewed`, `completed`, `needs-rework`, etc.
  - `events` append-only log.
  - `runs` for agent process records.
  - `artifact_claims` for lease-backed ownership.
  - `evaluations` for evaluator outputs.
  - `traces` for cost/latency.
  - `agent_threads` for persistent agent threads.
- `guildctl/commands/migrate.ts`
  - phases Analyzer → Test Writer → Code Writer.
  - parallel pools.
  - claim pre-assignment by status.
  - failure-aware stop behavior.
- `guildctl/commands/review.ts`
  - review-agent dispatch for migrated artifacts.
  - detects review stalling.
- `foundry/eval/commands.ts`
  - `evaluate-artifact`, `evaluate-wave`, `eval-report`.
  - current `--auto-advance` can advance based on evaluation outcome.
- UI already has operational views, runs, blockers, artifact details, quality/evaluation surfaces.
- Existing tests cover pipeline failures, planning gates, claim leases, active sessions, registry queries, and UI.

---

## Gaps To Close

### Gap 1 — Builder can still be perceived as self-approving

Current pipeline lets migrated/reviewed/completed state be too implicit. Track 3 needs a crisp acceptance boundary:

- Builder proposes completion by setting `migrated`.
- Critic emits evidence and a verdict.
- Arbiter alone accepts or rejects.

### Gap 2 — Dialogue / negotiation is not visible enough

Events exist, but judge-facing semantics need explicit event types:

- `proposal-submitted`
- `evidence-submitted`
- `critique-issued`
- `arbitration-approved`
- `arbitration-rejected`
- `conflict-opened`
- `conflict-resolved`

If adding event types is too invasive, use existing event types with structured `event_data`, but preferred implementation is explicit event types.

### Gap 3 — Evidence rows are generic evaluations, not acceptance proof

Existing `evaluations` table is useful, but Track 3 needs acceptance evidence with command, exit code, output path/snippet, and producer role.

### Gap 4 — No single-agent benchmark story

Need a minimal command/report that compares:

- `single-agent` baseline: one agent prompt/run attempts analyze+tests+code+review on fixture.
- `guild` mode: existing role-separated pipeline with evidence gate.

For MVP, benchmark can be deterministic/harness-level: seeded fixture, recorded runs, test outcomes, elapsed time, rework count, evidence pass rate.

---

## Core Design

### 1. Evidence Gate

Add an explicit evidence gate between `migrated` and `reviewed/completed`.

State flow:

```text
planned
  → analyzed
  → tests-written
  → migrated              # Builder proposal, not accepted
  → evidence-pending      # optional if adding status; otherwise migrated + no passing evidence
  → reviewed              # Critic evidence passed, Arbiter approved
  → completed             # Final accepted artifact
```

Minimal schema-compatible approach:

- Do **not** add `evidence-pending` status unless necessary.
- Keep `migrated` as “Builder proposal submitted.”
- Add `acceptance_evidence` table.
- Add `arbitration_decisions` table.
- Arbiter promotes to `reviewed` or `needs-rework`.

### 2. Evidence Records

Create table:

```sql
CREATE TABLE IF NOT EXISTS acceptance_evidence (
    evidence_id     TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    artifact_id     TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    run_id          TEXT REFERENCES runs(run_id) ON DELETE SET NULL,
    produced_by     TEXT NOT NULL,
    evidence_type   TEXT NOT NULL CHECK (evidence_type IN (
                       'test-command',
                       'build-command',
                       'static-check',
                       'review-verdict',
                       'benchmark-result'
                     )),
    command         TEXT,
    exit_code       INTEGER,
    pass            INTEGER NOT NULL CHECK (pass IN (0, 1)),
    summary         TEXT NOT NULL,
    output_path     TEXT,
    output_excerpt  TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Indexes:

```sql
CREATE INDEX IF NOT EXISTS idx_acceptance_evidence_artifact ON acceptance_evidence(artifact_id);
CREATE INDEX IF NOT EXISTS idx_acceptance_evidence_pass ON acceptance_evidence(artifact_id, pass);
CREATE INDEX IF NOT EXISTS idx_acceptance_evidence_type ON acceptance_evidence(evidence_type);
```

### 3. Arbitration Decisions

Create table:

```sql
CREATE TABLE IF NOT EXISTS arbitration_decisions (
    decision_id    TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    artifact_id    TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    arbiter        TEXT NOT NULL,
    decision       TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
    reason         TEXT NOT NULL,
    evidence_ids   TEXT NOT NULL, -- JSON array
    decided_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Rule:

- `approved` requires at least one passing `test-command` or `build-command` evidence row and no latest failing critical evidence for the same artifact.
- `rejected` sets artifact to `needs-rework` with reason.

### 4. Dialogue / Negotiation Events

Extend event types in `registry_schema.sql`, `registry/types.ts`, and `registry/commands/events.ts`:

```text
proposal-submitted
evidence-submitted
critique-issued
arbitration-approved
arbitration-rejected
conflict-opened
conflict-resolved
benchmark-recorded
```

Use structured `event_data`:

```json
{
  "role": "critic",
  "claim": "tests pass",
  "evidence_id": "...",
  "command": "npm test --prefix package/tools",
  "exit_code": 0,
  "target_status": "reviewed"
}
```

### 5. CLI Commands

Add new command group under `guildctl`:

```bash
guildctl evidence add --artifact <id> --type test-command --command "npm test --prefix ..." --exit-code 0 --summary "78 tests passed" [--output-path <path>] [--output-excerpt <text>]
guildctl evidence list --artifact <id> [--json]
guildctl arbitrate --artifact <id> [--approve|--reject] --reason <text> [--evidence <id>...]
guildctl society-report [--json]
guildctl benchmark single-agent --fixture <path> [--json]
guildctl benchmark guild --fixture <path> [--json]
guildctl benchmark compare --baseline <file> --guild <file> [--json]
```

MVP can start with:

- `evidence add`
- `evidence list`
- `arbitrate`
- `society-report`

Benchmark commands can be a second slice.

### 6. Arbiter Rule

Implement in pure registry code first:

```ts
canApproveArtifact(db, artifactId): {
  ok: boolean;
  evidenceIds: string[];
  reason: string;
}
```

Approval requires:

- artifact exists,
- artifact status is `migrated`,
- at least one passing executable evidence row:
  - `test-command`, `build-command`, or `static-check`,
- no latest failing `test-command` / `build-command` evidence after the latest passing evidence,
- arbiter is not the same as the Builder run owner if that can be detected.

MVP identity separation:

- Reject approval if `arbiter` equals latest `produced_by` for passing evidence.
- Later harden with run-owner linkage.

### 7. UI / Dashboard Changes

Minimal UI additions:

- Artifact detail shows:
  - latest evidence rows,
  - latest arbitration decision,
  - current acceptance state: `Proposed`, `Evidence Passed`, `Rejected`, `Accepted`.
- Operational view shows:
  - counts: migrated pending evidence, evidence passed awaiting arbitration, rejected/needs-rework, approved.
- Event timeline renders new event types as dialogue labels:
  - Builder proposed
  - Critic challenged
  - Critic submitted evidence
  - Arbiter approved/rejected

### 8. Single-Agent Baseline

MVP benchmark is not a full research-grade benchmark. It only needs a credible Track 3 proof.

Benchmark fixture:

- Use one small existing fixture under `package/mock/legacy-customer-utils` or a copied temp workspace outside repo root.
- Do not run migration phases against the repo root.

Metrics:

```ts
interface BenchmarkResult {
  mode: 'single-agent' | 'guild';
  fixture: string;
  startedAt: string;
  finishedAt: string;
  elapsedMs: number;
  totalRuns: number;
  failedRuns: number;
  artifactsPlanned: number;
  artifactsCompleted: number;
  evidencePassRate: number;
  reworkCount: number;
  totalCostUsd?: number;
  verdict: 'pass' | 'fail';
}
```

MVP collection sources:

- `runs` for run counts, failed runs, elapsed.
- `artifacts` for planned/completed counts.
- `acceptance_evidence` for pass rate.
- `arbitration_decisions` for rework/rejection count.
- `traces` for cost when available.

---

## Implementation Slices

### Slice 1 — Schema and Types for Evidence + Arbitration

**Objective:** Add durable evidence and arbitration records to the blackboard.

**Files:**
- Modify: `package/tools/registry_schema.sql`
- Modify: `package/tools/registry/types.ts`
- Create: `package/tools/registry/commands/evidence.ts`
- Mirror same changes in `migration/`
- Test: `package/tools/test/evidence-gate.test.ts`
- Mirror test in `migration/test/evidence-gate.test.ts`

**Steps:**
1. Add `acceptance_evidence` table and indexes.
2. Add `arbitration_decisions` table and indexes.
3. Add migrations section `ALTER TABLE` only if new columns are added; new tables can use `CREATE TABLE IF NOT EXISTS`.
4. Add TypeScript interfaces:
   - `AcceptanceEvidence`
   - `EvidenceType`
   - `ArbitrationDecision`
5. Implement command helpers:
   - `addAcceptanceEvidence(db, opts)`
   - `listAcceptanceEvidence(db, artifactId)`
   - `recordArbitrationDecision(db, opts)`
   - `getLatestArbitrationDecision(db, artifactId)`
6. Tests:
   - schema creates both tables in memory,
   - evidence rows require existing artifact,
   - `pass` must be 0/1,
   - arbitration records JSON evidence IDs,
   - helpers list newest records first.

**Verification:**

```bash
npm test --prefix package/tools -- evidence-gate.test.ts
npm test --prefix migration -- evidence-gate.test.ts
diff -rq migration package/tools | grep -v node_modules/.vite | grep -v tsconfig.app.tsbuildinfo || true
```

---

### Slice 2 — Explicit Dialogue Event Types

**Objective:** Make agent negotiation visible as first-class event types.

**Files:**
- Modify: `package/tools/registry_schema.sql`
- Modify: `package/tools/registry/types.ts`
- Modify: `package/tools/registry/commands/events.ts`
- Mirror same changes in `migration/`
- Test: extend `package/tools/test/registry-status-reason.test.ts` or create `agent-dialogue-events.test.ts`

**Steps:**
1. Add event types:
   - `proposal-submitted`
   - `evidence-submitted`
   - `critique-issued`
   - `arbitration-approved`
   - `arbitration-rejected`
   - `conflict-opened`
   - `conflict-resolved`
   - `benchmark-recorded`
2. Update `VALID_EVENT_TYPES`.
3. Update `EventType` union.
4. Add tests that `appendEvent` accepts each new type and still rejects invalid event types.

**Verification:**

```bash
npm test --prefix package/tools -- agent-dialogue-events.test.ts
npm test --prefix migration -- agent-dialogue-events.test.ts
```

---

### Slice 3 — Arbiter Approval Rule

**Objective:** Prevent acceptance without independent passing evidence.

**Files:**
- Modify/Create: `package/tools/registry/commands/evidence.ts`
- Modify: `package/tools/registry/index.ts`
- Mirror same changes in `migration/`
- Test: `package/tools/test/arbiter-gate.test.ts`

**Core helper:**

```ts
export function canApproveArtifact(db: Database.Database, artifactId: string, arbiter: string): {
  ok: boolean;
  evidenceIds: string[];
  reason: string;
}
```

**Rules:**
1. Artifact must exist.
2. Artifact status must be `migrated`.
3. There must be passing evidence with type `test-command`, `build-command`, or `static-check`.
4. Latest executable evidence must pass.
5. Arbiter must not equal `produced_by` for the evidence used.

**Approval helper:**

```ts
export function approveArtifactWithEvidence(db, { artifactId, arbiter, reason, evidenceIds? })
```

Behavior:

- if `canApproveArtifact` fails, throw `RegistryError` and do not change status.
- insert `arbitration_decisions` row with `approved`.
- append `arbitration-approved` event.
- set artifact status to `reviewed`.

**Reject helper:**

```ts
export function rejectArtifactWithEvidence(db, { artifactId, arbiter, reason, evidenceIds? })
```

Behavior:

- insert `arbitration_decisions` row with `rejected`.
- append `arbitration-rejected` event.
- set artifact status to `needs-rework`.

**Tests:**

- cannot approve `planned` artifact,
- cannot approve `migrated` artifact with no evidence,
- cannot approve with failing latest evidence,
- cannot approve when arbiter equals evidence producer,
- can approve with independent passing test evidence,
- rejection sets `needs-rework` and records decision.

---

### Slice 4 — CLI: `evidence` and `arbitrate`

**Objective:** Give operators and agents a visible command surface for proof and conflict resolution.

**Files:**
- Modify: `package/tools/guildctl/cli.ts`
- Create/Modify: `package/tools/guildctl/commands/evidence.ts`
- Create/Modify: `package/tools/guildctl/commands/arbitrate.ts`
- Mirror same changes in `migration/`
- Test: `package/tools/test/evidence-cli.test.ts`

**Commands:**

```bash
guildctl evidence add --artifact <id> --type test-command --produced-by review-agent --command "npm test" --exit-code 0 --summary "tests passed"
guildctl evidence list --artifact <id>
guildctl evidence list --artifact <id> --json
guildctl arbitrate --artifact <id> --approve --arbiter arbiter-agent --reason "passing independent test evidence"
guildctl arbitrate --artifact <id> --reject --arbiter arbiter-agent --reason "tests failed"
```

**Tests:**

- help output includes `evidence` and `arbitrate`,
- `evidence add` records evidence,
- `evidence list --json` returns rows,
- `arbitrate --approve` fails without evidence,
- `arbitrate --approve` succeeds with independent passing evidence,
- `arbitrate --reject` moves artifact to `needs-rework`.

---

### Slice 5 — Wire Review/Evaluation Into Evidence Gate

**Objective:** Turn existing review/evaluation into proof producers.

**Files:**
- Modify: `package/tools/guildctl/commands/review.ts`
- Modify: `package/tools/foundry/eval/commands.ts`
- Modify: `package/tools/foundry/eval/run-eval.ts` if needed
- Mirror same changes in `migration/`
- Test: update `pipeline-failures.test.ts`, create `review-evidence.test.ts`

**Rules:**
1. Review agent completion alone does not accept artifact unless evidence exists.
2. `evaluate-artifact --auto-advance` should no longer jump directly to final acceptance without an arbitration decision.
3. Replace risky `--auto-advance` semantics with one of:
   - `--record-evidence`, or
   - keep `--auto-advance` but make it call Arbiter helper, not direct status changes.

**Preferred MVP:**

- `evaluate-artifact` records `acceptance_evidence` rows from evaluator results.
- If `--auto-advance` is used, it calls `approveArtifactWithEvidence(... arbiter: 'guildctl-arbiter')` only when rule passes.
- Failed evaluation records evidence and rejects to `needs-rework` only if `--auto-advance` is provided.

**Tests:**

- evaluation pass records evidence,
- evaluation fail records failing evidence,
- auto-advance approval creates arbitration decision,
- auto-advance rejection creates rejection decision,
- Builder cannot self-approve through evaluation producer identity.

---

### Slice 6 — Society Report

**Objective:** Provide a judge-readable snapshot of the agent society.

**Files:**
- Create: `package/tools/guildctl/commands/society-report.ts`
- Modify: `package/tools/guildctl/cli.ts`
- Mirror same changes in `migration/`
- Test: `package/tools/test/society-report.test.ts`

**Command:**

```bash
guildctl society-report [--json]
```

**Report sections:**

- Roles observed from `runs.agent`.
- Task division:
  - artifact count by status/wave/tier.
  - active claims.
- Dialogue:
  - event counts by new dialogue event type.
- Conflict resolution:
  - claim releases/expirations/reaped runs.
  - arbitration approved/rejected counts.
- Evidence:
  - evidence pass rate.
  - artifacts awaiting evidence.
  - artifacts awaiting arbitration.
- Efficiency hooks:
  - elapsed run time from first run to last run.
  - failed/reworked runs.
  - cost from `traces` when present.

**Acceptance:** output should be understandable by a judge without reading the DB.

---

### Slice 7 — Minimal Benchmark Spine

**Objective:** Add enough benchmark machinery to claim measurable efficiency against single-agent baseline.

**Files:**
- Create: `package/tools/registry/commands/benchmark.ts`
- Create: `package/tools/guildctl/commands/benchmark.ts`
- Modify: `package/tools/registry_schema.sql`
- Mirror same changes in `migration/`
- Test: `package/tools/test/benchmark-report.test.ts`

**Schema:**

```sql
CREATE TABLE IF NOT EXISTS benchmark_runs (
    benchmark_id       TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    mode               TEXT NOT NULL CHECK (mode IN ('single-agent', 'guild')),
    fixture            TEXT NOT NULL,
    started_at         TEXT NOT NULL,
    finished_at        TEXT NOT NULL,
    elapsed_ms         INTEGER NOT NULL,
    total_runs         INTEGER NOT NULL,
    failed_runs        INTEGER NOT NULL,
    artifacts_planned  INTEGER NOT NULL,
    artifacts_completed INTEGER NOT NULL,
    evidence_pass_rate REAL NOT NULL,
    rework_count       INTEGER NOT NULL,
    total_cost_usd     REAL,
    verdict            TEXT NOT NULL CHECK (verdict IN ('pass', 'fail')),
    notes              TEXT
);
```

**Commands:**

```bash
guildctl benchmark record --mode single-agent --fixture legacy-customer-utils --elapsed-ms 1000 --total-runs 1 --failed-runs 0 --artifacts-planned 1 --artifacts-completed 1 --evidence-pass-rate 1 --rework-count 0 --verdict pass
guildctl benchmark report [--json]
guildctl benchmark compare --baseline <id> --guild <id> [--json]
```

Do not overbuild automatic baseline execution in MVP. Manual record + compare is acceptable for the hackathon if the demo shows actual recorded runs.

---

### Slice 8 — Dashboard Evidence / Arbitration Surface

**Objective:** Make society behavior visible in the UI.

**Files:**
- Modify: `package/tools/registry/commands/queries.ts`
- Modify: `package/tools/registry/commands/serve.ts`
- Modify: `package/tools/ui/src/types.ts`
- Modify: `package/tools/ui/src/api.ts`
- Modify: `package/tools/ui/src/components/ArtifactDetail.tsx`
- Modify: `package/tools/ui/src/components/QualityView.tsx` or `OperationalViews.tsx`
- Mirror same changes in `migration/`
- Tests: UI API and component tests in both trees.

**UI additions:**

- Artifact detail:
  - Evidence rows.
  - Latest arbitration decision.
  - Acceptance state badge.
- Operational view:
  - Pending evidence count.
  - Awaiting arbiter count.
  - Approved/rejected arbitration counts.
- Event timeline:
  - display new event types as society dialogue.

**Acceptance:** a judge can see “Builder proposed → Critic submitted evidence → Arbiter approved/rejected” in the dashboard.

---

### Slice 9 — Demo Script / Judge Story Doc

**Objective:** Make Track 3 story executable for humans.

**Files:**
- Create: `docs/agent-society-demo-script.md`
- Modify: `README.md` only if a short pointer is useful.

**Script outline:**

1. Show `guildctl society-report` before run.
2. Run or replay fixture migration.
3. Show artifact claimed by Analyzer/Test Writer/Builder.
4. Show Builder proposal as `migrated`.
5. Run evaluator/reviewer to record evidence.
6. Attempt Arbiter approval without evidence first if demoing conflict.
7. Add/produce passing evidence.
8. Arbiter approves.
9. Show dashboard event timeline.
10. Show benchmark report comparing single-agent vs guild.

**Judge punchline:**

> The win is not that multiple agents exist; the win is that the society has rules preventing unsafe self-approval.

---

## Acceptance Criteria

The Track 3 planning/build arc is complete when:

- `guildctl evidence add/list` works.
- `guildctl arbitrate --approve` refuses artifacts without independent passing evidence.
- `guildctl arbitrate --approve` promotes a `migrated` artifact to `reviewed` only when evidence passes.
- `guildctl arbitrate --reject` moves artifact to `needs-rework` and records reason.
- `guildctl society-report` shows roles, dialogue, evidence, conflict, and arbitration counts.
- Benchmark commands can record and compare `single-agent` vs `guild` runs.
- Dashboard or CLI clearly shows Builder → Critic → Arbiter flow.
- Tests pass in both `package/tools` and `migration`.
- Mirror diff is clean excluding cache/buildinfo noise.

---

## Verification Gates

Run after each implementation slice touching runtime code:

```bash
npm test --prefix package/tools
npm test --prefix migration
diff -rq migration package/tools | grep -v 'node_modules/.vite' | grep -v 'tsconfig.app.tsbuildinfo' || true
```

Run after UI slices:

```bash
npm run typecheck --prefix package/tools/ui
npm test --prefix package/tools/ui -- --run
npm run build --prefix package/tools/ui
npm run typecheck --prefix migration/ui
npm test --prefix migration/ui -- --run
npm run build --prefix migration/ui
```

Run before final commit:

```bash
npm run build
npm run build:dist
npx --prefix migration tsx migration/guildctl/cli.ts --help
npx --prefix package/tools tsx package/tools/guildctl/cli.ts --help
git status --short
git diff --stat
```

---

## Non-Goals

- No new generalized agent framework.
- No real-time chat UI between agents.
- No broad legacy modernization scope expansion.
- No production-grade benchmark harness in the first pass.
- No deep rename/rebrand work; already complete.
- No migration phases against the repo root.
- No credential/API-key exposure in logs/docs.

---

## Immediate Next Implementation Task

Start with **Slice 1 + Slice 2 together** because schema/types/events are the bloodstream for every later slice.

Recommended agent task packet:

```text
Implement Track 3 Agent Society Slice 1-2.

Add acceptance_evidence and arbitration_decisions tables, TypeScript types, registry helper functions, and explicit dialogue event types. Mirror all runtime changes between package/tools and migration. Add tests proving schema creation, evidence helper behavior, arbitration record behavior, and event type validation. Do not implement CLI commands yet. Run npm test --prefix package/tools and npm test --prefix migration, then verify mirror diff excluding cache/buildinfo noise.
```
