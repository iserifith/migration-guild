# Pipeline Readiness Gate

## Purpose and Overview

The **Pipeline Readiness Gate** (`migration/guildctl/readiness.ts`) is the strict enforcement layer that ensures the migration pipeline cannot proceed to planning or execution until all high-risk uncertainties are manually resolved.

Unlike the core agent runners that blindly execute tasks, the readiness gate is defensive. It forces a human in the loop to make conscious decisions about:
- **Scope**: Which modules should be kept or dropped.
- **Security & Compatibility**: How to handle critical JVM compatibility findings from static analysis.
- **Dependency Dispositions**: How third-party libraries should be handled (keep, replace with native, or inline).
- **Modernization Strategy**: If a library is kept, how its known risky dependencies should be upgraded or replaced.

If any invariant fails, `guildctl plan` halts execution, preventing an agent from being spawned on an ambiguous code state.

## Architecture and the `PlanningReadiness` Struct

The gate works by evaluating the current state of the SQLite registry and constructing a `PlanningReadiness` struct via `evaluatePlanningReadiness(db: Database.Database)`.

This struct is an aggregate of several queries against the registry:

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

By eagerly fetching all potential blockers into a single struct, the system can determine precisely *why* planning should be blocked without scattering database queries throughout the CLI logic.

### Dependency Disposition Resolution

One notable complexity in `evaluatePlanningReadiness` is how it handles dependencies. An unresolved dependency finding (`unresolvedDependencyFindings`) only blocks planning if the underlying library does not already have a confirmed non-`keep` disposition.

If a library is explicitly marked as `replace-with-native` or `inline` in the `dependency_dispositions` table, the modernization finding is intrinsically "resolved", and the system filters it out of the blocking list.

## Sequential Block Evaluation

The `formatPlanningBlockMessage(readiness: PlanningReadiness)` function transforms the structured readiness data into a user-facing error message (and a suggested CLI command to fix it).

Crucially, it evaluates the blockers in a **strict hierarchy of precedence**:

1. **Scope (`unresolvedScopeModules`)**: If any module lacks a keep/drop decision, this blocks first. There's no point evaluating dependencies if we don't know if the module is even in scope.
2. **JVM Audits (`blockingJvmFindings`)**: Critical compatibility issues must be acknowledged before any third-party dependencies are analyzed.
3. **Dependency Strategies (`unresolvedDependencyFindings`)**: Known risky dependencies need an upgrade or removal strategy.
4. **Dispositions (`unconfirmedDispositions`)**: Finally, the high-level library dispositions must be confirmed. (Note: The CLI evaluates this late in the run, after collecting new proposals).

If a block is hit, it returns a `{ summary, reason, command }` object, stopping the chain. If all pass, it returns `null`.

## Multi-stage Gating via Property Masking

In `migration/guildctl/commands/plan.ts`, the `guildctl plan` command orchestrates the planning phase. Because the plan command has side effects (it analyzes scope, audits findings, and collects new dispositions), it cannot simply call `formatPlanningBlockMessage(evaluatePlanningReadiness(db))` once at the start.

Instead, it evaluates the gates in multiple stages by aggressively **masking properties** in the `PlanningReadiness` object to ignore checks that are evaluated later in the run.

### 1. Pre-Planner Gates
At the start of the command, the CLI evaluates initial readiness. However, because new dispositions will be collected *during* the plan, it artificially clears `unconfirmedDispositions`. It evaluates Scope and JVM blocks independently:

```typescript
  const initialReadiness = evaluatePlanningReadiness(db);
  const scopeBlock = formatPlanningBlockMessage({
    ...initialReadiness,
    unconfirmedDispositions: [], // Masked: evaluated at end of plan
    blockingJvmFindings: [],     // Masked: evaluated separately
    unresolvedDependencyFindings: [],
  });
```

### 2. Mid-Planner Gates
After the first planning stage runs, it checks dependency strategies, again masking out dispositions since the user hasn't been prompted for them yet:

```typescript
  const dependencyBlock = formatPlanningBlockMessage({
    ...readiness,
    unconfirmedDispositions: [], // Masked: disposition gate is end-of-Plan
    blockingJvmFindings: [],
    unresolvedScopeModules: [],
  });
```

### 3. End-of-Plan Gates
After the user is prompted to confirm new dispositions (`await confirmDispositions(db)`), a final readiness check is done. Only now is the disposition gate evaluated, failing closed if any are left unconfirmed.

## Non-Interactive Headless Mode

The CLI supports headless, non-interactive execution (typically used by the benchmark runner). When `process.env["GUILDCTL_AUTO_APPROVE_DEPENDENCIES"] === "1"`, the CLI automatically resolves blockers in-memory and writes the approvals to the registry *before* hitting the readiness gate:

- It auto-keeps undecided modules (`recordScopeDecision(db, { decision: "keep" })`).
- It auto-approves dependency strategies (defaulting to "upgrade" if a target hint exists, or "remove").

By preemptively writing these resolutions, the subsequent calls to `evaluatePlanningReadiness` cleanly pass the gate without requiring interactive prompts.
