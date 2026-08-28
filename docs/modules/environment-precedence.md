# Environment Precedence and Divergence

## Purpose and Overview

The **Environment Precedence and Divergence** subsystem in `migration/guildctl/env.ts` manages how the runtime environment is constructed. Its primary goal is to make each workspace checkout self-describing (SC-003): an explicit `.env` file within the project should dictate the runtime behavior over the ambient shell environment, unless explicitly overridden.

However, simply overwriting the environment variables (e.g., using `dotenv` with `override: true`) destroys the original state, making it impossible to report what changed. The system uses a **snapshot-then-apply** algorithm to safely construct the target environment while recording exact differences (divergences) between the project's configuration and the host system's shell environment.

## Architecture and Scope

The environment precedence logic spans three primary areas:
1. **Resolution & Precedence (`migration/guildctl/env.ts`)**: Evaluates the ambient shell, parses project and install-fallback `.env` files, computes divergences, and applies the winning variables.
2. **Reporting (`migration/guildctl/runtime-report.ts`)**: Renders the differences between the `.env` file and the shell safely, specifically ensuring no raw launch environment variables ever reach the reporting layer.
3. **Secret Designation (`migration/guildctl/util.ts`)**: Defines the central heuristic (`isSensitiveEnvName`) used universally to identify credentials that must be redacted from reports.

---

## Step-by-Step Flow and Mechanics

### 1. Snapshotting the Ambient Environment
Before any files are parsed, `loadGuildEnvironment` (`migration/guildctl/env.ts:loadGuildEnvironment`) takes an immutable snapshot of the existing `process.env`. This serves as the comparison baseline (`ambient`).

The precedence mode is also determined here using `resolveEnvPrecedenceMode`:
- **`project` (Default)**: Workspace `.env` wins against ambient shell variables.
- **`ambient`**: The host's ambient variables win. This mode can be opted into via the `--ambient-env` CLI flag or by explicitly setting `GUILD_ENV_PRECEDENCE=ambient`.

### 2. File Parsing and Candidate Loading
The algorithm reads candidate `.env` files sequentially using `dotenv.parse` without any side-effects:
- **Workspace `.env`**: Evaluated first. This file drives the divergences.
- **Install Candidates**: Discovered by `defaultInstallCandidates` (usually the `migration/` or `dist/guildctl/` root). These act as fallbacks for legacy/default values. They use first-definition-wins semantics internally, but they **never override** an ambient value and are ignored during divergence calculations.

### 3. Divergence Computation and Redaction
Before any variables are applied to `process.env`, the algorithm calculates the differences between the project `.env` and the `ambient` snapshot.

Iterating over the workspace variables:
- If `ambient[key]` differs from `project[key]`, a divergence is recorded.
- **Secret Redaction**: The key is checked against `isSensitiveEnvName` (`migration/guildctl/util.ts:isSensitiveEnvName`), which looks for patterns like `API_KEY`, `TOKEN`, `SECRET`, `PASSWORD`, etc. If a match is found, the value in the divergence report is immediately replaced with `<redacted>`.
- **Fail-Closed Evaluation (US1/#119)**: If the workspace file defines a variable as explicitly empty (e.g., `API_KEY=`) but the ambient environment possesses a working (non-empty) value, the system overrides the precedence mode. The ambient value wins to prevent a silent 401 failure, and the divergence is flagged with `emptyButDefined: true`.

### 4. Applying Precedence
Once divergences are locked, the environment is applied to the target (`process.env`).
- If `mode === "project"` and the value is not empty-but-defined, `.env` overwrites ambient.
- Fallback candidates only fill missing ambient variables.
- The source of every value is recorded in an `EnvOriginMap` (e.g., `'project-file'` or `'ambient'`).

### 5. Runtime Reporting Isolation
At every phase entry in the pipeline, `resolveAndReportRuntime` (`migration/guildctl/runtime-report.ts:resolveAndReportRuntime`) emits a summary of the environment.

Crucially, the renderer (`renderRuntimeReport`) receives the safe `ResolvedRuntimeReport` and the pre-computed `EnvDivergence[]` as completely separate inputs. **The actual `agentEnv` launch environment is never passed to the report renderer.** This absolute isolation guarantees that a bug in reporting logic cannot accidentally serialize or leak a raw API key.

---

## Invariants and Edge Cases

- **No Destructive Overrides**: `dotenv` is intentionally prevented from modifying `process.env` itself. The environment is only mutated at the very end of `loadGuildEnvironment` after all snapshots and comparisons are finalized.
- **Single Source of Truth for Secrets**: The regex predicate in `isSensitiveEnvName` is the only definition of a secret. This ensures that the evidence-log scrubber, preflight reporter, and divergence reporter all agree on what constitutes a credential.
- **Divergence Exclusivity**: Only the workspace `.env` participates in the divergence calculation. If a built-in `.env` from the toolkit installation differs from the ambient environment, it is silently applied or ignored but never loudly reported, as it does not describe the specific checkout.

## Gotchas

- **Empty vs. Undefined**: An explicitly empty string in a `.env` file (`VAR=`) is semantically different from the variable missing entirely. The fail-closed mechanism explicitly guards against `VAR=` destroying a working ambient credential, but if the variable is simply omitted from `.env`, it never enters the divergence list.
- **Reporting Timing**: The environment is loaded when the process starts, but the `EnvDivergence` report is deliberately held back. `runtime-report.ts` renders it at each phase entry so that logs emit the report once per run rather than once per module load.

## Extension Points

- **`isSensitiveEnvName`**: Additional variable naming conventions (like `_CERT` or `_PRIVATE_KEY`) can be added to the regex in `util.ts` to expand credential redaction automatically across the entire guild suite.
- **`EnvOriginMap`**: The origin map generated by the load result can be used by future telemetry systems to track how often developer environments rely on ambient variables vs project-local configs.
