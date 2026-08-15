# /speckit-tasks input for 005-artifact-risk-scoring

Run the /speckit-tasks skill against this repository for feature 005-artifact-risk-scoring.

## Context

- Feature directory: specs/005-artifact-risk-scoring/ — spec.md, plan.md, research.md, data-model.md, contracts/ (registry-schema.md, risk-spec-yaml.md, cli-surface.md), quickstart.md are all complete and verified.
- Constitution: .specify/memory/constitution.md.
- Repository: TypeScript CLI; tests via Node's built-in runner through `npm run test`; build via `npm run build`. Tests live flat under migration/test/*.test.ts using node:test and in-memory better-sqlite3.

## Requirements for tasks.md

Write specs/005-artifact-risk-scoring/tasks.md with:

- A setup phase and a foundational phase.
- One phase per user story, in priority order (US1 P1, US3 P1, US2 P2, US4 P3 — note spec has two P1 stories; order them US1 then US3 since scoring precedes gating).
- Tests first where the constitution requires it (test task before implementation task per behavior).
- Exact repository paths in every task description (real paths from plan.md: migration/guildctl/commands/inventory.ts, migration/guildctl/classification.ts, migration/registry/commands/claim.ts, migration/registry/commands/plan.ts, migration/registry_schema.sql, migration/registry/db/schema.ts, migration/test/*.test.ts, stack pack classification.yaml files).
- Dependencies section and shared-file sequencing (e.g. registry_schema.sql and schema.ts are touched by multiple stories — sequence them).
- Parallel opportunities marked with [P] where file sets are disjoint.
- Independent test criteria per story, referencing quickstart.md scenarios.
- An explicit MVP boundary (setup + foundational + US1 + US3) and incremental delivery notes.
- Strict task format: `- [ ] [T###] [P?] [US#?] description with file path`

## Hard constraints

- Do NOT modify any application source code. Only specs/005-artifact-risk-scoring/tasks.md may be written.
- Do NOT run /speckit-analyze or /speckit-implement.
- Task IDs must be unique and sequential (T001, T002, ... with no gaps).
