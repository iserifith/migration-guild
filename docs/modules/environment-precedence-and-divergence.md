# Environment Precedence and Divergence

## Purpose and Overview

The Migration Guild executes within a complex runtime environment where configuration can be inherited from the ambient shell (e.g., global exports, CI/CD secrets) or explicitly defined in a project-local `.env` file. To ensure that a given checkout is entirely self-describing, the `guildctl` CLI enforces strict **Environment Precedence** rules.

By default, variables defined in a local workspace `.env` take absolute precedence over the ambient environment. This ensures that operators running the guild locally are shielded from stray system exports. However, because overriding environment variables globally is destructive, `guildctl` uses a "snapshot-then-apply" algorithm. This allows the CLI to track exactly where every configuration variable came from, and accurately report **Divergences** (when the `.env` value conflicts with an ambient value) to the operator at the start of every run.

This deep-dive maps how the environment is loaded before command execution, how precedence is calculated and applied, and how divergence is safely reported without leaking credentials.

## Architecture and Scope

The environment precedence and reporting logic spans three primary components:

1. **`migration/guildctl/cli.ts`**: The top-level entry point where the environment is loaded *before* any other module.
2. **`migration/guildctl/env.ts`**: The core precedence algorithm, divergence calculation, and precedence modes.
3. **`migration/guildctl/runtime-report.ts`**: Safely formats the divergence output for the CLI run-start block, maintaining strict separation from the true run configuration.

---

## Step-by-Step Flow and Mechanics

### 1. Early Initialization (`cli.ts`)

The environment must be resolved before any downstream logic (such as commander parsers or database connections) attempts to read `process.env`.

```typescript
// migration/guildctl/cli.ts:18
import { hasAmbientEnvFlag, loadGuildEnvironment } from "./env";
loadGuildEnvironment({
  cwd: process.cwd(),
  ambientFlag: hasAmbientEnvFlag(process.argv),
});
```

`loadGuildEnvironment` is invoked immediately at the module scope of `cli.ts`. Notice that `hasAmbientEnvFlag` manually scans `process.argv` before `commander` parses anything. This is because a project `.env` file cannot dictate the precedence mode that evaluates it; only the operator passing `--ambient-env` on the command line, or `GUILD_ENV_PRECEDENCE=ambient` in their shell, can switch the mode to favor ambient over project.

### 2. Snapshooting the Ambient State (`env.ts`)

Inside `loadGuildEnvironment` (`migration/guildctl/env.ts`), the algorithm begins by capturing the existing shell environment:

```typescript
// migration/guildctl/env.ts:loadGuildEnvironment
const ambient: NodeJS.ProcessEnv = { ...(options.ambient ?? target) };
const mode = resolveEnvPrecedenceMode(ambient, ambientFlag);
```

This `ambient` object acts as the baseline. The algorithm relies on this snapshot rather than using a standard `dotenv` configuration (which typically applies `override: true` and destroys the old values in `process.env`).

### 3. Parsing Candidates and Computing Divergence

The algorithm reads the local `.env` as the `project` object and layers in any backwards-compatibility CLI-install-relative candidates (`defaultInstallCandidates()`).

Crucially, **before** merging these values into `process.env`, the code computes the `EnvDivergence` set:

```typescript
// migration/guildctl/env.ts
for (const [variable, projectValue] of Object.entries(project)) {
  const ambientValue = ambient[variable];
  if (ambientValue === undefined || ambientValue === projectValue) continue;
  // ...
```

A divergence occurs when both the `ambient` snapshot and the `project` `.env` define the same variable but with differing values.
During this step, if the variable name matches known credential patterns (checked via `isSensitiveEnvName`), the actual values are stripped out and replaced with the literal string `<redacted>`. The resulting `EnvDivergence[]` array is safe for telemetry and terminal output.

### 4. Applying Precedence and the "Fail-Closed" Rule

Finally, the function iterates through the accumulated candidate file values and assigns them to the `target` (usually `process.env`), logging their origin (`project-file` or `ambient`) into an `EnvOriginMap`.

The core precedence logic enforces a crucial safety invariant known as the **Fail-Closed empty-value rule**:

```typescript
// migration/guildctl/env.ts
const fileWins = value !== "" && (ambientValue === undefined || (mode === "project" && key in project));
```

If a developer leaves a credential empty in their `.env` file (e.g., `NINE_ROUTER_API_KEY=`) but their ambient shell holds a working token, standard overriding behavior would wipe out the working token with an empty string, causing silent authentication failures.
The Fail-Closed rule detects when the file value is strictly `""` and the ambient value is defined. In this specific scenario, it forces the winner to be `ambient` and flags the divergence with `emptyButDefined: true`.

### 5. Run-Start Reporting (`runtime-report.ts`)

Later in the pipeline, when a phase is about to spawn an agent, it must present a summary to the operator.

`resolveAndReportRuntime` inside `migration/guildctl/runtime-report.ts` consumes the secret-scrubbed `EnvDivergence[]` (exported from `env.ts` as `envDivergences()`) and renders it into the CLI output:

```
[guildctl] runtime: harness=opencode provider=https://api.openai.com/v1 model=gpt-4o
[guildctl] environment: 1 divergence(s) between .env and the inherited environment
  OPENAI_API_KEY  .env=<redacted>  ambient=<redacted>  → .env wins
```

By passing the `.env` diverges entirely out-of-band from the `agentEnv` object (which is handed to the spawned subprocess), `runtime-report.ts` structurally guarantees that no runtime error or string-concatenation bug can accidentally print the raw API key to the console.

---

## Invariants and Edge Cases

- **Self-Determination Boundary**: A local `.env` cannot contain `GUILD_ENV_PRECEDENCE=ambient`. The mode is resolved purely from the ambient snapshot and the CLI flag before the `.env` file is even parsed.
- **Unreadable Files**: If `parseCandidate` hits an `fs.readFileSync` error (e.g., permissions), it gracefully returns `{}`. A bad `.env` file does not crash the CLI; it simply contributes zero variables, identical to a missing file.
- **Install-Relative Fallbacks**: `installCandidates` are historically preserved locations where `guildctl` might find a `.env` in the global `node_modules`. These candidates *only* fill gaps; they never participate in the local project divergence report, and they never overwrite an ambient value.

## Extension Points

- Adding new heuristics to `isSensitiveEnvName` (in `migration/guildctl/util.ts`) automatically protects new environment variable patterns across both divergence calculations in `env.ts` and downstream reporting in `runtime-report.ts`.
- The `EnvLoadResult` returned by `loadGuildEnvironment` allows entirely custom targets for dependency injection (via `LoadEnvironmentOptions.target`) which is extensively used by Vitest environment test suites to assert precedence behavior without mutating the test runner's own `process.env`.