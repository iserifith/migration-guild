# Environment Precedence and Divergence

**Purpose:** The environment precedence subsystem configures the runtime environment for the guildctl CLI operator and its agent subprocesses. It actively evaluates and reports any differences (divergences) between a workspace `.env` file and the surrounding shell environment, while enforcing a fail-closed rule to protect critical credentials.

**Scope:** `migration/guildctl/env.ts`, `migration/guildctl/runtime-report.ts`, and `migration/guildctl/util.ts`.

---

## 1. Architecture and Intent

Traditional applications often use `dotenv` with `override: true` to let a project's `.env` file overwrite ambient shell variables. The migration-guild rejects this simple overwrite behavior in order to fulfill two goals:

1.  **Divergence Reporting (FR-022):** The run state must truthfully report when a project's `.env` differs from what the shell provides, so a configuration error isn't silently ignored.
2.  **Self-Describing Checkouts (SC-003):** The presence of a workspace `.env` is treated as a deliberate statement of the checkout's intended runtime state. By default, the project file *wins* over the inherited environment.
3.  **Fail-Closed for Credentials (US1/#119):** An empty string in a project file should not blindly overwrite and destroy a working ambient credential.

To accomplish this, `migration/guildctl/env.ts` implements a **snapshot-then-apply** algorithm instead of relying on `dotenv`'s internal mutation logic.

## 2. Snapshot-Then-Apply Flow

The entire precedence and apply logic occurs inside `loadGuildEnvironment` (`migration/guildctl/env.ts:loadGuildEnvironment`).

### Step 1: Snapshot the Ambient Environment
Before reading any files, the system captures `process.env` (or a provided snapshot) as the comparison basis.

```typescript
// migration/guildctl/env.ts:loadGuildEnvironment
const ambient: NodeJS.ProcessEnv = { ...(options.ambient ?? target) };
```

It also determines the precedence mode ("project" or "ambient") by checking for the `--ambient-env` flag or the `GUILD_ENV_PRECEDENCE=ambient` variable (`resolveEnvPrecedenceMode`).

### Step 2: Parse Candidates
The logic parses the workspace `.env` (which describes this specific checkout) and applies fallback install candidates. The install candidates provide backwards compatibility for earlier CLI layouts but do *not* participate in divergence reporting.

```typescript
// migration/guildctl/env.ts:loadGuildEnvironment
const workspaceEnvPath = path.resolve(cwd, ".env");
const project = fs.existsSync(workspaceEnvPath) ? parseCandidate(workspaceEnvPath) : {};
```

### Step 3: Compute Divergences
Crucially, *before* applying any values, the subsystem compares the project file's keys against the ambient snapshot. If the file and the environment disagree, a `EnvDivergence` is recorded.

```typescript
// migration/guildctl/env.ts:loadGuildEnvironment
for (const [variable, projectValue] of Object.entries(project)) {
  const ambientValue = ambient[variable];
  if (ambientValue === undefined || ambientValue === projectValue) continue;
  // ... divergence identified
```

If a variable name suggests it carries a secret (checked using `isSensitiveEnvName` from `migration/guildctl/util.ts`), the literal values are swapped out for `<redacted>`.

### Step 4: Apply and "Fail-Closed" (Constitution VI)
When deciding which value actually makes it into the final `target` (usually `process.env`), the subsystem checks for a dangerous edge case: an empty credential in the project file overriding a working credential in the shell.

```typescript
// migration/guildctl/env.ts:loadGuildEnvironment
const fileWins = value !== "" && (ambientValue === undefined || (mode === "project" && key in project));
if (fileWins) {
  target[key] = value;
  origin[key] = "project-file";
} else {
  target[key] = ambientValue;
  origin[key] = "ambient";
}
```
If the `.env` value is explicitly an empty string (`""`) but the ambient shell holds a working value, the ambient value wins regardless of the precedence mode. This fail-closed rule prevents the operator from silently discarding credentials into a 401 Unauthorized failure.

## 3. Reporting Divergences

While `env.ts` computes the divergence, it explicitly avoids printing anything. This prevents spamming the output if the module is loaded multiple times.

Instead, reporting is deferred to `migration/guildctl/runtime-report.ts`. When an autonomous phase begins, it calls `resolveAndReportRuntime`. This function retrieves the cached load result (`lastEnvLoad`) and renders the run-start block via `renderRuntimeReport`.

```typescript
// migration/guildctl/runtime-report.ts:renderEnvDivergences
return [
  `${RUNTIME_LINE_PREFIX} environment: ${divergences.length} divergence(s) between .env and the inherited environment`,
  ...divergences.map((divergence, index) =>
    `  ${divergence.variable.padEnd(nameWidth)}  ${projectCells[index].padEnd(projectWidth)}  `
    + `${ambientCells[index].padEnd(ambientWidth)}  → ${divergence.winner === "ambient" ? "ambient" : ".env"} wins`),
];
```

Because `isSensitiveEnvName` already replaced secrets with `<redacted>` during the snapshot phase, the reporting logic has no way to accidentally leak credentials.

## 4. Invariants and Constraints

- **No Overwrite Mutations:** The algorithm never overwrites the ambient dictionary directly while computing; it builds a separate origin map (`EnvOriginMap`) and apply-list to ensure a clean source of truth for divergences.
- **Single Secret Definition:** `isSensitiveEnvName` (`migration/guildctl/util.ts`) is the single source of truth for what constitutes a secret across the entire CLI surface (evidence logs, preflight checks, and environment reporting).
- **One Report Per Run:** The environment divergences are reported exactly once at phase startup by `resolveAndReportRuntime`, not on module load.