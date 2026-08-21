# Benchmarking & Society Report — Deep Dive

## Overview

The Migration Guild has two distinct measurement surfaces, plus a third "society" observability report:

1. **Mode benchmarks** (`single-agent` vs `guild`) — a governed-pipeline-vs-ungoverned-baseline comparison. The registry side lives in `migration/registry/commands/benchmark.ts`; the orchestration CLI that actually *runs* the migrations and records results lives in `migration/guildctl/commands/benchmark.ts`. Results are persisted in the `benchmark_runs` table of `registry.db`.
2. **Doc-RAG hallucination benchmark** (`with-lookup` vs `without-lookup`) — a separate axis (spec `007-doc-rag-lookup`, T038 / SC-003) measuring whether registering the doc-RAG lookup tool reduces Critic-flagged API-hallucination findings by ≥50%. Lives in `migration/registry/commands/doc-rag-benchmark.ts`, persisted in its own `doc_rag_benchmark_runs` table.
3. **Society report** (`migration/guildctl/commands/society-report.ts`) — not a benchmark per se: a point-in-time aggregate snapshot of the whole agent society (roles, task division, dialogue event counts, conflict resolution, evidence, efficiency hooks), rendered as human text or JSON.

Related tests: `migration/test/benchmark-metrics.test.ts`, `migration/test/benchmark-report.test.ts`, `migration/test/doc-rag-hallucination-benchmark.test.ts`, `migration/test/society-report.test.ts`, `migration/test/society-api.test.ts`, plus adjacent-but-distinct deterministic benchmarks in `migration/test/disposition-benchmark.test.ts` (dependency-disposition SC-003, ≥90% correct proposals) and `migration/test/index-db-search-benchmark.test.ts` (doc-RAG search quality SC-006).

---

## What each benchmark measures

### Mode benchmark (single-agent vs guild)

`deriveBenchmarkMetrics` (`migration/registry/commands/benchmark.ts:39`) derives all metrics **exclusively from the registry's terminal state** — it never trusts agent self-reports:

| Metric | Source query |
|---|---|
| `totalRuns` | `COUNT(*) FROM runs` |
| `failedRuns` | runs with `status = 'failed'` or non-zero non-null `exit_code` |
| `artifactsPlanned` | `COUNT(*) FROM artifacts` |
| `artifactsCompleted` | artifacts with `status = 'reviewed'` |
| `evidencePassRate` | passed / total rows in `acceptance_evidence` (0 when total is 0) |
| `reworkCount` | events whose JSON payload contains `new_status` or `target_status` equal to `'needs-rework'` |

The verdict rule (`benchmark.ts:57-59`):

```ts
const completed = artifactsPlanned > 0 && artifactsCompleted === artifactsPlanned;
const evidenceSatisfied = mode === "single-agent" || evidencePassed > 0;
const verdict = completed && failedRuns === 0 && evidenceSatisfied ? "pass" : "fail";
```

Note the deliberate asymmetry: the ungoverned baseline (`single-agent`) creates no acceptance evidence by design, so it is exempt from the evidence requirement; the guild mode must have at least one passing evidence row.

### Doc-RAG hallucination benchmark

`recordDocRagBenchmarkRun` (`migration/registry/commands/doc-rag-benchmark.ts:96`) records one run of a fixture with mode `with-lookup` or `without-lookup`, capturing `hallucinationFindings` — the count of Critic findings whose reference matched a `verify_library_docs` `verified-absent` outcome (FR-010) — and `totalReferencesChecked`.

`compareDocRagBenchmarkRuns` (`doc-rag-benchmark.ts:145`) fetches the **latest run per mode for the same fixture** and computes:

```ts
const reductionRatio = withoutLookupFindings === 0 ? 1 : 1 - withLookupFindings / withoutLookupFindings;
const verdict = withoutLookupFindings === 0 || withLookupFindings <= 0.5 * withoutLookupFindings ? "pass" : "fail";
```

SC-003 target: with-lookup findings must be at least 50% lower than without-lookup; a zero-finding baseline trivially passes.

### Society report

`querySocietyReport` (`migration/guildctl/commands/society-report.ts:55`) aggregates six sections:

- **roles**: run counts grouped by `agent` from `runs`.
- **task_division**: artifact counts by `status`, `wave`, `tier`, plus active claims (`artifact_claims WHERE state = 'active'`).
- **dialogue**: counts of eight fixed event types (`DIALOGUE_TYPES`, `society-report.ts:4-13`): proposal-submitted, evidence-submitted, critique-issued, arbitration-approved/rejected, conflict-opened/resolved, benchmark-recorded.
- **conflict_resolution**: claim releases/expirations and reaped runs (event-type counts), plus approved/rejected arbitration decisions from `arbitration_decisions`.
- **evidence**: total/passed/failed evidence rows, pass rate, artifacts still awaiting evidence (`status='migrated'` with no evidence row), and artifacts awaiting arbitration (`migrated` with passing hard evidence of type `test-command`/`build-command`/`static-check` but no approved decision).
- **efficiency**: elapsed wall-clock runtime across all runs (`MIN(started_at)` to `MAX(COALESCE(finished_at, started_at))`, clamped at 0), failed runs, and artifacts currently in `needs-rework`.

