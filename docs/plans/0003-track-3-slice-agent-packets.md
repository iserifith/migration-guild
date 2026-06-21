# Track 3 Agent Society Slice Agent Packets

> **For Hermes:** Use `subagent-driven-development` or one fresh coding agent per packet. Do not merge slices unless explicitly stated. Each packet must end with tests, mirror verification, and a short risk note.

**Goal:** Provide copy-pasteable implementation instructions for every remaining Track 3 Evidence Gate slice.

**Architecture:** `package/tools/` and `migration/` are mirrored runtime trees. Implement in one tree, mirror exactly to the other, then verify. Keep the repo as the kit source, not a migration workspace.

**Global constraints for every slice:**

- Do **not** run migration phases against the repository root.
- Do **not** create repo-root `legacy/` or `modern/` workspaces.
- Keep runtime behavior aligned between `package/tools/` and `migration/`.
- Prefer small pure registry helpers before CLI/UI wiring.
- Add tests in both runtime trees where equivalent test infrastructure exists.
- Do not expose credentials/API keys in logs, docs, fixtures, or snapshots.
- Commit each slice separately with a focused message.

**Global verification after every runtime slice:**

```bash
npm test --prefix package/tools
npm test --prefix migration
diff -rq migration package/tools | grep -v 'node_modules/.vite' | grep -v 'tsconfig.app.tsbuildinfo' || true
git status --short
```

**Global verification after UI slices:**

```bash
npm run typecheck --prefix package/tools/ui
npm test --prefix package/tools/ui -- --run
npm run build --prefix package/tools/ui
npm run typecheck --prefix migration/ui
npm test --prefix migration/ui -- --run
npm run build --prefix migration/ui
```

---

## Packet 1 — Slice 1-2: Evidence Schema, Registry Helpers, Dialogue Event Types

```text
Implement Track 3 Agent Society Slice 1-2 in /home/frierensamacorp/projects/Happy Little Bots.

Objective:
Add durable acceptance evidence + arbitration records, then make agent negotiation visible as first-class event types.

Repository rules:
- This repo is the Migration Guild kit itself, not a migration workspace.
- Treat package/tools and migration as mirrored runtime trees.
- Do not run migration phases against the repo root.
- Do not implement guildctl evidence/arbitrate CLI yet.

Files to inspect first:
- .github/agent-instructions.md
- docs/plans/0002-track-3-agent-society-evidence-gate.md
- package/tools/registry_schema.sql
- package/tools/registry/types.ts
- package/tools/registry/commands/events.ts
- package/tools/registry/index.ts
- existing tests under package/tools/test and migration/test

Implement:
1. In package/tools/registry_schema.sql and mirrored migration/registry_schema.sql:
   - Create acceptance_evidence table.
   - Create indexes:
     - idx_acceptance_evidence_artifact
     - idx_acceptance_evidence_pass
     - idx_acceptance_evidence_type
   - Create arbitration_decisions table.
   - Add useful arbitration index by artifact_id if project conventions allow it.
2. In registry types in both trees:
   - EvidenceType union:
     - test-command
     - build-command
     - static-check
     - review-verdict
     - benchmark-result
   - AcceptanceEvidence interface.
   - ArbitrationDecision interface.
3. Create or extend registry/commands/evidence.ts in both trees with pure helpers:
   - addAcceptanceEvidence(db, opts)
   - listAcceptanceEvidence(db, artifactId)
   - recordArbitrationDecision(db, opts)
   - getLatestArbitrationDecision(db, artifactId)
   - Serialize evidence_ids as JSON array text for arbitration_decisions.
   - Return newest records first where listing makes sense.
4. Export helpers from registry/index.ts if that is the repo convention.
5. Add dialogue event types in schema/types/events code in both trees:
   - proposal-submitted
   - evidence-submitted
   - critique-issued
   - arbitration-approved
   - arbitration-rejected
   - conflict-opened
   - conflict-resolved
   - benchmark-recorded
6. Add tests:
   - schema creates both new tables in memory.
   - evidence requires existing artifact.
   - pass accepts only 0/1.
   - arbitration records JSON evidence IDs.
   - evidence listing returns newest first.
   - appendEvent accepts every new dialogue type.
   - appendEvent still rejects invalid event types.

Verification commands:
- npm test --prefix package/tools -- evidence-gate.test.ts
- npm test --prefix package/tools -- agent-dialogue-events.test.ts
- npm test --prefix migration -- evidence-gate.test.ts
- npm test --prefix migration -- agent-dialogue-events.test.ts
- npm test --prefix package/tools
- npm test --prefix migration
- diff -rq migration package/tools | grep -v 'node_modules/.vite' | grep -v 'tsconfig.app.tsbuildinfo' || true

Commit:
- git add package/tools migration
- git commit -m "feat: add evidence gate schema and dialogue events"

Return:
- Summary of helpers/types/events added.
- Tests run and pass/fail.
- Mirror diff status.
- Any risks or follow-up needed.
```

