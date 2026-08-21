# Phase 2b: Plan & Dependency Graph

## Purpose and Overview

The **Plan phase** (`migration/guildctl/commands/plan.ts`) is responsible for taking the unordered inventory of artifacts registered during Phase 1 (Inventory) and structuring them into an actionable dependency graph. This phase organizes work into executable **waves**, ensuring that low-level dependencies are migrated before the higher-level artifacts that rely on them.

Critically, the Plan phase is entirely gate-driven. It serves as the enforcement boundary that blocks unreviewed artifacts or unresolved dependencies from silently flowing into the active migration pipeline. The planner will not run unless human operators or authorized policies have made explicit decisions regarding module scope, severe compatibility findings, and dependency dispositions.

## Architecture & Data Flow

The Plan phase operates as a sequence of quality gates, collector passes, and an agent-driven graph construction process.

### 1. The Scope Gate (`ISSUE-68`)

Before any wave assignment can occur, the pipeline evaluates the **Scope Gate**. Every top-level module identified during the inventory must receive an explicit `keep` or `drop` decision.

- **Implementation**: `evaluatePlanningReadiness` (in `migration/guildctl/readiness.ts`) aggregates undecided modules.
- **Enforcement**: In `migration/guildctl/commands/plan.ts` lines ~120-135, if `scopeBlock` evaluates to true, the pipeline halts immediately with an exit code of `1`.
- **Why**: There is no "silent keep by default" logic. A skipped decision means an artifact nobody reviewed would flow straight into a migration wave, which violates the strict opt-in requirement of the migration framework.

When an operator makes a decision via `migration/registry/commands/scope.ts:recordScopeDecision`, dropping a module transitions its pre-migration artifacts directly to the `skipped` status, effectively removing them from the wave planner's consideration.

### 2. The Pre-Plan Audit & JVM Gates

Following the scope gate, the pipeline enforces JVM compatibility readiness (`jvmBlock` in `plan.ts`). The operator must review critical audit findings (or bypass them explicitly via `--override-audit`). This guarantees that artifacts with known severe incompatibilities are addressed before they consume agent resources in the downstream pipeline.

### 3. Dependency Dispositions (FR-006)

A central function of the planning phase is resolving what to do with external legacy libraries. This is a two-step process:

#### Step 3a. The Collector Pass

Before the AI Planner agent runs, a deterministic collection script (`migration/guildctl/dispositions.ts:collectDispositions`) runs across the entire workspace.
- It aggregates the library universe from dependency findings and manifest regex extraction.
- It scans legacy source code for import statements and qualified references (heuristic usage analysis).
- It proposes an initial disposition (`keep` or `replace-with-native`) based on the stack pack's `native_equivalents` mapping.
- It seeds these proposals into the database using `upsertProposedDisposition` (in `migration/registry/commands/dispositions.ts`).

#### Step 3b. The Planner Agent Refinement

With the database seeded, the `planner-agent` is spawned (`plan.ts:240`). The planner is prompted to build the dependency graph, assign wave numbers, and specifically *refine* the dependency dispositions based on AST-level usage evidence.

- **Mechanism**: The agent uses the registry CLI (`node migration/registry/dist/cli.js propose-disposition ...`) to update the initialized rows.
- **Constraints**: The agent is strictly instructed: `"Never invent a replacement to avoid a 'keep' outcome; missing evidence degrades toward keep."` This fail-closed constraint ensures that if usage evidence is murky, the library is conservatively retained.

#### Step 3c. End-of-Plan Disposition Gate

Finally, the Plan phase enforces a post-planner confirmation gate (`dispositionBlock` in `plan.ts:310`). No wave assignment is finalized until every proposed disposition is explicitly confirmed by an operator (or policy). This ensures that the agent's refinements are treated strictly as proposals until authorized.

## Invariants & Verification

The Plan phase is guarded by invariant checks to verify the AI's output. In `plan.ts`, the `verifyPlannerInvariant` function (called after the agent completes) checks that:
- Every artifact with a tier of `first-class` has been assigned a `wave` number.
- No active artifacts are left behind with a `NULL` wave.

If the invariant fails, the phase exits with an error without committing the flawed plan.

## Gotchas and Edge Cases

- **Post-Planner Risk Gates**: High-risk artifact confirmation (`confirmHighRiskArtifacts`) intentionally happens *after* the planner phase so pending high-risk work does not stall wave assignment for the rest of the safe artifacts. The enforcement for those high-risk items lives later, at the Claim boundary.
- **Empty Manifests**: If manifest globs don't match or cannot be parsed, the collector degraded gracefully but notes the limitation (`scan_notes`) and falls back to a conservative `keep` disposition.

## Extension Points

- **Collector Heuristics**: The heuristics in `migration/guildctl/dispositions.ts` (e.g., regex-based import scanning) can be extended to support non-Java ecosystems by adding new `library_prefixes` or language-specific parsers to the stack pack.
- **Disposition States**: New `DependencyDispositionChangeKind` lifecycle events (e.g., auto-confirm policies based on organizational CVE policies) can be layered over the `upsertProposedDisposition` mechanism without altering the AI prompt.
