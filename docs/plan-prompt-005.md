# /speckit-plan input for 005-artifact-risk-scoring

Run the /speckit-plan skill against this repository for feature 005-artifact-risk-scoring.

## Context

- Feature directory: specs/005-artifact-risk-scoring/ (spec.md is complete and gated; checklists/requirements.md all pass).
- Constitution: .specify/memory/constitution.md — run the constitution check before and after design.
- Repository: TypeScript CLI (package.json, tsconfig.json at root; source under package/, migration/, stacks/, scripts/). Test/build commands: `npm run test`, `npm run build`.
- Relevant existing seams named in the spec input: inventory.ts `scanAndRegister`, classification.ts (confidence/ambiguous/evidence/signals metadata pattern), plan.ts `confirmMappings` human-in-the-loop precedent, wave/claim machinery.

## Requirements for the plan output

Produce, inside specs/005-artifact-risk-scoring/:
- plan.md (fully populated — no template markers like [FEATURE], [DATE], [###-feature-name], ACTION REQUIRED, Option 1/2/3)
- research.md resolving technical unknowns (e.g. cyclomatic-complexity approach for the TS scanner, where per-stack-pack config lives, how risk data is persisted in the registry)
- data-model.md (Artifact Risk Assessment, Risk Threshold Configuration, High-Risk Confirmation Decision)
- contracts/ for any new interfaces/CLI surfaces, with every contract file referenced from plan.md actually existing
- quickstart.md using the repository's REAL setup and test commands (npm run test / npm run build)

## Hard constraints

- Do NOT modify any application source code. Only files under specs/005-artifact-risk-scoring/ may be written.
- Do NOT create tasks.md — that is a separate later phase.
- Do NOT run /speckit-tasks, /speckit-analyze, or /speckit-implement.
- Read the actual repository source (inventory/classification/plan modules) so the plan references real paths, not guesses.