---

## Packet 2 — Slice 3: Arbiter Approval Rule

```text
Implement Track 3 Agent Society Slice 3 in /home/frierensamacorp/projects/Happy Little Bots.

Objective:
Prevent artifact acceptance unless an independent Arbiter approves a migrated artifact using passing executable evidence.

Prerequisite:
- Slice 1-2 must exist: acceptance_evidence, arbitration_decisions, dialogue event types, and evidence registry helpers.

Repository rules:
- This repo is the Migration Guild kit itself, not a migration workspace.
- Keep package/tools and migration mirrored.
- Do not implement CLI commands in this slice.

Files to inspect first:
- docs/plans/0002-track-3-agent-society-evidence-gate.md
- package/tools/registry/commands/evidence.ts
- package/tools/registry/commands/events.ts
- package/tools/registry/index.ts
- package/tools/registry/types.ts
- existing artifact status helper code/tests

Implement in both package/tools and migration:
1. Add canApproveArtifact(db, artifactId, arbiter):
   - Return { ok: boolean; evidenceIds: string[]; reason: string }.
   - Artifact must exist.
   - Artifact status must be migrated.
   - At least one executable evidence row must pass.
   - Executable types are test-command, build-command, static-check.
   - Latest executable evidence for the artifact must pass.
   - Arbiter must not equal produced_by for the evidence used.
2. Add approveArtifactWithEvidence(db, opts):
   - opts: artifactId, arbiter, reason, optional evidenceIds.
   - If canApproveArtifact fails, throw the repo's RegistryError pattern and leave artifact status unchanged.
   - Record arbitration_decisions row with decision approved.
   - Append arbitration-approved event with structured event_data containing role, evidence_ids, reason, target_status.
   - Set artifact status to reviewed.
3. Add rejectArtifactWithEvidence(db, opts):
   - opts: artifactId, arbiter, reason, optional evidenceIds.
   - Record arbitration_decisions row with decision rejected.
   - Append arbitration-rejected event with structured event_data.
   - Set artifact status to needs-rework.
4. Export helpers from registry/index.ts if convention requires.
5. Tests in both trees, preferably arbiter-gate.test.ts:
   - Cannot approve missing artifact.
   - Cannot approve planned artifact.
   - Cannot approve migrated artifact with no evidence.
   - Cannot approve with latest executable evidence failing.
   - Cannot approve when arbiter equals evidence producer.
   - Can approve migrated artifact with independent passing test-command evidence.
   - Approval records decision, appends event, and sets status reviewed.
   - Rejection records decision, appends event, and sets status needs-rework.

Verification commands:
- npm test --prefix package/tools -- arbiter-gate.test.ts
- npm test --prefix migration -- arbiter-gate.test.ts
- npm test --prefix package/tools
- npm test --prefix migration
- diff -rq migration package/tools | grep -v 'node_modules/.vite' | grep -v 'tsconfig.app.tsbuildinfo' || true

Commit:
- git add package/tools migration
- git commit -m "feat: enforce arbiter evidence approval gate"

Return:
- Summary of approval/rejection behavior.
- Tests run and pass/fail.
- Mirror diff status.
- Any risks or follow-up needed.
```

---

