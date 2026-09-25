# Pipeline State Checks (Doctor)

## Purpose and Overview

The **Pipeline State Checks** module, located at `migration/guildctl/doctor.ts`, is a diagnostic suite responsible for validating the structural health and operational integrity of the Migration Guild pipeline. It acts as an internal auditor that operators run (e.g., via the `guildctl doctor` CLI command) to ensure that the registry and filesystem agree, and that invariants established by earlier pipeline phases hold true before subsequent phases proceed.

Unlike active pipeline commands (like `plan` or `migrate`), `doctor.ts` is strictly read-only. It relies exclusively on the SQLite registry state and the local filesystem, explicitly avoiding any LLM network calls. The design prioritizes speed—using `COUNT` queries instead of bulk row loading—ensuring it remains performant even on registries tracking thousands of artifacts.

Furthermore, `doctor.ts` is intentionally designed to degrade gracefully: it is phase-aware, only asserting conditions for features or pipeline stages that have plausibly executed (e.g., it will not fail if output-validation tables from later milestones are not yet present).

## Architecture

The core of the module is the `runPipelineStateChecks` function, which accepts a `PipelineCheckContext` (containing the database connection, workspace root, and configuration data) and returns an array of `CheckResult` objects. Each result contains a status (`"pass"`, `"warn"`, or `"fail"`) and an explanatory message.

The architecture emphasizes sequential, escalating verification:
1. **Foundation:** Is the runtime harness accessible and the database uncorrupted?
2. **Bootstrapping:** Has the registry been initialized? Does it match the presence of legacy source code?
3. **Data Quality:** Are the artifacts adequately classified?
4. **Pipeline Progression:** Did the planner assign waves correctly? Are stack mappings confirmed?
5. **Operational Health:** Are there malformed records or stale locks from crashed agents?
6. **Execution Integrity:** Do artifacts marked as migrated actually have output artifacts on disk?

## Core Execution Flow and Invariants

`runPipelineStateChecks` executes the following sequence of validations:

### 1. Harness CLI Accessibility
Before querying the database, the doctor checks if the active agent harness is reachable. It uses `resolveAgentLaunch` to determine the harness configuration. If the workspace uses an environment-sourced harness (like a custom `AGENT_CMD`), it validates its presence via `checkHarness`:
```typescript
if (resolution.harness.source === "environment") {
  const probe = checkHarness(resolution.harness);
  if (probe.ok) {
    checks.push({ status: "pass", message: `active harness: ${resolution.harness.name} reachable` });
  } else {
    checks.push({ status: "fail", message: probe.message });
  }
}
```
*Note: Preflight checks config-sourced harnesses, but `doctor` ensures local custom programs actually exist.*

### 2. SQLite Database Integrity
The absolute foundation of the pipeline is the registry database. The module runs a direct `PRAGMA integrity_check` on the SQLite database:
```typescript
const res = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string } | undefined;
if (res && res.integrity_check === "ok") {
  checks.push({ status: "pass", message: "SQLite integrity_check: ok" });
}
```
If the database fails this check, it issues a failure immediately. It then verifies if the `artifacts` table exists at all, warning and aborting further checks if the registry is completely uninitialized.

### 3. Empty-Pipeline Sanity
If the registry has zero artifacts, but the `legacy/` directory is populated with files, the doctor raises a failure indicating that the inventory phase was never run or failed to register them:
```typescript
if (totalArtifacts === 0 && legacyFileCount > 0) {
  checks.push({
    status: "fail",
    message: `registry has 0 artifacts but legacy/ contains ${legacyFileCount} source file(s) — inventory never registered them`,
  });
}
```

### 4. Classification Concentration
The doctor evaluates the quality of the inventory phase. It calculates the percentage of total artifacts that remain unclassified, or fell back to a generic framework (like `plain-java` or `plain-python`). If these concentrations exceed a threshold (e.g., > 50%), it issues a warning.

### 5. Post-Plan Wave Integrity
After the planning phase claims it has successfully completed (verified by reading the `plan_verification_planner` operator state), every artifact must be assigned to an execution wave. If the plan invariant is satisfied but artifacts exist where `wave IS NOT NULL` is false, it fails the check:
```typescript
if (withWave > 0 || plannerClaimedComplete) {
  if (nullWave > 0) {
    checks.push({
      status: "fail",
      message: `plan left ${nullWave}/${totalArtifacts} artifacts with wave = NULL (plan invariant was not satisfied)`,
    });
  }
}
```

### 6. Stack Mappings Presence
The planning phase relies on recorded mappings between legacy and target frameworks. If the planner claims completion but zero stack mappings exist, the doctor escalates this to a failure.

### 7. Evidence Format Validation
To protect downstream tools from parsing crashes, the doctor samples the `evidence_json` column within `artifact_classifications`. It attempts to parse the JSON and ensures it is a well-formed array. If malformed entries are found, it lists the offending artifact IDs.

### 8. Dangling Claims (Crashed Agents)
The migration pipeline relies on lease-expiring atomic claims. The doctor checks the `artifact_claims` table for active claims where the duration between `now` and the claim's start time (or last heartbeat) exceeds `danglingClaimThresholdMs` (defaulting to 1 hour):
```typescript
const stale = rows.filter((r) => {
  const raw = r.heartbeat_at ?? r.claimed_at;
  if (!raw) return false;
  const t = parseRegistryTimestamp(raw);
  return Number.isFinite(t) && now - t > thresholdMs;
});
```
This detects sessions where an agent process died ungracefully without releasing its lock.

### 9. Registry/Filesystem Agreement
Finally, it compares the registry's logical state against physical artifacts on disk. Any artifact marked with a status of `migrated` must correspond to a populated `modern/` output directory. If `modern/` is empty or missing, the doctor flags a failure, as the expected output was not produced.

## Edge Cases and Gotchas

- **Timestamp Parsing:** SQLite `datetime('now')` values are stored in UTC but omit the timezone suffix (e.g., `Z`). `parseRegistryTimestamp` explicitly appends the timezone indicator before parsing to prevent JavaScript's `Date` object from erroneously inflating claim age by assuming the time is local.
- **Graceful Degradation:** The script heavily utilizes `tableExists(db, ...)` checks (e.g., for `operator_state` and `artifact_claims`). This ensures the `doctor` command works safely even on fresh repositories where these tables have not yet been created by later pipeline phases.
