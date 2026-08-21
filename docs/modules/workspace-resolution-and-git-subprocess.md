# Workspace Resolution and Git Subprocess Scrubbing

## Purpose and Overview

The Migration Guild requires robust workspace identification to isolate its state (the registry, run ledgers, configuration) and reliably interface with the host repository. A critical subset of this involves executing `git` commands (e.g., during evidence collection). Because Migration Guild commands can be triggered during git hooks (such as `pre-commit`), there is a risk that git environment variables set by the host hook will "leak" into subprocesses, causing commands to operate on the wrong context.

This deep-dive explains how `guildctl` reliably resolves the workspace root and how it safely spawns git subprocesses by scrubbing dangerous hook environment variables.

## Architecture and Scope

The logic spans two primary modules:
1. **`migration/guildctl/config.ts`**: Contains the hierarchy and rules for determining "where" the workspace is located.
2. **`migration/guildctl/workspace.ts` & `migration/guildctl/util.ts`**: Handles evidence gathering (including git status) and enforces a scrubbed environment for all git subprocesses.

---

## Workspace Resolution Mechanics

The Migration Guild identifies the root of the active workspace using a strict precedence order. This ensures that a developer running commands deep within a sub-directory, or overriding the workspace explicitly, still targets the correct `.guild` directory.

### Precedence Rules
The resolution is handled by `resolveWorkspaceRoot` (`migration/guildctl/config.ts:resolveWorkspaceRoot`), which evaluates in this order:

1. **Explicit Flag**: If `--workspace <path>` is provided, it is resolved absolutely and used unconditionally.
2. **Environment Variable**: If `GUILD_WORKSPACE` is set, it takes precedence over discovery.
3. **Ascending Discovery**: If neither is set, it calls `findGuildRoot` (`migration/guildctl/config.ts:findGuildRoot`) starting from `process.cwd()`. This function walks up the directory tree looking for a `.guild` folder.
4. **Fallback Default**: If all else fails, it resolves to `__dirname, "..", "..", ".."` (the default kit root, assuming it is shipped inside the standard package structure).

### Ensuring the Root
When the config is loaded via `resolveGuildConfig`, it passes `process.cwd()` to `ensureGuildRoot` (`migration/guildctl/config.ts:ensureGuildRoot`), which attempts discovery via `findGuildRoot` and gracefully falls back to the start directory if no `.guild` is found. The resolved root is then injected into the returned `ResolvedGuildConfig` as the `guildRoot` property, which acts as the absolute base for resolving everything from `prompts.directory` to the `.guild/runs/` ledger.

---

## Git Subprocess Environment Scrubbing

When the guild collects initialization evidence (`migration/guildctl/workspace.ts:collectInitEvidence`), it gathers git information (branch, remotes, status, diff) by spawning `git` as a subprocess (`runGit`).

### The Hook Leak Problem
When a developer sets up a git hook (like `pre-commit`), Git natively sets a suite of environment variables (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, etc.) to point any subsequent `git` commands executed by the hook back to the repository that triggered it.

If the guild operator process is invoked *from within* that hook, it inherits this environment. When `runGit` later spawns `git status` or `git branch`, even if it passes a specific `cwd`, the inner git process will prioritize the `GIT_*` environment variables. If `runGit` happens to target a nested or entirely different repository, the leaked environment will redirect the command back to the *outer* repository, leading to silent, entirely incorrect state readings.

### The Scrubbing Solution

To prevent this, `guildctl` employs a strict scrubbing mechanism defined in `migration/guildctl/util.ts`.

At module load time, `util.ts` captures a snapshot of the current environment and strips all dangerous Git scope variables:

```typescript
const GIT_SCOPE_ENV: NodeJS.ProcessEnv = { ...process.env };
for (const key of [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_OBJECT_DIRECTORY",
  "GIT_COMMON_DIR",
]) {
  delete GIT_SCOPE_ENV[key];
}
```

It exports a function `gitEnv()` which simply returns this scrubbed object.

### Subprocess Invocation

When `migration/guildctl/workspace.ts` invokes git via `runGit`, it explicitly passes this scrubbed environment:

```typescript
function runGit(root: string, args: string[]): string {
  const res = spawnSync("git", args, { cwd: root, encoding: "utf8", env: gitEnv() });
  if (res.status !== 0) return (res.stderr || res.stdout || "").trim();
  return res.stdout.trim();
}
```

By providing `env: gitEnv()`, `spawnSync` isolates the subprocess from any hook-injected variables, ensuring that git respects the provided `cwd: root` instruction.

---

## Invariants and Edge Cases

- **Module Load Order**: The `GIT_SCOPE_ENV` constant in `util.ts` is initialized *immediately* upon module evaluation. This is crucial because it ensures the snapshot is taken and scrubbed before any other code has a chance to mutate the process environment during runtime setup.
- **Fail-Safe Git Output**: `runGit` handles non-zero exit codes (e.g., if the directory is not a git repository) by gracefully returning standard error or standard out instead of crashing, allowing `collectInitEvidence` to proceed.

## Extension Points

If the guild needs to spawn other tools that are highly sensitive to ambient environment variables (like `npm` or `python`), a similar scrubbing pattern (e.g., `npmEnv()`) should be established in `util.ts` to prevent `.npmrc` or `VIRTUAL_ENV` leakage during nested executions.