## Packet 3 — Slice 4: CLI Evidence + Arbitrate Commands

```text
Implement Track 3 Agent Society Slice 4 in /home/frierensamacorp/projects/Happy Little Bots.

Objective:
Expose proof submission and arbitration through guildctl so operators and agents can use the evidence gate.

Prerequisite:
- Slice 1-3 helpers exist and are tested.

Repository rules:
- This repo is the Migration Guild kit itself, not a migration workspace.
- Keep package/tools and migration mirrored.
- Do not wire review/evaluation auto behavior yet.

Files to inspect first:
- package/tools/guildctl/cli.ts
- package/tools/guildctl/commands/*
- package/tools/registry/commands/evidence.ts
- package/tools/test/*cli*.test.ts
- mirrored migration files

Implement in both package/tools and migration:
1. Add guildctl evidence command group:
   - evidence add --artifact <id> --type <type> --produced-by <name> --summary <text>
   - Optional flags: --command <cmd>, --exit-code <number>, --pass/--fail or pass inference from exit code if existing CLI patterns prefer it, --output-path <path>, --output-excerpt <text>, --run-id <id>.
   - Append evidence-submitted event when evidence is added.
2. Add evidence list:
   - evidence list --artifact <id>
   - evidence list --artifact <id> --json
   - Human output must show evidence_id, type, pass/fail, produced_by, summary, created_at.
3. Add guildctl arbitrate command:
   - arbitrate --artifact <id> --approve --arbiter <name> --reason <text> [--evidence <id> repeated]
   - arbitrate --artifact <id> --reject --arbiter <name> --reason <text> [--evidence <id> repeated]
   - Reject command-line usage where both --approve and --reject are provided or neither is provided.
4. Wire commands into guildctl help.
5. Tests in both trees where feasible:
   - help output includes evidence and arbitrate.
   - evidence add records evidence.
   - evidence list --json returns rows.
   - arbitrate --approve fails without evidence.
   - arbitrate --approve succeeds with independent passing evidence.
   - arbitrate --reject moves artifact to needs-rework.

Verification commands:
- npx --prefix package/tools tsx package/tools/guildctl/cli.ts --help
- npx --prefix package/tools tsx package/tools/guildctl/cli.ts evidence --help
- npx --prefix package/tools tsx package/tools/guildctl/cli.ts arbitrate --help
- npx --prefix migration tsx migration/guildctl/cli.ts --help
- npm test --prefix package/tools -- evidence-cli.test.ts
- npm test --prefix migration -- evidence-cli.test.ts
- npm test --prefix package/tools
- npm test --prefix migration
- diff -rq migration package/tools | grep -v 'node_modules/.vite' | grep -v 'tsconfig.app.tsbuildinfo' || true

Commit:
- git add package/tools migration
- git commit -m "feat: add evidence and arbitration CLI commands"

Return:
- Exact CLI commands added.
- Tests run and pass/fail.
- Mirror diff status.
- Any UX/risk notes.
```

---

## Packet 4 — Slice 5: Wire Review/Evaluation Into Evidence Gate