---

## Flow walkthrough

### End-to-end mode benchmark: `runBenchmarkRun`

`runBenchmarkRun` (`migration/guildctl/commands/benchmark.ts:237`) drives everything:

1. Validates mode (`guild` | `baseline` | `both`, default `both`) and reports the runtime once up front (FR-024).
2. `ensureToolsBuilt` (`benchmark.ts:60`) runs tsup on `package/tools` so each workspace has built `registry/dist/cli.js` and `guildctl/dist/cli.js`; it gates on the actual output files existing rather than tsup's exit code.
3. For each selected mode, `executeMode` (`benchmark.ts:135`):
   - `copyWorkspace` (`benchmark.ts:80`) materializes a fresh temp workspace: fixture copied into `legacy/`, empty `modern/`, tools into `migration/`, harness, stacks, agents/skills/instructions, `.env.example` + `agent-shim.mjs`, and a **symlinked** `migration/node_modules`.
   - **Baseline path**: a single `guildctl benchmark baseline-worker` invocation → `runBenchmarkBaselineWorker` (`benchmark.ts:160`) spawns one `migration-agent` told to migrate every Java file in one pass and self-mark reviewed, explicitly forbidden from creating evidence or arbitration ("the intentionally ungoverned baseline").
   - **Guild path**: sequential phases `inventory → plan → bootstrap → migrate --parallel 1 → benchmark guild-review-worker`, then a rework loop: while any artifact is `needs-rework`, run `guild-rework-worker` then `guild-review-worker`, breaking if the count stops shrinking (guards against infinite loops).
   - `executeCli` (`benchmark.ts:106`) retries each phase up to 3 attempts with 5 s backoff (transient model-API flakes), setting `GUILD_WORKSPACE`, `REGISTRY_DB`, and auto-confirm/auto-approve env vars.
4. Back in `runBenchmarkRun`, the workspace DB is reopened read-only, `deriveBenchmarkMetrics` computes metrics, and `recordBenchmarkRun` writes them into the **host** registry with `notes: workspace=<path>`.
5. If both modes ran, `runBenchmarkCompare` prints the delta table automatically.

### Recording / reporting / comparing (CLI surface)

- `runBenchmarkRecord` (`guildctl/commands/benchmark.ts:34`) — manual record; prints `✓ Benchmark recorded: <id> <mode> <fixture> <verdict>` or full JSON.
- `runBenchmarkReport` (`benchmark.ts:39`) — lists runs newest-first via `listBenchmarkRuns`, computing completion % inline (`artifacts_planned === 0 ? 0 : completed/planned`).
- `runBenchmarkCompare` (`benchmark.ts:48`) — enforces baseline=`single-agent`, guild=`guild` (via `compareBenchmarkRuns`, `registry/commands/benchmark.ts:139`) and prints six deltas: elapsed_ms, failed_runs, completion_rate, evidence_pass_rate, rework_count, total_cost_usd (the last only when both runs recorded costs).

### Doc-RAG benchmark flow

There is no orchestrating CLI command; the flow is test-driven (`migration/test/doc-rag-hallucination-benchmark.test.ts`). The real Migrate→Critic pipeline execution is **environment-gated** behind `RUN_HALLUCINATION_BENCHMARK === "1"`; when unset, the test records two clearly-marked env-gated zero-finding runs (notes `"env-gated: opencode/network absent; pipeline not executed"`) purely to exercise persistence + comparison honestly. `applyDocRagBenchmarkSchema` (`doc-rag-benchmark.ts:77`) is idempotently invoked before every write/read, so the table can exist even though it is not part of the main `registry_schema.sql`.

### Society report flow

`runSocietyReport` (`society-report.ts:103`) calls `querySocietyReport` and either dumps pretty-printed JSON or renders labeled sections ("Roles observed", "Task division", "Dialogue", "Conflict resolution", "Evidence", "Efficiency hooks"). A per-artifact drill-down exists in `querySocietyArtifactReport` (`society-report.ts:92`), returning the artifact's evidence and arbitration decisions ordered oldest-first.

---

## Data model / storage

### `benchmark_runs` (main schema)

Created by the central registry schema; columns mirror `RecordBenchmarkRunOptions` (`registry/commands/benchmark.ts:6-21`): `mode` CHECK(`single-agent`|`guild`), `fixture`, `started_at`/`finished_at` (defaulting to `datetime('now')`), `elapsed_ms`, `total_runs`, `failed_runs`, `artifacts_planned`, `artifacts_completed`, `evidence_pass_rate`, `rework_count`, nullable `total_cost_usd`, `verdict` CHECK(`pass`|`fail`), `notes`. IDs come from the schema default; lookup helpers are `getBenchmarkRun` (throws `RegistryError(2)` when missing) and `listBenchmarkRuns` (filterable by mode/fixture, ordered `started_at DESC, rowid DESC`).

