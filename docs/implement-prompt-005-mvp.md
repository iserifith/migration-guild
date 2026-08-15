# /speckit-implement input for 005-artifact-risk-scoring — MVP slice ONLY

Run the /speckit-implement skill against this repository for feature 005-artifact-risk-scoring, restricted to the MVP task range.

## HARD SCOPE

- Implement tasks T001 through T022 ONLY (Setup + Foundational + US1 + US3). HARD STOP at T022.
- Do NOT touch T023–T035 (US2 stack-pack YAML blocks, US4 planner ordering, Polish, benchmark). Those are later authorized slices.
- Do NOT modify: stacks/*/classification.yaml, package/stacks/*, CHANGELOGS.MD, DEVELOPMENT.md, quickstart.md, spec.md, plan.md, research.md, data-model.md, contracts/. The specs/ directory is frozen for this run — except you MAY check off tasks in specs/005-artifact-risk-scoring/tasks.md as they are completed (change `- [ ]` to `- [x]` for T001–T022 only).
- Do NOT add any new npm dependency (research.md §2 decision: text/regex heuristics only).
- Do NOT modify anything under legacy/ content in fixtures — fixtures you create for tests are new files under migration/test/ or temp dirs.

## Context

- Feature dir: specs/005-artifact-risk-scoring/ — read spec.md, plan.md, research.md, data-model.md, contracts/ (registry-schema.md, risk-spec-yaml.md, cli-surface.md), tasks.md before writing any code.
- Constitution: .specify/memory/constitution.md — Principle V requires tests first: for each implementation task, first write/extend the failing test named in the preceding test task, confirm it fails, then implement.
- Repo: TypeScript CLI. Tests: `cd migration && npm test` (node --import tsx --test test/*.test.ts, real in-memory better-sqlite3, no mocking). Build: `npm run build` at root (or `npm --prefix migration run build` if present — check migration/package.json).
- Key files (from plan): migration/registry_schema.sql, migration/registry/db/schema.ts, migration/guildctl/risk.ts (NEW), migration/guildctl/classification.ts (add optional risk?: RiskSpec field only), migration/guildctl/commands/inventory.ts (T013 wiring, T014 summary line), migration/registry/commands/claim.ts (T019 NOT EXISTS clause inside existing transactions), migration/guildctl/commands/plan.ts (T021 confirmHighRiskArtifacts).
- Shared-file sequencing is mandatory: risk.ts T007 → T009 → T011 → T017; claim.ts T019 only; plan.ts T021 only (within this range); inventory.ts T013 → T014.

## Execution discipline

1. Work through the phases in order: Setup (T001–T003), Foundational (T004–T011), US1 (T012–T015), US3 (T016–T022).
2. Tests before implementation per task; run the focused test file after each pair (`node --import tsx --test test/<file>.test.ts` from migration/).
3. After T022, run the FULL migration test suite once and report pass/fail counts.
4. Check off completed tasks in tasks.md.
5. If you hit a genuine blocker (e.g. plan references a line that doesn't exist), STOP and report the discrepancy instead of improvising scope changes.

## Report

End with: tasks completed (IDs), tasks remaining, test suite result (pass/fail counts from YOUR actual run), any deviations from task wording with rationale.