```text
Implement Track 3 Agent Society Slice 5 in /home/frierensamacorp/projects/Happy Little Bots.

Objective:
Turn existing review/evaluation outputs into acceptance evidence and ensure auto-advance uses Arbiter rules instead of direct self-approval.

Prerequisite:
- Slice 1-4 exists: evidence helpers, arbiter helpers, CLI commands.

Repository rules:
- This repo is the Migration Guild kit itself, not a migration workspace.
- Keep package/tools and migration mirrored.
- Do not broaden benchmark or UI work in this slice.

Files to inspect first:
- package/tools/guildctl/commands/review.ts
- package/tools/provider/eval/commands.ts
- package/tools/provider/eval/run-eval.ts
- package/tools/registry/commands/evidence.ts
- package/tools/test/pipeline-failures.test.ts
- existing eval/review tests
- mirrored migration files

Implement in both package/tools and migration:
1. Review/evaluation completion must record acceptance_evidence where the result is proof-bearing.
   - Passing eval/review should record pass=1 with type review-verdict, test-command, build-command, or static-check as appropriate to existing evaluator result shape.
   - Failing eval/review should record pass=0 with summary and output excerpt/path when available.
2. Preserve existing review behavior except acceptance cannot skip arbitration.
3. Update evaluate-artifact --auto-advance semantics:
   - It must not directly set reviewed/completed without arbitration_decisions.
   - On passing evidence, call approveArtifactWithEvidence with arbiter guildctl-arbiter or existing configured arbiter identity.
   - On failing evidence, only reject to needs-rework when --auto-advance is explicitly used.
4. Prevent builder self-approval through producer identity:
   - The evidence producer used for approval cannot equal arbiter.
   - If existing builder identity is available, do not produce evidence as the builder.
5. Append useful events:
   - evidence-submitted when evidence rows are created.
   - arbitration-approved/rejected when auto-advance arbitrates.
6. Tests in both trees:
   - evaluation pass records evidence.
   - evaluation fail records failing evidence.
   - auto-advance approval creates arbitration decision and reviewed status.
   - auto-advance rejection creates rejection decision and needs-rework status.
   - direct status jump no longer happens without arbitration.
   - builder cannot self-approve via eval producer identity.

Verification commands:
- npm test --prefix package/tools -- review-evidence.test.ts
- npm test --prefix package/tools -- pipeline-failures.test.ts
- npm test --prefix migration -- review-evidence.test.ts
- npm test --prefix migration -- pipeline-failures.test.ts
- npm test --prefix package/tools
- npm test --prefix migration
- diff -rq migration package/tools | grep -v 'node_modules/.vite' | grep -v 'tsconfig.app.tsbuildinfo' || true

Commit:
- git add package/tools migration
- git commit -m "feat: record review evidence before arbitration"

Return:
- What now records evidence.
- Whether --auto-advance changed behavior.
- Tests run and pass/fail.
- Mirror diff status.
- Any compatibility risks.
```

---

## Packet 5 — Slice 6: Society Report

```text
Implement Track 3 Agent Society Slice 6 in /home/frierensamacorp/projects/Happy Little Bots.

Objective:
Add a judge-readable society-report command showing roles, task division, dialogue, conflict resolution, evidence, and efficiency hooks.

Prerequisite:
- Evidence/arbitration schema and events exist.

Repository rules:
- This repo is the Migration Guild kit itself, not a migration workspace.
- Keep package/tools and migration mirrored.
- The report must be readable without knowing the DB schema.

Files to inspect first:
- package/tools/guildctl/cli.ts
- package/tools/guildctl/commands/*report*.ts
- package/tools/registry/commands/queries.ts
- package/tools/registry_schema.sql
- existing report tests
- mirrored migration files

Implement in both package/tools and migration:
1. Create guildctl/commands/society-report.ts.
2. Add command:
   - guildctl society-report
   - guildctl society-report --json
3. Report sections:
   - Roles observed from runs.agent.
   - Task division: artifact count by status/wave/tier and active claims.
   - Dialogue: counts for proposal-submitted, evidence-submitted, critique-issued, arbitration-approved, arbitration-rejected, conflict-opened, conflict-resolved, benchmark-recorded.
   - Conflict resolution: claim releases/expirations/reaped runs where available; arbitration approved/rejected counts.
   - Evidence: evidence pass rate, artifacts awaiting evidence, artifacts awaiting arbitration.
   - Efficiency hooks: elapsed runtime from first run to last run, failed/reworked runs, cost from traces if present.
4. Human output should use labeled sections and concise bullets.
5. JSON output should be stable and testable.
6. Add tests:
   - Empty DB/report returns zeros, not crash.
   - Seeded DB shows role counts and artifact status counts.
   - Seeded evidence/arbitration rows affect pass rate and approved/rejected counts.
   - JSON mode returns parseable object with expected keys.
   - Human mode includes judge-facing section labels.

Verification commands:
- npx --prefix package/tools tsx package/tools/guildctl/cli.ts society-report --help
- npx --prefix migration tsx migration/guildctl/cli.ts society-report --help
- npm test --prefix package/tools -- society-report.test.ts
- npm test --prefix migration -- society-report.test.ts
- npm test --prefix package/tools
- npm test --prefix migration
- diff -rq migration package/tools | grep -v 'node_modules/.vite' | grep -v 'tsconfig.app.tsbuildinfo' || true

Commit:
- git add package/tools migration
- git commit -m "feat: add agent society report"

Return:
- Report sections implemented.
- Example one-screen output if practical.
- Tests run and pass/fail.
- Mirror diff status.
```

