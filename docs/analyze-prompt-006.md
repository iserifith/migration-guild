# /speckit-analyze input for 006-dependency-disposition

Run the /speckit-analyze skill against this repository for feature 006-dependency-disposition.

## Context

- Feature directory: specs/006-dependency-disposition/ — spec.md, plan.md, research.md, data-model.md, contracts/ (registry-schema.md, cli-surface.md, disposition-pack-yaml.md), quickstart.md, tasks.md (T001–T030) are all complete.
- Constitution: .specify/memory/constitution.md.
- Repository: TypeScript CLI; tests via Node's built-in runner through `npm run test`; build via `npm run build`. Tests live flat under migration/test/*.test.ts using node:test and in-memory better-sqlite3.
- This is a READ-ONLY analysis. Do NOT modify any file.

## What to cross-check

1. **Contradictions** across spec.md, plan.md, research.md, data-model.md, contracts/*, quickstart.md, tasks.md — requirement language vs plan decisions vs contract behavior vs task wording vs test acceptance.
2. **Constitution alignment** — every MUST in .specify/memory/constitution.md mapped to at least one task; flag any task that violates a MUST.
3. **Coverage** — every FR (FR-001..FR-013) and every Success Criterion mapped to at least one task; every task mapped back to a requirement or story. Flag orphans in both directions.
4. **Task graph integrity** — dependency claims in tasks.md are acyclic and consistent with the Shared-File Sequencing section; [P] marks are only on genuinely disjoint file sets.
5. **Tests-first sequencing** — wherever the constitution requires runtime enforcement / tests-first, the test task precedes the implementation task for the same behavior.
6. **Untestable acceptance criteria** — any quickstart scenario or spec acceptance scenario that cannot be executed as written.
7. **Scope creep** — any task that implements something not traceable to the spec (in particular anything touching legacy/ or modern/ write paths, which FR-013 excludes).
8. **Shared-file ownership** — registry_schema.sql, registry/cli.ts, registry/commands/dispositions.ts, guildctl/commands/plan.ts, guildctl/readiness.ts, and the two classification.yaml mirrors are touched by multiple stories; verify the sequencing is explicit and single-owner per task.

## Verdicts

Report MVP readiness (T001–T023) SEPARATELY from full-feature readiness (T001–T030). It is valid for the MVP range to be READY while later tasks carry blockers — name those blockers explicitly.

## Hard constraints

- Do NOT modify any file. Read-only tools only.
- Do NOT run /speckit-implement.
- Output READY or NOT READY, plus a numbered finding ledger: ID, severity (CRITICAL/HIGH/MEDIUM/LOW), authoritative artifact, dependent artifacts, concrete closure check.
