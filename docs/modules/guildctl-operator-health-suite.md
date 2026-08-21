# Operator Health & Diagnostics Suite

## Purpose and Overview

The **Operator Health & Diagnostics Suite** in `migration/guildctl/` is the pre-flight and diagnostic layer that operators use to assess whether a given migration environment is safe and correctly configured to run. 

Unlike the core autonomous loop which concerns itself with modifying artifacts, the health suite operates strictly defensively. It asks: 
- Is the database intact and in a consistent state?
- Are the dependencies required for planning and migration verified?
- Can the environment reach the AI model provider with valid credentials?
- Does the code present too high a risk for automated migration?
- How frequently are external dependencies failing?

If any invariant fails, these tools stop the pipeline *before* an agent process can be spawned, providing structured error reports and diagnostics to the operator.

## Architecture and Scope

The suite spans several interconnected modules:

1. **Preflight (`migration/guildctl/preflight.ts`)**: Gates and checks before a run is initiated. Ensures the runtime, adapter, model, and credentials can successfully establish a live connection to the provider.
2. **Doctor (`migration/guildctl/doctor.ts`)**: Pipeline-state checks. Validates that the internal registry, artifacts, and file systems are consistent with their supposed progress.
3. **Readiness (`migration/guildctl/readiness.ts`)**: Strict gating for downstream pipeline steps. Checks for unresolved dependencies, unconfirmed scope decisions, or unacknowledged critical JVM findings.
4. **Monitoring and Reporting (`migration/guildctl/monitoring.ts`, `migration/guildctl/runtime-report.ts`)**: Parses runtime agent logs for errors, summarizes pool metrics (like API pressure/rate limiting), and documents configuration environments (divergences between `.env` and ambient system variables).
5. **Risk Assessment (`migration/guildctl/risk.ts`)**: Analyzes legacy code for cyclomatic complexity, excessive line counts (god-methods), and reflection usage to gate or flag risky artifacts before migration attempts.

---

## Step-by-Step Flow and Mechanics

### 1. Preflight: Connectivity and Credential Validation

Before any agent is spawned, `runPreflight` (`migration/guildctl/preflight.ts`) executes a staged validation against the provider.

- **Resolution Stage**: It uses `resolveAgentLaunch` to determine the active configuration. If the workspace uses a built-in config-sourced harness (e.g., shipping its own adapter), `preflight.ts` probes the adapter directly via `checkHarness`.
- **Live Check**: It sends a test prompt (`"preflight"`) to the provider to confirm reachability and credential correctness.
- **Budgeting**: A rigid timeout (`budgetSeconds`) is strictly enforced using `budgetRace`. A model that takes too long to respond fails the preflight.
- **Reasoning Overhead (US7)**: For reasoning models (e.g., o1 or similar), the preflight specifically checks if the model exhausted its max tokens (`PREFLIGHT_PROBE_MAX_TOKENS`) strictly on reasoning overhead before producing visible output (`isReasoningTokenExhaustion`). It directs the user to increase the token budget rather than blaming connectivity.
- **Offline Mode**: If invoked with `--offline`, `runPreflight` explicitly labels the live stage as `unvalidated` and bypasses the request entirely. It never falsely claims a pass.

### 2. Doctor: Pipeline and Registry Integrity

`runPipelineStateChecks` (`migration/guildctl/doctor.ts`) is a suite of assertions that verify the state of the workspace against its expected timeline.

- **SQLite Integrity**: Issues a `PRAGMA integrity_check` directly to the SQLite registry to prevent proceeding on a corrupted database.
- **Harness Probe**: Checks the availability of custom (`AGENT_CMD`) harnesses. While `preflight.ts` defers testing custom harnesses to the live provider request, `doctor.ts` ensures the operator's local environment program actually exists.
- **Pipeline Stage Checks**:
  - Checks if a plan left artifacts without assigned waves (`wave IS NOT NULL`).
  - Verifies that `stack_mappings` exist if the planner has finished.
  - Samples `evidence_json` in `artifact_classifications` to ensure the structure is well-formed.
  - Monitors for dangling claims (`artifact_claims`) older than 1 hour, flagging sessions that crashed without releasing their locks.
  - **Filesystem Agreement**: Evaluates whether artifacts marked as `migrated` correspond to a populated `modern/` output directory.

### 3. Readiness Gating: Scope and Dependencies