---

## Packet 6 — Slice 7: Minimal Benchmark Spine

```text
Implement Track 3 Agent Society Slice 7 in /home/frierensamacorp/projects/Happy Little Bots.

Objective:
Add manual benchmark record/report/compare machinery to support single-agent vs guild efficiency claims without overbuilding automatic execution.

Prerequisite:
- Evidence/arbitration schema exists.
- benchmark-recorded event type exists.

Repository rules:
- This repo is the Migration Guild kit itself, not a migration workspace.
- Keep package/tools and migration mirrored.
- Do not implement automatic agent benchmark execution in MVP.

Files to inspect first:
- package/tools/registry_schema.sql
- package/tools/registry/types.ts
- package/tools/registry/commands/*
- package/tools/guildctl/cli.ts
- package/tools/guildctl/commands/*
- mirrored migration files

Implement in both package/tools and migration:
1. Add benchmark_runs table and indexes if useful:
   - benchmark_id primary key.
   - mode: single-agent or guild.
   - fixture.
   - started_at, finished_at, elapsed_ms.
   - total_runs, failed_runs.
   - artifacts_planned, artifacts_completed.
   - evidence_pass_rate.
   - rework_count.
   - total_cost_usd nullable.
   - verdict: pass/fail.
   - notes nullable.
2. Add BenchmarkResult/BenchmarkRun type.
3. Create registry/commands/benchmark.ts with helpers:
   - recordBenchmarkRun(db, opts)
   - listBenchmarkRuns(db, filters?)
   - getBenchmarkRun(db, id)
   - compareBenchmarkRuns(db, baselineId, guildId)
4. Create guildctl/commands/benchmark.ts with commands:
   - guildctl benchmark record --mode single-agent|guild --fixture <name> --elapsed-ms <n> --total-runs <n> --failed-runs <n> --artifacts-planned <n> --artifacts-completed <n> --evidence-pass-rate <0..1> --rework-count <n> --verdict pass|fail [--total-cost-usd <n>] [--notes <text>] [--json]
   - guildctl benchmark report [--json]
   - guildctl benchmark compare --baseline <id> --guild <id> [--json]
5. On record, append benchmark-recorded event.
6. Compare output should show deltas for elapsed_ms, failed_runs, completion rate, evidence_pass_rate, rework_count, cost if available.
7. Tests in both trees:
   - schema creates benchmark_runs.
   - record validates mode/verdict/rates.
   - report lists runs.
   - compare rejects wrong modes.
   - compare returns expected deltas.
   - CLI record/report/compare JSON is parseable.

Verification commands:
- npx --prefix package/tools tsx package/tools/guildctl/cli.ts benchmark --help
- npx --prefix migration tsx migration/guildctl/cli.ts benchmark --help
- npm test --prefix package/tools -- benchmark-report.test.ts
- npm test --prefix migration -- benchmark-report.test.ts
- npm test --prefix package/tools
- npm test --prefix migration
- diff -rq migration package/tools | grep -v 'node_modules/.vite' | grep -v 'tsconfig.app.tsbuildinfo' || true

Commit:
- git add package/tools migration
- git commit -m "feat: add single-agent versus guild benchmark spine"

Return:
- Benchmark commands added.
- Metrics/deltas supported.
- Tests run and pass/fail.
- Mirror diff status.
```

---

## Packet 7 — Slice 8: Dashboard Evidence / Arbitration Surface

