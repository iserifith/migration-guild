# Planning Readiness Gates

## Purpose and Overview

In the Migration Guild pipeline, the Planning phase is a critical bottleneck where automated and manual decisions coalesce. Before an autonomous planner agent can divide the workload and assign modernization waves, certain prerequisites must be strictly enforced. The **Planning Readiness** subsystem in `migration/guildctl/readiness.ts` and `migration/guildctl/commands/plan.ts` exists to enforce these prerequisites.

Rather than checking states randomly, the gating logic evaluates a structured, prioritized hierarchy of readiness criteria: Scope, JVM Audit Findings, Dependency Strategies, and Dependency Dispositions.

If any invariant fails, the pipeline halts immediately, supplying the operator with actionable diagnostic messages and the exact CLI commands required to resolve the blockade.

## Architecture

The gating mechanism hinges on two core components:

1. **State Evaluation (`evaluatePlanningReadiness`)**: A pure function that queries the SQLite registry for current unresolved states across multiple domains and returns a comprehensive `PlanningReadiness` object.
2. **Sequential Enforcement (`formatPlanningBlockMessage`)**: A pure formatter that consumes the `PlanningReadiness` object and evaluates the gating sequence. It returns a formatted block message if any gate fails, enforcing the strict hierarchy.

To integrate this within the lifecycle of the `plan` CLI command, the subsystem leverages a technique called **property masking** (passing artificially empty arrays) to isolate specific gates without changing the underlying formatter logic.

## Step-by-Step Flow

### 1. State Evaluation
When gating logic is required, `evaluatePlanningReadiness` (`migration/guildctl/readiness.ts`) is invoked. It interacts directly with the `better-sqlite3` database to compile a `PlanningReadiness` struct:

```typescript
export interface PlanningReadiness {
  blockingJvmFindings: JvmAuditFinding[];
  warningJvmFindings: JvmAuditFinding[];
  unresolvedDependencyFindings: DependencyFindingWithStrategy[];
  approvedDependencyFindings: DependencyFindingWithStrategy[];
  unresolvedScopeModules: ModuleScopeSummary[];
  unconfirmedDispositions: DependencyDisposition[];
}
```

It queries for open JVM findings, unassigned dependency strategies, modules lacking scope decisions (keep/drop), and unconfirmed dependency dispositions.

### 2. Gating Hierarchy
`formatPlanningBlockMessage` enforces a rigid sequence of evaluation. By placing the checks in this specific order, it guarantees the most fundamental issues are addressed first.

1. **Scope (`unresolvedScopeModules`)**: A module must first be confirmed as in-scope or out-of-scope. If an artifact belongs to a module with no keep/drop decision, planning is blocked.
2. **JVM Findings (`blockingJvmFindings`)**: Critical compatibility issues must be acknowledged or overridden.
3. **Dependency Strategies (`unresolvedDependencyFindings`)**: Risky dependencies must have an approved upgrade or replacement strategy.
4. **Dependency Dispositions (`unconfirmedDispositions`)**: Finally, disposition rules (keep, replace-with-native, inline) must be confirmed.

If a gate triggers, the function immediately returns an object containing a `summary`, a `reason`, and a recommended `command` for the operator to run, ignoring subsequent checks.

### 3. Property Masking in the Plan Command
The `plan` command (`migration/guildctl/commands/plan.ts`) does not execute all checks simultaneously at the start. Instead, it evaluates gates progressively as it performs operations, using a technique called **property masking**.

Instead of writing separate formatters for different stages, `plan.ts` uses the spread operator (`...`) to overwrite specific arrays in the `PlanningReadiness` object with empty arrays (`[]`). This tricks `formatPlanningBlockMessage` into bypassing certain gates because their arrays appear empty.

For instance, before running the planner, we want to check Scope and JVM findings, but explicitly *defer* the Dispositions gate until the end of the plan:

```typescript
// migration/guildctl/commands/plan.ts:579
const jvmBlock = formatPlanningBlockMessage({
  ...initialReadiness,
  unconfirmedDispositions: [], // Masked!
  unresolvedDependencyFindings: [], // Masked!
  unresolvedScopeModules: [], // Masked!
});
```

By masking properties, the `plan` command can iteratively gate itself:
1. `scopeBlock` checks Scope (masking Dispositions, JVM, and Dependencies).
2. `jvmBlock` checks JVM findings.
3. `dependencyBlock` checks Dependency findings.
4. At the very end of the plan execution, `dispositionBlock` is evaluated, masking everything except `unconfirmedDispositions`.

## Invariants and Edge Cases

- **Disposition Resolution Invariant**: A dependency finding is technically resolved if its parent library carries a confirmed non-`keep` disposition. In `evaluatePlanningReadiness`, the `dispositionResolved` Set enforces this logic. If a library is being completely removed (`replace-with-native`), we don't block the pipeline waiting for a version upgrade strategy.
- **Empty Registry Invariant**: `requireNonEmptyRegistry` ensures that downstream phases like `plan` fast-fail if the registry contains exactly 0 artifacts.
- **Wave Constraints**: There is an alternative readiness check `evaluateMigrationReadiness` that operates strictly within the boundaries of a specific `wave` for downstream agents.

## Gotchas

- **Empty Arrays vs. Undefined**: Property masking works specifically by providing an empty array `[]`, not `undefined`. The formatter (`formatPlanningBlockMessage`) explicitly checks `.length > 0`, so an empty array gracefully bypasses the check without causing a TypeError.
- **Sequential Masking Error**: If a developer forgets to mask a later-stage property early in the `plan.ts` lifecycle, the run might prematurely halt on an unconfirmed disposition before the planner has had a chance to run its research phase and collect those very proposals!

## Extension Points

- New readiness domains (e.g., Code Quality Gates or Security Scans) can be added by expanding the `PlanningReadiness` interface in `readiness.ts`. The new field should be queried in `evaluatePlanningReadiness` and a new conditional block added to `formatPlanningBlockMessage`. To maintain the staggered evaluation in `plan.ts`, the new property must be carefully added to the relevant property-masking objects.
