# The Migration Run Execution Engine

## Purpose and Overview

The migration run execution engine is the core runtime environment of `guildctl`. It is responsible for orchestrating the execution of an agent harness (e.g., opencode, goose) against a specific artifact claim. It handles the full lifecycle of a run: resolving the runtime environment, spawning the process, tracking liveliness, enforcing filesystem wardens, recording process drift, capturing token usage and log outputs, and finally cleaning up process trees and finalizing the run state in the registry.

Unlike a simple script runner, the execution engine provides a sandboxed, observable, and managed environment for autonomous agent execution. It guarantees that runs are tracked, timeouts are enforced, process leaks are contained, and the filesystem state transitions are accurately recorded and authorized.

## Architecture

The execution engine spans several domains, coordinated primarily by `migration/guildctl/runner.ts`:

1.  **Harness Resolution (`harness.ts`)**: Determines *what* to run. It resolves the requested model and provider route into a specific agent command and environment.
2.  **Run Orchestration (`runner.ts`)**: The conductor. It manages the `spawnAgent` lifecycle, claim pre-acquisition, process spawning (as group leaders), I/O piping, timeout/liveliness limits, and run finalization.
3.  **Warden Enforcement (`warden.ts`)**: Provides filesystem safety. It takes a pre-run snapshot, and post-run it verifies that only authorized paths were modified, restoring unauthorized changes.
4.  **Verification (`verify.ts`, `stack.ts`)**: Evaluates the outcome. The engine triggers an asynchronous verification phase at claim close, checking stack-specific invariants (like compile or test checks).
5.  **Signature Extraction (`signature.ts`)**: Used to capture behavioral or structural drift, especially for Java or Python code, detecting mismatches in signatures to inform outcomes.

## Step-by-Step Flow

The primary entry point is `spawnAgent(opts: SpawnAgentOpts)` in `migration/guildctl/runner.ts`.

### 1. Initialization and Claim Acquisition

When `spawnAgent` is called, it initializes the run state in the SQLite registry using `startRun`. It resolves the environment via `resolveAgentLaunch` (if not already provided in `opts.resolution`).

If `opts.preClaim` is provided, the engine synchronously executes a claim acquisition phase (`spawnSync("node", claimArgs, ...)`).
*   If claiming fails or nothing is available, the run is short-circuited (`finishRun` with code 0 or 1).
*   If successful, it updates the `prompt` using `promptForArtifact(preClaimedArtifactId)` to contextualize the agent. It also snapshots the workspace via `snapshotWorkspaceForWardenWithExclusions` to prepare for strict warden enforcement.

### 2. Process Spawning

The harness command is resolved via `resolveAgentSpawn`. Crucially, the process is launched as a process group leader (`detached: true` in `spawn()` options):

```typescript
// migration/guildctl/runner.ts:spawnAgent
const proc = spawn(agentSpawn.command, agentSpawn.args, {
  cwd: projectRoot,
  env: agentEnv,
  stdio: logStream ? ["ignore", "pipe", "pipe"] : "inherit",
  shell: agentSpawn.shell,
  detached: true, // R8/FR-035: spawn as a process-group leader
});
setRunPid(db, run.run_id, proc.pid ?? null);
```

This ensures that terminating the attempt can reliably kill the whole tree, not just the shim. The engine then intercepts operator signals (`SIGINT`, `SIGTERM`) to forward them gracefully down the process tree (`signalProcessGroup`).

### 3. Execution, Liveliness, and Limits

During execution, `runner.ts` monitors process health and bounds:
*   **Logging:** Outputs are piped through `createTimestampTransform()` and written to a log file.
*   **Liveliness (TASK-07):** Every byte observed on stdout/stderr bumps a `lastActivityMs` timer. If silence exceeds the `inactivityTimeoutMs`, the engine kills the tree.
*   **Wall-clock Limits:** An overall `timeoutHandle` enforces maximum run durations.

These bounds trigger process group termination and flag variables (`inactivityKilled`, `ceilingKilled`, `timedOut`) used later in finalization.

### 4. Settling and Cleanup

When the process exits (or is killed), the engine enters `finalize` and `completeRun` (async).

1.  **Warden Enforcement:** If a claim was held, `enforceWardenSnapshot` compares the current workspace against the pre-run snapshot. Unauthorized changes (modifications to files not in `wardenAllowedPaths`) are restored, and "created" violations are hard-deleted. If violations occur, the run is marked failed (`finalExitCode = 1`).
2.  **Claim Release:** If the agent exits 0 but the claim isn't advanced, or if `opts.releaseClaimsOnFailure` is set, the engine auto-releases the claims (`releaseClaimsForRun`).
3.  **Process Group Cleanup:** Wait on the `terminationPromise` to ensure orphaned child processes (survivors) are reaped.
4.  **Verification:** Triggers `verifyAtClaimClose` (which reads stack configurations via `stack.ts` like `PerArtifactVerify`) asynchronously. Its result is recorded but never blocks or gates the run's final exit code.

### 5. Finalizing the Run

Finally, the engine computes an outcome label via `deriveOutcomeLabel` (evaluating if progress was made, looking at `filesWrittenCount` powered by warden diffs or git diffs). It records the final exit code, reason, token usage, and status transitions into the registry via `finishRun`.

## Invariants and Edge Cases

*   **Process Isolation:** The engine relies on process groups. A failure in termination (`survivorPids`) is recorded but does not block claim release.
*   **Warden Supremacy:** Unauthorized file modifications are physically reverted on disk during finalization, ensuring a stray agent cannot corrupt the workspace.
*   **Never Gate on Verification:** Verification at claim close (`verifyAtClaimClose`) is purely observational. A failure in the verifier records a failure fact, but does not alter `finalExitCode`.
*   **Single-Shot Settling:** `finalize` guarantees that process exit, timeout, or inactivity triggers finalization exactly once via the `settled` boolean guard.

## Harness Resolution (Extension Point)

`migration/guildctl/harness.ts` handles mapping config strings to actual CLI commands. It statically defines a set of known bundled harnesses (e.g., `opencode`, `goose`).

```typescript
// migration/guildctl/harness.ts:resolveBundledHarness
function resolveBundledHarness(name: string, root: string): HarnessResolution {
  if (name === "opencode") {
    return { name, command: bundledFile(root, path.join("harness", "opencode.mjs")), targetCommand: "opencode", source: "config" };
  }
  // ...
```

To support a new autonomous agent framework, one would typically add a shim into the `harness/` directory and register it in `resolveBundledHarness`.

## Signatures and Stack

While `runner.ts` drives the process, it utilizes tools like `migration/guildctl/signature.ts` for fine-grained semantic drift analysis. `signature.ts` parses Java/Python files to extract structure (`MemberSignature`), which is used downstream to compare before/after states of migrations without relying on textual diffs.

Similarly, `migration/guildctl/stack.ts` provides the vocabulary for per-artifact verifications. It explicitly prohibits `workspace_root` wide builds, enforcing that verifications (`PerArtifactVerify`) only check specific scopes, ensuring the execution engine remains bounded to its claim.