```text
Implement Track 3 Agent Society Slice 8 in /home/frierensamacorp/projects/Happy Little Bots.

Objective:
Make Builder → Critic → Arbiter behavior visible in the dashboard.

Prerequisite:
- Evidence/arbitration helpers and schema exist.
- New dialogue event types exist.
- CLI/report slices may exist, but UI should not depend on shelling out to CLI.

Repository rules:
- This repo is the Migration Guild kit itself, not a migration workspace.
- Keep package/tools and migration mirrored.
- Do not redesign the dashboard; add minimal surfaces.

Files to inspect first:
- package/tools/registry/commands/queries.ts
- package/tools/registry/commands/serve.ts
- package/tools/ui/src/types.ts
- package/tools/ui/src/api.ts
- package/tools/ui/src/components/ArtifactDetail.tsx
- package/tools/ui/src/components/QualityView.tsx
- package/tools/ui/src/components/OperationalViews.tsx
- existing UI tests
- mirrored migration files

Implement in both package/tools and migration:
1. Extend registry query/serve layer so artifact detail API includes:
   - latest evidence rows for artifact.
   - latest arbitration decision for artifact.
   - acceptance state:
     - Proposed: migrated with no passing evidence.
     - Evidence Passed: migrated with passing executable evidence awaiting arbitration.
     - Rejected: latest arbitration rejected or status needs-rework.
     - Accepted: reviewed/completed with approved arbitration.
2. Extend operational summary API with counts:
   - migrated pending evidence.
   - evidence passed awaiting arbitration.
   - approved arbitration count.
   - rejected arbitration count.
3. Update UI types/api clients.
4. Update ArtifactDetail:
   - Show acceptance state badge.
   - Show evidence rows with type, pass/fail, producer, summary, command/exit where present.
   - Show latest arbitration decision with arbiter, decision, reason, decided_at.
5. Update QualityView or OperationalViews:
   - Show evidence/arbitration counters.
6. Update event timeline rendering if a central renderer exists:
   - proposal-submitted => Builder proposed
   - evidence-submitted => Critic submitted evidence
   - critique-issued => Critic challenged
   - arbitration-approved => Arbiter approved
   - arbitration-rejected => Arbiter rejected
   - conflict-opened/resolved => Conflict opened/resolved
   - benchmark-recorded => Benchmark recorded
7. Tests:
   - API/query includes evidence and arbitration fields.
   - Acceptance state classification works for proposed/evidence-passed/rejected/accepted.
   - Component renders evidence rows and arbitration decision.
   - Operational view renders new counts.

Verification commands:
- npm run typecheck --prefix package/tools/ui
- npm test --prefix package/tools/ui -- --run
- npm run build --prefix package/tools/ui
- npm run typecheck --prefix migration/ui
- npm test --prefix migration/ui -- --run
- npm run build --prefix migration/ui
- npm test --prefix package/tools
- npm test --prefix migration
- diff -rq migration package/tools | grep -v 'node_modules/.vite' | grep -v 'tsconfig.app.tsbuildinfo' || true

Commit:
- git add package/tools migration
- git commit -m "feat: surface evidence arbitration flow in dashboard"

Return:
- Dashboard/API surfaces changed.
- Acceptance states implemented.
- Tests/builds run and pass/fail.
- Mirror diff status.
- Any UI debt left.
```

---

## Packet 8 — Slice 9: Demo Script / Judge Story Doc

