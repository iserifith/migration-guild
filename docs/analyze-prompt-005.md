# /speckit-analyze input for 005-artifact-risk-scoring

Run the /speckit-analyze skill against this repository for feature 005-artifact-risk-scoring.

## Context

- Feature directory: specs/005-artifact-risk-scoring/ — all artifacts complete and independently verified: spec.md, plan.md, research.md, data-model.md, contracts/ (registry-schema.md, risk-spec-yaml.md, cli-surface.md), quickstart.md, tasks.md (34 tasks T001–T034, MVP = T001–T022).
- Constitution: .specify/memory/constitution.md (7 principles).
- Repository: TypeScript CLI, migration/ package; tests via `npm run test`, build via `npm run build`.

## What to do

Cross-check spec, plan, research, data model, contracts, quickstart, and tasks for:
- Requirement (FR-001..FR-016) and success-criteria (SC-001..SC-005) coverage by tasks — every FR/SC mapped to at least one task and test.
- Contradictions between artifacts (e.g. gate enforcement point: plan says claim-boundary NOT EXISTS inside claimNextTask's transaction while surfacing via plan.ts confirmHighRiskArtifacts — verify spec US3 acceptance scenarios, contracts/cli-surface.md, and tasks T016–T022 all tell the same story).
- Constitution MUST violations.
- Placeholder/stale markers, invalid task dependencies, shared-file sequencing conflicts (risk.ts T007→T009→T011→T017; claim.ts T019; plan.ts T021→T030).
- Untestable acceptance criteria; missing edge-case coverage from the spec's Edge Cases section.
- MVP boundary coherence: is T001–T022 actually implementable independently of US2/US4 tasks?

## Hard constraints

- READ-ONLY analysis. Do NOT modify any files — not specs, not tasks, not source.
- Do NOT run /speckit-implement or any implementation.
- Produce a structured findings report: each finding with ID, severity (CRITICAL/HIGH/MEDIUM/LOW), the authoritative artifact, dependent artifacts, and a concrete closure check. End with an explicit verdict: READY or NOT READY, with the MVP-range (T001–T022) verdict stated separately from the full-feature verdict.
