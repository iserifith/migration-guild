# Coverage Audit Command & Findings Lifecycle

This module maps the end-to-end lifecycle of the `coverage` audit command, the generation of findings, how those findings are persisted and managed (including the strict no-delete policy), and how this entire system integrates with the pipeline gating mechanism (specifically, the unified planning gate).

## Overview

The `migration-guild` system relies on continuous verification of the code to ensure compatibility and identify necessary modernizations. Two key concepts intertwine here:

1.  **Coverage Auditing:** Verifying that the internal state of the `migration-guild` registry (the SQLite database) matches the physical reality of the file system.
2.  **Compatibility/Dependency Findings:** Scanning source files for known issues (JVM incompatibilities, legacy dependencies) and persisting these "findings" to enforce remediation before migration proceeds.

## The Coverage Audit (`guildctl audit coverage`)

The coverage audit ensures that no legacy file is left behind and no artifact remains in a non-terminal state unnecessarily.

### Architecture

The logic for this command is isolated in `migration/guildctl/commands/audit.ts`. The `runAuditCoverage` function performs a three-way diff between the filesystem and the registry.

```typescript
// From migration/guildctl/commands/audit.ts
export function runAuditCoverage(db: Database.Database, workspaceRoot = resolveWorkspaceRoot()): CoverageAuditResult {
  // ...
  const cfg = resolveGuildConfig({ cwd: projectRoot });
  const pack = loadActiveStack(cfg, projectRoot);
  const filesOnDisk = findMatchingFiles(legacyDir, pack.manifest.source_globs);

  // 1. Files on disk vs artifacts in DB
  const artifacts = db.prepare("SELECT path, status FROM artifacts").all();

  // ... calculates onDiskNotRegistered, registeredMissingOnDisk, registeredNonTerminal
}
```