```text
Implement Track 3 Agent Society Slice 9 in /home/frierensamacorp/projects/Happy Little Bots.

Objective:
Create a concise executable human demo script that proves Track 3 Agent Society fit: Builder proposes, Critic proves, Arbiter decides, benchmark compares.

Prerequisite:
- CLI commands exist for evidence, arbitrate, society-report, and benchmark.
- Dashboard surface exists if available; if not, script may use CLI-only fallback.

Repository rules:
- This repo is the Migration Guild kit itself, not a migration workspace.
- Do not run migration phases against the repo root.
- If a demo workspace is needed, instruct users to create it outside this repo.

Files to inspect first:
- README.md
- docs/plans/0002-track-3-agent-society-evidence-gate.md
- docs/decisions/0002-align-to-track-3-agent-society.md
- package/tools/guildctl/cli.ts
- any existing demo docs

Create:
- docs/agent-society-demo-script.md

Optional modify:
- README.md with a short pointer only if there is an existing demo/docs section.

Document structure:
1. One-sentence judge pitch:
   - Migration Guild proves agent society value by preventing the agent that writes code from approving it.
2. Prerequisites:
   - Node/npm installed.
   - Commands run from repo root unless stated.
   - Use a temporary workspace outside repo root for migration fixtures.
3. Demo path:
   - Show guildctl society-report before run.
   - Run or replay fixture migration safely outside repo root.
   - Show artifact claimed by Analyzer/Test Writer/Builder.
   - Show Builder proposal as migrated.
   - Attempt approval without evidence and show rejection/failure.
   - Add or produce Critic evidence.
   - Arbiter approves.
   - Show society-report after run.
   - Show dashboard timeline if available.
   - Record baseline and guild benchmark rows.
   - Show benchmark compare output.
4. CLI commands:
   - Include exact package/tools and/or migration npx tsx commands that work in this repo.
   - Include expected abbreviated output after each major command.
5. Judge narration:
   - 60-second version.
   - 3-minute version.
6. Troubleshooting:
   - Missing DB path.
   - No migrated artifact yet.
   - Approval fails because evidence producer equals arbiter.
   - UI not available; use CLI fallback.
7. Safety/non-goals:
   - Do not run migration against repo root.
   - Do not claim production-grade benchmark.

Tests/verification:
- Run markdown/link sanity if repo has such tooling.
- Otherwise run:
  - npm test --prefix package/tools
  - npm test --prefix migration
  - npx --prefix package/tools tsx package/tools/guildctl/cli.ts --help
  - npx --prefix migration tsx migration/guildctl/cli.ts --help

Commit:
- git add docs/agent-society-demo-script.md README.md
- git commit -m "docs: add agent society demo script"

Return:
- Demo doc path.
- Whether README pointer was added.
- Commands verified.
- Any remaining demo assumptions.
```

---

## Final Integration Packet — Full Track 3 Gate Verification

```text
Run final Track 3 Agent Society integration verification in /home/frierensamacorp/projects/Happy Little Bots.

Objective:
Confirm all Evidence Gate slices work together and produce a judge-safe final status report.

Repository rules:
- Do not run migration phases against repo root.
- Do not create repo-root legacy/modern workspaces.
- Do not commit generated cache/build outputs.

Steps:
1. Inspect git status and recent commits:
   - git status --short --branch
   - git log --oneline -10
2. Run full tests/builds:
   - npm test --prefix package/tools
   - npm test --prefix migration
   - npm run build
   - npm run build:dist
3. Run UI verification:
   - npm run typecheck --prefix package/tools/ui
   - npm test --prefix package/tools/ui -- --run
   - npm run build --prefix package/tools/ui
   - npm run typecheck --prefix migration/ui
   - npm test --prefix migration/ui -- --run
   - npm run build --prefix migration/ui
4. Run CLI smoke:
   - npx --prefix package/tools tsx package/tools/guildctl/cli.ts --help
   - npx --prefix package/tools tsx package/tools/guildctl/cli.ts evidence --help
   - npx --prefix package/tools tsx package/tools/guildctl/cli.ts arbitrate --help
   - npx --prefix package/tools tsx package/tools/guildctl/cli.ts society-report --help
   - npx --prefix package/tools tsx package/tools/guildctl/cli.ts benchmark --help
   - Repeat equivalent migration CLI help where paths allow.
5. Verify mirror cleanliness:
   - diff -rq migration package/tools | grep -v 'node_modules/.vite' | grep -v 'tsconfig.app.tsbuildinfo' || true
6. Verify docs:
   - README pointer exists if intended.
   - docs/agent-society-demo-script.md exists and avoids unsafe repo-root migration instructions.
7. Inspect final diff/status:
   - git status --short
   - git diff --stat

Return:
- Pass/fail matrix for tools tests, migration tests, root build, dist build, UI builds, CLI help, mirror diff.
- List of final commits.
- Any blockers with exact failing commands/output.
- One judge-facing paragraph summarizing Track 3 evidence.
```
