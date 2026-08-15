# /speckit-tasks input for 006-dependency-disposition

Run the /speckit-tasks skill against this repository for feature 006-dependency-disposition.

## Context

- Feature directory: specs/006-dependency-disposition/ — spec.md, plan.md, research.md, data-model.md, contracts/ (registry-schema.md, cli-surface.md, disposition-pack-yaml.md), quickstart.md are all complete and verified.
- Constitution: .specify/memory/constitution.md.
- Repository: TypeScript CLI; tests via Node's built-in runner through `npm run test`; build via `npm run build`. Tests live flat under migration/test/*.test.ts using node:test and in-memory better-sqlite3.

## Requirements for tasks.md

Write specs/006-dependency-disposition/tasks.md with:

- A setup phase and a foundational phase.
- One phase per user story, in priority order (US1 P1, US2 P1, US3 P2 — note spec has two P1 stories; order them US1 then US2 since disposition records must exist before they can be confirmed/locked).
- Tests first where the constitution requires it (test task before implementation task per behavior).
- Exact repository paths in every task description (real paths from plan.md: migration/registry_schema.sql, migration/registry/cli.ts, migration/registry/commands/dispositions.ts, migration/registry/commands/modernization.ts, migration/guildctl/dispositions.ts, migration/guildctl/readiness.ts, migration/guildctl/commands/plan.ts, migration/guildctl/commands/migrate.ts, migration/test/*.test.ts, stacks/java-spring/classification.yaml, package/stacks/java-spring/classification.yaml).
- Dependencies section and shared-file sequencing (e.g. registry_schema.sql, readiness.ts, plan.ts, and both classification.yaml mirrors are touched by multiple stories — sequence them).
- Parallel opportunities marked with [P] where file sets are disjoint.
- Independent test criteria per story, referencing quickstart.md scenarios.
- An explicit MVP boundary (setup + foundational + US1 + US2) and incremental delivery notes (US3 downstream consumption is P2).
- Strict task format: `- [ ] [T###] [P?] [US#?] description with file path`

## Hard constraints

- Do NOT modify any application source code. Only specs/006-dependency-disposition/tasks.md may be written.
- Do NOT run /speckit-analyze or /speckit-implement.
- Task IDs must be unique and sequential (T001, T002, ... with no gaps).
