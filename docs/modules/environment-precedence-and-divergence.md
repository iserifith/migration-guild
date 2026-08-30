# Environment Precedence and Divergence

## Purpose and Overview

The Migration Guild subsystem aims to ensure that a checkout is "self-describing" (SC-003) by relying on a workspace `.env` file to describe the runtime environment a checkout uses. The environment precedence and divergence system, located in `migration/guildctl/env.ts` and `migration/guildctl/runtime-report.ts`, implements the rules for which environment values take precedence and how differences between the workspace configuration and the ambient shell are reported truthfully (FR-020–FR-026).

Rather than blindly overriding existing shell variables (which would destroy the ability to report on what changed), this subsystem relies on a "snapshot-then-apply" algorithm. It loads variables, calculates the exact divergences, cleanly redacts secrets, and provides a structured `ResolvedRuntimeReport` to the operator during pipeline execution—all while actively preventing credential leakage into the run output.

## Architecture

The system splits environment evaluation into two distinct boundaries:
1. **Environment Loading and Precedence (`migration/guildctl/env.ts`)**: Resolves the "snapshot-then-apply" logic. It computes a collection of `EnvDivergence` objects, identifying the winner between the workspace file and the ambient shell, without yet overriding the process environment.
2. **Runtime Reporting (`migration/guildctl/runtime-report.ts` and `migration/guildctl/harness.ts`)**: Converts the resolved configuration into a strictly separated structural report. It consumes the `EnvDivergence` output and a sanitized `ResolvedRuntimeReport` to emit the startup state to the operator, guaranteeing that the raw `agentEnv` (which includes real credentials) is never serialized or seen by the renderer.

## Step-by-Step Flow

### 1. Snapshotting the Environment
When the pipeline starts, `loadGuildEnvironment` (`migration/guildctl/env.ts`) creates an immutable snapshot of the ambient environment (`NodeJS.ProcessEnv`). This serves as the comparison basis before any file is read or any overriding logic runs.

### 2. Candidate Parsing and Divergence Calculation
The system reads the workspace `.env` (and any backwards-compatible install candidates from `defaultInstallCandidates()`). Before applying these values, it compares every key defined in the project against the ambient snapshot.

If there is a mismatch, it registers an `EnvDivergence`:
```typescript
// From migration/guildctl/env.ts
divergences.push({
  variable,
  projectValue: secret ? REDACTED : projectValue,
  ambientValue: secret ? REDACTED : ambientValue,
  winner,
  secret,
  ...(emptyButDefined ? { emptyButDefined: true } : {}),
});
```

Secret detection is handled by `isSensitiveEnvName` in `migration/guildctl/util.ts`, which scans for standard credential strings like `API_KEY` or `TOKEN`. If a secret is matched, the reported value is literally hardcoded to `<redacted>`.

### 3. Snapshot-then-Apply
Unlike typical `dotenv` usages with `override: true`—which immediately clobber the environment—the precedence algorithm evaluates who wins (the project mode or the ambient mode) and selectively populates the target `process.env`. The source of the final resolved value is stored in an `EnvOriginMap`.

### 4. Rendering the Startup Report
At manual phase entry, `resolveAndReportRuntime` (`migration/guildctl/runtime-report.ts`) is called. This function explicitly uses two separate models to prevent secret leakage:
1. It resolves the `ResolvedRuntimeConfig` through `resolveAgentLaunch` (`migration/guildctl/harness.ts`), which constructs the exact `agentEnv` that the agent process will receive.
2. It immediately calls `toResolvedRuntimeReport`, stripping the private `agentEnv` to generate a safe `ResolvedRuntimeReport`.

```typescript
// From migration/guildctl/harness.ts
export function toResolvedRuntimeReport(resolution: ResolvedRuntimeConfig): ResolvedRuntimeReport {
  const { agentEnv: _privateLaunchEnv, ...report } = resolution;
  return report;
}
```

The resulting UI string emitted by `renderRuntimeReport` explicitly renders `config divergence` and `.env=... ambient=...` values natively, using the secret-free divergence projection computed during step 2.

## Invariants and Edge Cases

- **Fail-Closed on Empty Variables:** If a project `.env` defines a credential as explicitly empty (e.g., `NINE_ROUTER_API_KEY=`), but the surrounding ambient shell already contains a valid token, the subsystem will trigger a Fail-Closed constraint. It will deliberately keep the ambient value to prevent a silent 401 authentication failure, marking the divergence with `emptyButDefined: true` (`migration/guildctl/env.ts`).
- **No Self-Opt-In:** A project file cannot grant itself ambient precedence by specifying `GUILD_ENV_PRECEDENCE=ambient`. The mode is read exclusively from the pre-flight ambient snapshot or the CLI flag `hasAmbientEnvFlag`.

## Gotchas

- **Reporting Cadence:** The divergence report rendering is intentionally omitted from the environment module itself. It happens strictly once per run in `runtime-report.ts` at phase entry. This prevents emitting noise on every internal module load.
- **Reporting vs. Reality:** Because `resolveAgentLaunch` is the single source of truth for both `agentEnv` compilation and `ResolvedRuntimeReport` generation, the printed pipeline startup banner cannot possibly describe a different configuration than what the executing agent receives.