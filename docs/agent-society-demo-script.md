# Migration Guild Agent Society Demo Script

## One-sentence judge pitch

Migration Guild proves agent-society value by preventing the agent that writes code from approving it: Builders propose, Critics produce executable evidence, and Arbiters decide from recorded proof.

## Prerequisites

- Node/npm installed.
- Commands below run from the repo root unless stated.
- Do **not** run migration phases against this repo root.
- If using a real fixture, create a temporary workspace outside this repo.
- Use `--db <path>` to point commands at the fixture registry.

Example safe scratch DB path:

```bash
export GUILD_DB=/tmp/migration-guild-demo/registry.db
```

## Demo path

### 1. Show empty society state

```bash
npx --prefix migration tsx migration/guildctl/cli.ts --db "$GUILD_DB" society-report
```

Expected shape:

```text
Agent Society Report
Roles observed
Task division
Dialogue
Conflict resolution
Evidence
Efficiency hooks
```

### 2. Run or replay fixture migration safely

Use a temporary migration workspace outside this repository. The demo needs one artifact that reaches `migrated` status, representing the Builder proposal.

Narration:

> The Builder can only move work to proposed/migrated. That is not acceptance.

### 3. Attempt approval without evidence

```bash
npx --prefix migration tsx migration/guildctl/cli.ts --db "$GUILD_DB" arbitrate \
  --artifact legacy-source:com.acme:Foo \
  --approve \
  --arbiter guildctl-arbiter \
  --reason "try approving without proof"
```

Expected:

```text
Error: Artifact has no passing executable evidence...
```

Narration:

> The society rejects self-certification. No proof, no approval.

### 4. Add Critic evidence

```bash
npx --prefix migration tsx migration/guildctl/cli.ts --db "$GUILD_DB" evidence add \
  --artifact legacy-source:com.acme:Foo \
  --type test-command \
  --produced-by critic-agent \
  --command "npm test" \
  --exit-code 0 \
  --summary "Fixture tests passed"
```

Expected:

```text
✓ Evidence recorded: <evidence_id> test-command PASS
```

### 5. Arbiter approves from proof

```bash
npx --prefix migration tsx migration/guildctl/cli.ts --db "$GUILD_DB" arbitrate \
  --artifact legacy-source:com.acme:Foo \
  --approve \
  --arbiter guildctl-arbiter \
  --reason "independent passing test evidence supplied"
```

Expected:

```text
approved
```

Narration:

> The Arbiter is a separate organ. It reads evidence and changes acceptance state.

### 6. Show society report after run

```bash
npx --prefix migration tsx migration/guildctl/cli.ts --db "$GUILD_DB" society-report
```

Expected sections now show:

- dialogue counts for evidence/arbitration events
- evidence pass rate
- approved arbitration count
- role/task division

### 7. Dashboard timeline fallback

If the dashboard is available, open the registry UI and inspect the artifact detail. It should show:

- acceptance state badge
- evidence rows
- latest arbitration decision
- event timeline: Builder proposed → Critic submitted evidence → Arbiter approved/rejected

If UI is unavailable, use CLI fallback:

```bash
npx --prefix migration tsx migration/guildctl/cli.ts --db "$GUILD_DB" evidence list \
  --artifact legacy-source:com.acme:Foo
```

### 8. Record benchmark rows

```bash
BASELINE_ID=$(npx --prefix migration tsx migration/guildctl/cli.ts --db "$GUILD_DB" benchmark record \
  --mode single-agent \
  --fixture demo-fixture \
  --elapsed-ms 100000 \
  --total-runs 1 \
  --failed-runs 1 \
  --artifacts-planned 1 \
  --artifacts-completed 0 \
  --evidence-pass-rate 0 \
  --rework-count 1 \
  --verdict fail \
  --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).benchmark_id))')

GUILD_ID=$(npx --prefix migration tsx migration/guildctl/cli.ts --db "$GUILD_DB" benchmark record \
  --mode guild \
  --fixture demo-fixture \
  --elapsed-ms 70000 \
  --total-runs 3 \
  --failed-runs 0 \
  --artifacts-planned 1 \
  --artifacts-completed 1 \
  --evidence-pass-rate 1 \
  --rework-count 0 \
  --verdict pass \
  --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).benchmark_id))')
```

### 9. Compare benchmark rows

```bash
npx --prefix migration tsx migration/guildctl/cli.ts --db "$GUILD_DB" benchmark compare \
  --baseline "$BASELINE_ID" \
  --guild "$GUILD_ID"
```

Expected:

```text
Benchmark compare: baseline=<id> guild=<id>
- elapsed_ms delta: ...
- failed_runs delta: ...
- completion_rate delta: ...
- evidence_pass_rate delta: ...
- rework_count delta: ...
```

## 60-second judge narration

Migration Guild is not a single chatbot doing a migration and grading itself. It is a governed agent society. Analyzer, Builder, Critic, and Arbiter roles coordinate through a shared SQLite blackboard. A Builder can only propose migrated work. Critics submit evidence as durable rows. The Arbiter cannot approve without independent passing executable evidence. The system records the whole dialogue as events, then society-report summarizes roles, task division, conflict resolution, proof, and benchmark hooks.

## 3-minute judge narration

The core failure mode of AI migration demos is fake confidence: one agent writes code, says it looks good, and the UI declares victory. Migration Guild attacks that failure mode structurally. Work moves through a registry, not through vibes. Builder proposals land as migrated artifacts, but acceptance is blocked until proof exists. Critics produce evidence rows from tests, builds, static checks, or review verdicts. The Arbiter checks that evidence, enforces independence from the producer, records an arbitration decision, and only then promotes the artifact. Society-report and the dashboard make the social anatomy visible: roles observed, claims, dialogue events, conflicts, evidence pass rate, awaiting-arbitration work, and benchmark comparisons between single-agent and guild execution.

## Troubleshooting

- Missing DB path: pass `--db /path/to/registry.db` or set `REGISTRY_DB`.
- No migrated artifact yet: run/replay a fixture in a temporary workspace outside this repo.
- Approval fails with no evidence: add passing executable evidence first.
- Approval fails because producer equals arbiter: use different identities, e.g. `critic-agent` and `guildctl-arbiter`.
- UI unavailable: use `society-report`, `evidence list`, and `benchmark compare` as CLI fallback.

## Safety / non-goals

- Do not run migration phases against this repository root.
- Do not create repo-root `legacy/` or `modern/` fixture workspaces.
- Do not claim production-grade benchmark automation. This MVP records manual benchmark rows for honest comparison scaffolding.