Recording also appends a `benchmark-recorded` event (`benchmark.ts:117-120`) attached to the **first-created artifact** (`ORDER BY created_at LIMIT 1`) with agent `benchmark-runner` — this is why `benchmark-recorded` appears in the society report's dialogue types.

### `doc_rag_benchmark_runs` (sidecar schema)

Defined inline in `doc-rag-benchmark.ts:61-74`: `benchmark_id` TEXT PK generated by `makeId()` (`drb-<base36-time>-<rand>`), same timing/mode/fixture/verdict/notes conventions, plus `hallucination_findings` and `total_references_checked`. Deliberately **not** overloaded onto `benchmark_runs` because no `BenchmarkMode` captures the with/without-lookup axis and there is no hallucination metric column.

### Society report

Purely derived queries over existing tables (`runs`, `artifacts`, `artifact_claims`, `events`, `acceptance_evidence`, `arbitration_decisions`) — no storage of its own.

---

## Scoring semantics

- **Mode verdict**: pass requires *all* artifacts reviewed, *zero* failed runs, and (guild only) ≥1 passing evidence. Any single failure fails the whole run — it is an all-or-nothing gate, not a graded score.
- **Comparison deltas** are plain subtraction (guild − baseline); positive `completion_rate`/`evidence_pass_rate` deltas favor guild, negative `elapsed_ms`/`failed_runs`/`rework_count`/cost deltas favor guild.
- **Doc-RAG verdict**: pass iff `withLookupFindings <= 0.5 * withoutLookupFindings` OR the without-lookup run had zero findings; `reductionRatio` is forced to 1 in the zero case to avoid division by zero.
- **Society report** scores nothing; it exposes raw counts and rates (pass rate as a fraction, rendered as a percentage with one decimal).

---

## Invariants & edge cases

- All numeric inputs to `recordBenchmarkRun` must be finite and non-negative; `evidencePassRate` must be within [0,1]; empty/whitespace fixtures rejected (`benchmark.ts:69-90`). Same discipline in the doc-RAG recorder, which additionally requires integer finding counts.
- `compareBenchmarkRuns` throws unless the first argument is a `single-agent` run and the second a `guild` run — order matters and is enforced (`benchmark.ts:142-143`, tested in `benchmark-report.test.ts:29`).
- `compareDocRagBenchmarkRuns` throws if either mode's latest run is missing for the fixture (`doc-rag-benchmark.ts:148-150`).
- Empty-DB society report returns zeros everywhere (tested in `society-report.test.ts:37`); elapsed runtime is `null` when no runs exist and clamped to ≥0 otherwise.
- `deriveBenchmarkMetrics` treats a run as failed on either `status='failed'` **or** a non-zero exit code, so partially-recorded runs cannot hide failures.
- The rework loop in `executeMode` breaks when the needs-rework count does not decrease between iterations, preventing unbounded retry cycles.

## Gotchas

- **Two different "SC-003"s**: the doc-RAG hallucination benchmark (spec 007) and the dependency-disposition deterministic benchmark (spec 006, `disposition-benchmark.test.ts`) both cite SC-003. Don't conflate them.
- The doc-RAG benchmark's real pipeline never runs in CI — the env-gated test always passes with zero findings, so a green suite says nothing about actual hallucination reduction until `RUN_HALLUCINATION_BENCHMARK=1` is set in a real environment.
- `recordBenchmarkRun` attaches its event to an arbitrary (first-created) artifact; in a fresh benchmark workspace this is fine, but calling it against a long-lived host DB will pin the event to an unrelated old artifact.
- Baseline vs guild asymmetry: the baseline is exempt from the evidence-passing requirement, so a "pass" verdict means different things per mode — compare via deltas, not verdicts alone.
- Benchmark workspaces symlink `node_modules` and rely on tsup-built dist CLIs; missing builds fail late unless `ensureToolsBuilt` gates first.
- `executeCli` retries phases 3× — a genuinely broken phase costs ~15 s of sleeps before failing the whole benchmark.

## Extension points

- New benchmark axes: follow the doc-RAG pattern — dedicated table + idempotent `apply*Schema`, mirrored option/run/comparison shapes, own `makeId` prefix — rather than overloading `benchmark_runs` (whose `mode` CHECK constraint would need a migration anyway).
- New society-report sections: add a field to `SocietyReport` (`society-report.ts:15`), populate it in `querySocietyReport`, render it in `runSocietyReport`; add the event type to `DIALOGUE_TYPES` if it's a dialogue signal.
- New derived metrics belong in `deriveBenchmarkMetrics` so they stay grounded in terminal registry state; new comparison dimensions go in `compareBenchmarkRuns.deltas` plus a line in `runBenchmarkCompare`.
- Alternative worker prompts/phases: the workers (`runBenchmarkBaselineWorker`, `runBenchmarkGuildReviewWorker`, `runBenchmarkGuildReworkWorker`) are thin prompt-wrappers around `spawnAgent` and are the natural place to adjust governance strictness without touching scoring.