**What it measures:**
1.  **On disk but not registered:** Legacy source files (matching the active stack's `source_globs`) that exist on the filesystem but do not have a corresponding row in the `artifacts` table.
2.  **Registered but missing on disk:** Artifact paths in the database that no longer point to an existing file in the `legacy` directory.
3.  **Registered but non-terminal:** Artifacts that are registered but have not reached a terminal state (e.g., `migrated`, `reviewed`, `completed`, `skipped`, `blocked`).

This is a synchronous, read-only operation used primarily for pipeline health checks and reporting via `formatCoverageReport`.

## The Findings Lifecycle

"Findings" represent specific issues (e.g., usage of a deprecated API or a legacy dependency) detected within the legacy source code.

### 1. Production (`refreshCompatibilityAudits`)

Findings are generated during the audit refresh phase, primarily handled by `migration/guildctl/audit.ts`.

The `refreshCompatibilityAudits` function iterates through all registered legacy source artifacts. If the file exists, its content is read and matched against `StackAuditRule`s defined in the active stack configuration.

```typescript
// From migration/guildctl/audit.ts:refreshCompatibilityAudits
const content = fs.readFileSync(absPath, "utf8");
const jvmFindings = detectAuditFindings(content, pack.rules);
const dependencyFindings = detectDependencyFindings(content, pack.rules, dependencyVersions);
```

Two types of findings are produced:
*   **JVM Findings:** Match against specific code symbols/patterns indicating incompatibility (`detectAuditFindings`).
*   **Dependency Findings:** Match against imports/dependencies (`detectDependencyFindings`), utilizing parsed version maps to provide accurate current versions.

### 2. Persistence and Upsert Strategy

Once detected, findings are persisted to the registry using functions in `migration/registry/commands/modernization.ts` (`replaceJvmAuditFindings` and `replaceDependencyFindings`).

A critical design choice here is the **stable finding ID**. Findings are not simply deleted and re-inserted on every run; they are upserted based on a deterministic hash of their content.

```typescript
// From migration/registry/commands/modernization.ts
function stableFindingId(namespace: string, artifactId: string, fingerprint: string): string {
  const digest = createHash("sha1")
    .update(`${namespace}|${artifactId}|${fingerprint}`)
    .digest("hex")
    .slice(0, 20);
  return `${namespace}-${digest}`;
}
```

When `replaceJvmAuditFindings` is called, it:
1.  Calculates the `finding_id` for every newly detected finding.
2.  Performs an `UPSERT` (using SQLite's `ON CONFLICT(finding_id) DO UPDATE`).
3.  **Crucially:** The upsert intentionally preserves state like `dismissed_at` and `override_id`.
4.  Deletes any *previously* existing findings for that artifact that were *not* detected in the current run.

This stable identity allows the system to remember if an operator has dismissed a specific issue, even if the file is re-scanned.

### 3. The No-Delete Policy (Dismiss and Reopen)

The registry enforces a strict "no-delete" policy for acknowledging findings. Operators cannot delete a finding from the database; they can only **dismiss** it.

This is managed via `migration/registry/commands/modernization.ts` and the `audit_overrides` table.

```typescript
// From migration/registry/commands/modernization.ts:dismissFinding
const overrideId = `ovr-${createHash("sha1").update(`${opts.findingId}|${Date.now()}|${Math.random()}`).digest("hex").slice(0, 16)}`;

db.prepare(`
  INSERT INTO audit_overrides (override_id, finding_id, finding_table, action, reason, dismissed_by, created_at)
  VALUES (@override_id, @finding_id, @finding_table, 'dismiss', @reason, @dismissed_by, datetime('now'))
`).run({ /* ... */ });

db.prepare(`
  UPDATE ${table} SET dismissed_at = datetime('now'), override_id = @override_id WHERE finding_id = @finding_id
`).run({ override_id: overrideId, finding_id: opts.findingId });
```

When a finding is dismissed (`guildctl findings dismiss`):
1.  An audit trail entry is inserted into the `audit_overrides` table recording the action, reason, and operator.
2.  The target finding table (`jvm_audit_findings` or `dependency_findings`) is updated to set `dismissed_at` to the current timestamp and link the `override_id`.

Reopening a finding (`guildctl findings reopen`) reverses this: it inserts a 'reopen' action into the override log and nullifies the `dismissed_at` and `override_id` fields on the finding record.

## Pipeline Influence: The Unified Planning Gate

The lifecycle of these findings directly controls whether the pipeline can proceed, specifically at the Planning phase. This is governed by the Unified Planning Gate in `migration/guildctl/readiness.ts`.

Before assigning migration waves, the planner (`migration/guildctl/commands/plan.ts`) calls `evaluatePlanningReadiness`.

```typescript
// From migration/guildctl/readiness.ts:evaluatePlanningReadiness
const allJvm = listJvmAuditFindings(db);
const jvm = allJvm.filter((finding) => finding.dismissed_at == null);
const blockingJvmFindings = jvm.filter((finding) => finding.severity === "critical");
```

**How Findings Block the Pipeline:**

1.  **Critical JVM Findings:** Any open (i.e., `dismissed_at IS NULL`) JVM finding with a `severity` of `critical` will immediately block the planning phase.
2.  **Unresolved Dependency Findings:** Any open dependency finding that lacks an approved modernization strategy (`strategy IS NULL`) and where the library disposition is not explicitly set to drop/replace, will also block planning.

The `formatPlanningBlockMessage` function determines the exact error message and recommended command to show the operator. If there are blocking findings, the pipeline exits with a non-zero code unless explicitly overridden.

### The Escape Hatch: `--override-audit`

In `migration/guildctl/commands/plan.ts`, there is an explicit bypass for the JVM finding gate:

```typescript
// From migration/guildctl/commands/plan.ts
if (jvmBlock) {
  if (deps.overrideAudit) {
    setNext(db, {
      summary: "Pre-plan audit override applied (--override-audit).",
      reason: `Blocked by ${initialReadiness.blockingJvmFindings.length} critical compatibility finding(s); operator bypassed the gate.`,
      // ...
    });
  } else {
    // Fails the pipeline
  }
}
```

If `--override-audit` is provided, the pipeline acknowledges the presence of critical blocking findings but proceeds anyway, logging the override decision into the operator state. This is distinct from dismissing individual findings, as it acts as a global bypass for the gate during that specific run.
