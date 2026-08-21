# The Warden: Filesystem Boundary Enforcement

## Purpose and Overview

The **Warden** is a core component of the Migration Guild's runtime (`migration/guildctl/warden.ts`) responsible for enforcing strict filesystem boundaries during autonomous agent execution. When an agent works on a claimed artifact, the Warden ensures it only writes to paths it is authorized to modify.

If an agent (or a bundled harness CLI) writes to out-of-scope paths, the Warden detects this, hard-deletes created files, restores modified/deleted files to their pre-run state, and records a `filesystem-violation` event in the registry. This guarantees that parallel agents working in the same shared workspace cannot accidentally (or maliciously) overwrite each other's completed work, core tool dependencies, or unassociated source files.

The mechanism operates via an explicit before/after snapshot model (Research R10) rather than real-time filesystem tracing (like `ptrace` or eBPF). This makes it cross-platform and reliable without requiring root privileges.

## Architecture

The Warden subsystem consists of the following key surfaces:

1. **Snapshots (`WardenSnapshot`)**: A map of all files in the workspace (excluding `.git`, `node_modules`, `build`, etc.), storing their relative path and SHA-256 hash.
2. **Exclusions**: Paths that the Warden deliberately ignores. This includes build outputs, temporary evidence directories, run log files, and SQLite sidecar files (`-wal`, `-shm`).
3. **Allow-list (Expected Output Paths)**: A set of paths the agent is legitimately allowed to modify. This is derived dynamically based on the artifact's metadata and the current wave of execution.
4. **Enforcement Routine (`enforceWardenSnapshot`)**: The core function that diffs the post-run filesystem state against the pre-run snapshot, identifies violations based on the allow-list, and performs rollbacks.

## Step-by-Step Flow

The lifecycle of Warden enforcement occurs around an agent's execution attempt (`migration/guildctl/runner.ts:spawnAgent`).

### 1. Pre-Run Snapshot

Before the agent process is spawned (and after the artifact claim is secured), the runner calls `snapshotWorkspaceForWardenWithExclusions`.

This function:
- Walks the workspace directory (`migration/guildctl/warden.ts:walk`).
- Skips excluded directories (`.git`, `node_modules`, `.gradle`, `build`) and any explicitly passed transient exclusions (e.g., the run log file).
- Records the content bytes and SHA-256 hash of every included file into a `WardenSnapshot`.

### 2. Allow-list Computation

The runner resolves the set of paths the agent is authorized to write to (`wardenAllowedPaths`).

This allow-list consists of:
- **Claim-specific Paths**: `expected_output_paths` stored on the claim row in the registry (`migration/registry/commands/claim.ts:deriveExpectedOutputPaths`). For example, migrating `legacy/src/Math.java` allows writes to `modern/src/main/java/Math.java` and `modern/src/test/java/MathTest.java`.
- **Companion Paths**: Operator-approved companion outputs fetched from the registry (`approved_companion_outputs`).

### 3. Agent Execution

The agent runs. It may modify any files it wants within the shared workspace.

### 4. Post-Run Enforcement

When the agent process completes (or is killed via timeouts), the runner calls `enforceWardenSnapshot` (`migration/guildctl/warden.ts:enforceWardenSnapshot`).

This function:
1. Takes an *after* snapshot of the workspace.
2. Expands the allow-list dynamically to include:
    - The claim's original allowed paths.
    - **Wave-scoped Sibling Outputs**: Outputs expected for *other* artifacts in the same wave (`registeredExpectedOutputPaths`). This prevents the Warden from reverting shared stubs (e.g., `SystemGlobals.java`) that parallel agents might legitimately write before the owning artifact is claimed.
    - **Shared Project Scaffold**: The active stack's build file, settings file, and resources directory (e.g., `modern/build.gradle`). An agent may legitimately need to add a dependency line, so these are implicitly allowed (`sharedProjectPaths`).
3. Diffing the snapshots: For every file present in either the before or after snapshot (that isn't excluded):
    - If the path is in the expanded allow-list, changes are accepted.
    - If the path is *not* in the allow-list:
        - **Created**: The file was not in the before snapshot. It is hard-deleted (`fs.rmSync`).
        - **Deleted**: The file was in the before snapshot but not the after snapshot. It is restored to its original bytes.
        - **Modified**: The SHA-256 hash changed. It is restored to its original bytes.
4. If violations occurred:
    - A `filesystem-violation` event is recorded in the registry (`appendEvent`), noting which paths were out of scope.
    - The artifact is tagged `blocked:out-of-scope-path`.
    - The run is marked as failed, even if the agent exited with code 0.

## Invariants and Edge Cases

- **Fail-Closed on Unknown Paths**: Any path modified by the agent that is not explicitly excluded or on the allow-list is reverted.
- **"Created" Violations are Data Loss**: When the Warden reverts a `created` violation, it hard-deletes the file. There is no original state to restore to. The operator summary specifically distinguishes deleted files from restored files to clarify this data loss.
- **Wave-Scoped Allow-list Tolerance**: Permitting writes to paths owned by *unclaimed* artifacts in the *same wave* is a crucial edge case. It allows parallel agents to generate shared dependency stubs without triggering violations. However, it strictly does not permit writes to artifacts in *future* waves, preserving the integrity of untouched code.
- **Log Survival**: The agent's run log file must survive the Warden. The runner dynamically adds the run log file to the transient exclusions list before taking the pre-run snapshot (`migration/guildctl/runner.ts:spawnAgent`).
- **SQLite Sidecars**: The `.db-wal` and `.db-shm` files must be excluded, as SQLite modifies them continuously. `activeSqliteWardenExclusions` handles this dynamically.
- **Files Written Metric**: The Warden snapshots double as the source of truth for the `files_written_count` metric (`wardenSnapshotDiff`), which is more accurate and cheaper than running `git diff` post-run.

## Gotchas

- **Shared Scaffold Reverts**: If `sharedProjectPaths` fails to resolve the stack configuration, valid edits to `build.gradle` might be reverted.
- **Agent Crashes vs Warden**: If the entire node runner crashes mid-run (e.g., OOM), the post-run enforcement does not run, and the workspace remains mutated. The Warden only protects against the *agent* modifying things out-of-bounds, not the runner terminating ungracefully.

## Extension Points

- `deriveExpectedOutputPaths` (`migration/registry/commands/claim.ts`): Adding new layout translations (e.g., Python modules) requires updating this function to correctly generate the initial expected paths.
- `sharedProjectPaths` (`migration/guildctl/warden.ts`): If a new stack needs a different set of shared files (e.g., `package.json`), this logic needs to be extended to map those scaffold entries correctly.