`evaluatePlanningReadiness` and `evaluateMigrationReadiness` (`migration/guildctl/readiness.ts`) block downstream pipeline execution (no agent spawn) if fundamental data is missing.

- **Empty Registry Guard**: `requireNonEmptyRegistry` throws an `EmptyRegistryError` if `SELECT COUNT(*) FROM artifacts` is 0, enforcing that `inventory` runs first.
- **Scope Decisions**: Blocks if there are `unresolvedScopeModules` (modules with first-class artifacts but no explicit keep/drop decision).
- **Dependency Strategies**: Halts planning if any critical dependency lacks a confirmed keep, replace-with-native, or inline strategy (`unconfirmedDispositions`).
- **JVM Findings**: Blocks planning if there are undismissed critical JVM audit findings (`blockingJvmFindings`), requiring explicit acknowledgment or a sanctioned override.

### 4. Operational Monitoring and Telemetry

`printPoolSummary` (`migration/guildctl/monitoring.ts`) analyzes logs of closed agent runs.
- **Signal Aggregation**: Scans stdout/stderr logs (`analyzeLogFile`) for indicators of environment pressure, strictly enumerating `rateLimited` (`429 Too Many Requests`), `transientRetries`, `serverInterrupts`, `model404s`, and `authFailures`.
- **Runtime Reporting**: `resolveAndReportRuntime` (`migration/guildctl/runtime-report.ts`) handles reporting configuration. Crucially, it manages **Config Divergences** (`renderEnvDivergences`), displaying when an inherited ambient variable was overridden by a workspace `.env` variable (e.g., `ambient=... -> .env wins`). This is completely isolated from `agentEnv` to prevent accidental credential leakage in the logs.

### 5. Risk Assessment: Code Heuristics

`scoreArtifact` (`migration/guildctl/risk.ts`) provides a deterministic risk assessment score bounded between `0` and `100`.

- **Heuristics**:
  - Uses `findMethodBoundaries` (supporting both brace and indent-based styles) to parse the legacy source code.
  - Determines if a file has "god-methods" by comparing `method.lineCount` against `godMethodMaxLines`.
  - Calculates cyclomatic complexity by counting specific syntax keywords (`complexityKeywords` like `if`, `while`, `catch`).
  - Uses `detectReflection` to flag dangerous reflection usage using defined `reflectionPatterns`.
- **Enforcement**: If the `riskScore` exceeds the `highRiskScoreCutoff`, the artifact is marked as `highRisk` (`true`) and written to the registry (`applyRiskAssessment`). A row is inserted into `risk_confirmations` requiring manual review before the artifact can proceed.

---

## Invariants and Edge Cases

- **Credential Redaction**: Across the entire diagnostic suite (especially `preflight.ts` and `runtime-report.ts`), secrets and API keys are stringently kept out of terminal output and summary objects. The name of the environment variable (e.g., `OPENAI_API_KEY`) is printed, but the value is never exposed.
- **Idempotency in Risk Writes**: Writing a risk assessment for the same artifact replaces (`ON CONFLICT(artifact_id) DO UPDATE`) the stored row, resetting reason codes rather than accumulating them. An existing confirmation decision, however, is never overwritten by a recompute.
- **Stale Claim Heartbeats**: The `doctor.ts` dangling claim check relies on `heartbeat_at` defaulting back to `claimed_at` if missing, properly isolating abandoned sessions even if they failed instantly without a single heartbeat.

## Gotchas

- **Reasoning Model Exhaustion**: A 200 OK from the provider with an empty completion body is historically treated as a failure. However, for reasoning models, the suite explicitly distinguishes token exhaustion on reasoning steps. The fix is a bigger budget (`max_tokens`), not declaring the provider broken.
- **Config vs. Custom Harness Probing**: Preflight will probe built-in config harnesses (that ship an adapter) before network calls, but bypasses checking custom environment harnesses to let the live request prove it. Conversely, Doctor manually validates that custom harnesses exist.

## Extension Points

- `detectReflection` in `migration/guildctl/risk.ts` is driven by regex templates and can easily be expanded to catch additional risky patterns (e.g., JNI invocations or raw pointer access) via the risk configuration spec.
- `summaryPatterns` in `migration/guildctl/monitoring.ts` can be updated with new regex patterns if a new provider throws unique HTTP 4xx/5xx strings that aren't natively captured.
