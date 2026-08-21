# The `guildctl` CLI Dispatch Architecture

## Overview

The `guildctl` CLI (`migration/guildctl/cli.ts`) serves as the single entry point for all Migration Guild operations, managing everything from workspace initialization and phase execution to agent arbitration and pipeline monitoring.

Unlike typical monolithic scripts that just define routes, `guildctl` carefully orchestrates environment precedence, process lifecycle boundaries, and structured error reporting. It uses `commander` for definition and argument parsing, but places important custom hooks before and during dispatch to ensure context like `GUILD_WORKSPACE` and early environment variables are settled before downstream commands attempt to boot agents or databases.

## 1. Early Environment Loading

Before the first sub-command is ever imported, `cli.ts` establishes the execution environment precedence. This prevents race conditions where imported modules might read `process.env` before the CLI sets it.

```typescript
// migration/guildctl/cli.ts:18
import { hasAmbientEnvFlag, loadGuildEnvironment } from "./env";
loadGuildEnvironment({
  cwd: process.cwd(),
  ambientFlag: hasAmbientEnvFlag(process.argv),
});
```

Because `commander` hasn't parsed the arguments yet, `cli.ts` uses `hasAmbientEnvFlag(process.argv)` to scan the raw argument list for `--ambient-env`. This guarantees the environment loading algorithm in `migration/guildctl/env.ts` decides whether to favor the `.env` file or inherited ambient variables (Fail-Closed constitution rule) immediately.

## 2. Command Registration & The `preAction` Hook

`guildctl` uses the `Command` class from `commander` to register its subcommands. However, to bridge global configuration options (like `--workspace` or `--db`) into environment variables that deeply nested components can access without threading arguments down, `cli.ts` employs a `preAction` hook:

```typescript
// migration/guildctl/cli.ts:98
program.hook("preAction", (_thisCommand, actionCommand) => {
  const flag = program.opts()["workspace"] as string | undefined;
  if (flag) process.env.GUILD_WORKSPACE = path.resolve(flag);
  if (!["init", "config", "config-set"].includes(actionCommand.name())) {
    const warning = registryPathWarning(dbPath(), workspaceRoot());
    if (warning) process.stderr.write(`${warning}\n`);
  }
});
```

### Invariants Maintained
- **Global Context Agreement:** Setting `process.env.GUILD_WORKSPACE` in `preAction` ensures that `resolveWorkspaceRoot()` and all defaults across the module tree agree on the target directory.
- **Initialization Exemption:** The commands that *create* the workspace (`init`, `config`, `config-set`) are deliberately skipped by the registry path warning logic because they must run before `.guild/` exists.

## 3. Sub-Command Dispatch

Commands are registered declaratively using `program.command(...)`. Each defines its own options, descriptions, and action. Most of these delegate immediately to specific runner modules inside `migration/guildctl/commands/`.

For instance, the `migrate` phase:

```typescript
// migration/guildctl/cli.ts:333
program
  .command("migrate")
  .description("Phase 4: Migrate planned artifacts (TDD: tests first, then production code)")
  .option("-p, --parallel <n>", "Number of parallel migration sessions", parseInt)
  .option("-w, --wave <n>", "Only migrate artifacts in this wave number", parseInt)
  .action(async (opts) => {
    assertDbExists(dbPath());
    await runMigrate(db(), { parallel: opts.parallel, wave: opts.wave });
  });
```

`guildctl` also supports grouping subcommands onto a shared namespace object for deeper nesting, as seen in `evidence` and `benchmark`:

```typescript
// migration/guildctl/cli.ts:474
const evidence = program
  .command("evidence")
  .description("Record and inspect proof submitted by Critics and evaluators");

evidence
  .command("add")
  // ...
```

## 4. Preflight and Doctor Diagnostics

A major architectural pillar of `guildctl` is ensuring safe execution. The `preflight` and `doctor` commands (registered at `migration/guildctl/cli.ts:167` and `migration/guildctl/cli.ts:184`) act as startup-validation hooks, which operators run before long pipelines. 

`doctor` executes multiple integrity checks across the database, registry schema, file system state, and pipeline rules. Rather than crashing immediately, it aggregates the checks into an array of `CheckResult[]`, reports each pass/fail cleanly to stdout, and exits with `1` only if any step was unsatisfactory:

```typescript
// migration/guildctl/cli.ts:238
if (checks.some(([ok]) => !ok) || preflight.verdict === "fail" || stateFailed) process.exit(1);
```

The underlying `doctor` checks are provided by `runPipelineStateChecks` (`migration/guildctl/doctor.ts:133`), which enforces sanity checks like verifying if SQLite integrity is `ok`, if all artifacts have a planned wave, and if dangling active claims exist.

## 5. Error Handling and Exit Codes

`cli.ts` handles structured process termination. It avoids dumping stack traces for known operator errors or pipeline states that are intentionally blocked.

### Operator and Domain Errors
Instead of allowing unhandled promise rejections to crash the CLI loudly, specific commands use `try/catch` to map known domain exceptions to polite, non-zero exits. 

For instance, in `plan`:
```typescript
// migration/guildctl/cli.ts:311
    } catch (error) {
      if (error instanceof PlanInvariantError) {
        process.stderr.write(`\n  ✗ Planning failed invariant verification: ${error.message}\n`);
        process.exit(1);
      }
      throw error;
    }
```

Similarly, in `auto`:
```typescript
// migration/guildctl/cli.ts:571
    } catch (err) {
      if (err instanceof RegistryError) {
        // US3 (#155): a resume/claim refusal is an expected operator error, not
        // a crash — one clean line, non-zero exit, no stack trace.
        process.stderr.write(`\n✗ ${err.message}\n\n`);
        process.exit(1);
      }
      throw err;
    }
```

### Process Exits
For simple boolean-failure commands (like `preflight` failure), `cli.ts` will strictly invoke `process.exit(1)` immediately, sidestepping Node's implicit event loop completion. For the generic `run [phase]` catch-all command, it opts to set `process.exitCode = 1;` so that it returns failure but allows synchronous cleanup (if any) to unwind:

```typescript
// migration/guildctl/cli.ts:746
      process.exitCode = 1;
```

## 6. Execution Kick-off

The final step in `migration/guildctl/cli.ts:751` is:

```typescript
program.parse();
```

This synchronously consumes `process.argv` and triggers the matched command's action block. If it resolves an asynchronous action, Commander waits for the returned promise to settle, ensuring the Node.js event loop remains active until the CLI run is completely resolved.

## Note on Signal Handling
While the core CLI entry point does not implement top-level `process.on("SIGINT", ...)` listeners for graceful shutdown, it pushes that responsibility into the runner execution layer. In long-running parallel workloads (like `migration/guildctl/runner.ts`), `SIGINT` signals are intercepted (`process.on("SIGINT", onOperatorSigint)`) to cleanly terminate active child processes (agents) before exiting, ensuring no dangling agent processes are left hanging.
