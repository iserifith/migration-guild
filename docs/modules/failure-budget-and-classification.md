# Failure Budget and Classification

## Purpose and Overview

The autonomous migration loop involves autonomous LLM agents that are inherently unpredictable. They can fail due to timeouts, generate malformed output, or introduce syntax and test errors. If the supervisor simply retried every failed run indefinitely, it would rapidly exhaust token limits and API budgets.

The Failure Budget and Classification subsystem provides a structured way to identify *why* a failure occurred, and enforce limits on how many times an artifact—and specifically a certain type of failure on that artifact—can be retried.

This mechanism ensures the pipeline halts predictably on stubborn artifacts rather than entering endless remediation loops, and enables clean resumption if the supervisor process is interrupted.

## Architecture and Core Components

The logic spans two primary layers:

1. **Failure Classification (`migration/guildctl/supervisor/failures.ts`)**: Responsible for parsing arbitrary unstructured stdout/stderr from failed executions and distilling it into a standardized `FailureKind` and an anonymized failure signature.
2. **Failure Budget (`migration/guildctl/supervisor/failures.ts` / `migration/registry/commands/attempts.ts`)**: An accounting mechanism that tracks attempts at the artifact level and tracks specific failure signatures. Crucially, it seeds its state from the durable SQLite registry so that restart events do not grant an artifact fresh budget.

## Step-by-Step Flow

### 1. Classification (`classifyFailure`)

When a process exits non-zero or hits a limit, its output (stdout + stderr) is passed into `classifyFailure(input: FailureInput)` (`migration/guildctl/supervisor/failures.ts:39`).

The first step is signature normalization via `normalizeFailureSignature` (`migration/guildctl/supervisor/failures.ts:25`). This strips out volatile, run-specific details from the logs:
- Absolute paths are replaced with `<path>`
- Hex identifiers/UUIDs (12+ characters) are replaced with `<id>`
- Specific numeric digits are replaced with `<n>`
- Whitespace is compacted

After normalization, `classifyFailure` evaluates a series of regex rules against the text to assign a `FailureKind` (`migration/guildctl/supervisor/failures.ts:42-50`). For example:
- Matches on `timeout|inactivity|ceiling` yield `agent-timeout`
- Matches on `tsc|javac|gradle` or `compilation failed` yield `build-failure`
- Matches on `assertionerror` or `tests failed` yield `test-failure`

The output is a `ClassifiedFailure` containing the phase, the generalized `FailureKind`, and a unique `signature` structured as `${kind}:${normalized}`. This signature allows the system to recognize when the autonomous worker is stuck repeating the exact same mistake.

### 2. Failure Budget Mechanics (`FailureBudget`)

The `FailureBudget` class tracks two primary constraints:
- `attempts`: The total number of retries for an artifact.
- `playbooks`: The number of times a specific failure signature has been remediated.

When the supervisor considers retrying an artifact, it checks `canAttemptArtifact` and `canRunPlaybook`. If the artifact has hit its `maxAttemptsPerArtifact` (default 3), or if the *exact same* failure signature has already triggered a playbook dispatch up to `maxPlaybookPerSignature` times (default 2), the supervisor halts the queue for that artifact instead of continuing.

### 3. Durable State Seeding

Because `guildctl` is a command-line operator that can be stopped and started, a purely in-memory `FailureBudget` would reset whenever the process restarts, leading to infinite retry loops across process executions.

To prevent this, `FailureBudget` takes an optional `FailureBudgetSeed` parameter in its constructor (`migration/guildctl/supervisor/failures.ts:60`). This seed is derived directly from the registry via `getPersistedBudgetState` (`migration/registry/commands/attempts.ts:109`).

`getPersistedBudgetState` queries the `attempt_records` SQLite table:
1. It counts the total rows for the `artifact_id` to establish `attemptsUsed`.
2. It groups by `failure_signature` to establish `playbookSignatureCounts`.

The `FailureBudget` constructor reads this seed:
```typescript
// migration/guildctl/supervisor/failures.ts:79
if (seed) {
  if (seed.attemptsUsed > 0) {
    this.attempts.set(seed.artifactId, seed.attemptsUsed);
  }
  for (const [signature, count] of Object.entries(seed.playbookSignatureCounts)) {
    if (count > 0) {
      this.playbooks.set(`${seed.artifactId}:${signature}:repair`, count);
    }
  }
}
```
This guarantees that a restarted supervisor resumes consumed attempts exactly where it left off, avoiding double-counting or resetting budgets.

## Invariants and Edge Cases

- **Anonymization Invariant:** The failure signature *must* reliably strip highly variable noise (like temp directory hashes) so that identical conceptual errors map to the exact same string signature; otherwise, the per-signature budget will never trigger.
- **Append-Only History:** `recordAttemptOutcome` (`migration/registry/commands/attempts.ts:63`) performs an `INSERT` rather than an `UPDATE`. `(artifactId, attemptNo)` collisions deliberately throw a `RegistryError`, strictly enforcing the history model.
- **Success Semantics:** If an attempt's outcome is `succeeded`, `failureKind` *must* be null. If it is `failed`, `failureKind` *must* be provided (`migration/registry/commands/attempts.ts:65`).

## Gotchas

- When extending the `classifyFailure` rules, be aware that the regex tests the *normalized* text, not the raw output. You cannot regex against a file path like `/var/temp/...` because it has already been stripped to `<path>`.
- The `playbooks` map in `FailureBudget` appends `:repair` to the internal storage key (`${artifactId}:${signature}:repair`). Do not assume the key matches the signature directly when inspecting the instance.
