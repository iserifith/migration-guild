# Characterization Fixtures and Seams Deep-Dive

## Purpose and Overview

In the migration lifecycle, ensuring that a modernized component behaves exactly like its legacy counterpart is critical. The **Characterization Fixtures** subsystem achieves this by executing an already-passing unit or invocation-level "seam" in the legacy codebase, capturing its concrete input and output, and pinning it as immutable evidence.

By pinning the exact runtime behavior (stdout/JSON output) before the migration begins, the pipeline establishes a strict comparative baseline. When the AI planner proposes and implements a modernized replacement, the verification phase runs the new implementation and compares its output against this captured fixture.

## Architecture

The Characterization Fixture subsystem spans three main components:
1. **The CLI Runner (`migration/guildctl/commands/capture-fixture.ts`)**: Executes the legacy seam in the host environment, captures its output, and handles fallback logic.
2. **The Fixture Storage (`migration/registry/commands/fixture-file.ts`)**: Handles the actual disk writing and cryptographic hashing of the captured data.
3. **The Evidence Layer (`migration/registry/commands/evidence.ts`)**: Registers the fixture as an immutable `characterization-fixture` row in the SQLite database and provides the comparison logic used by later verification gates.

## Step-by-Step Flow

### 1. Seam Execution
The process begins in `runCaptureFixture` (within `migration/guildctl/commands/capture-fixture.ts`). It uses `execAsync` to run the provided seam command in the legacy workspace root.

**Invariant - No Fabrication on Failure (FR-005):** If the seam command fails (returns a non-zero exit code), the runner catches the error and returns a `captured: false` result containing the reason. It explicitly *skips* recording any evidence rather than fabricating a failed fixture. A seam that needs a live runtime to succeed is expected to fail in some environments and is not treated as a fatal error for the overall capture run.

### 2. Output Parsing
If the command succeeds, it captures the `stdout`. The orchestrator attempts to parse this standard output as JSON.
- **Fallback Mechanism:** Not all legacy seams are structured to emit clean JSON. If `JSON.parse` fails, the system falls back to treating the raw, trimmed `stdout` string as the captured output instead of throwing a parsing failure.

### 3. Disk Serialization
Once the output is resolved, it is passed to `writeFixtureFile` (`migration/registry/commands/fixture-file.ts`).
- This function writes the output to a `.json` file inside the `characterization` evidence directory (e.g., `${cfg.evidence.output_dir}/characterization`).
- It generates a fresh, random ID for the file name.
- It computes a SHA-256 hash of the JSON-stringified output using `sha256Json`. This hash (`contentSha256`) is returned alongside the file path.

### 4. Evidence Registration
The runner then calls `addCharacterizationFixtureEvidence` (`migration/registry/commands/evidence.ts`).
- It creates an `acceptance_evidence` row in the database associated with the given `artifactId`.
- The row is strictly typed as `characterization-fixture` and its `producedBy` field defaults to `guildctl-capture-fixture`.
- The row records the exit code (0), the `outputPath`, an excerpt of the raw output (up to 4000 characters), and the cryptographic `contentSha256` hash computed in the previous step.

### 5. The Comparison Flow
During the verification of a modernized artifact, the pipeline must compare the new output against the legacy baseline. This is handled by `compareToFixture` in `migration/registry/commands/evidence.ts`.

1. **Resolution:** It calls `getLatestCharacterizationFixture` to fetch the most recent passing `characterization-fixture` evidence for the `artifactId` (ordered by `created_at DESC`).
2. **Missing Fixture (FR-007):** If no fixture exists for the artifact, it throws a `RegistryError` with code `2`. This distinct error code allows the caller to distinguish a "no target to compare against" state (which is non-blocking) from an actual mismatch.
3. **Comparison:** If a fixture is found, it reads the JSON payload from disk (`readFixtureFile`). It then performs a strict JSON-stringified comparison between the `fixture.output` and the `candidateOutput`.
4. **Result:** It returns a `FixtureComparisonResult`: either `{ match: true }` or `{ match: false, diff: string }` where the diff describes the JSON deviation.

## Invariants and Edge Cases

- **Tool-Owned Evidence Type:** The `characterization-fixture` evidence type is strictly "tool-owned". It can only be inserted by the system (via the `guildctl capture-fixture` process) and cannot be manually spoofed or overridden by an agent.
- **Content Integrity:** The cryptographic hash (`contentSha256`) ensures that if a fixture file on disk is tampered with between the capture phase and the verification phase, the evidence row will no longer match the file's hash, invalidating the baseline.
- **Non-blocking Missing Targets:** The comparison logic explicitly treats a missing fixture as a structural error (Code 2) rather than a boolean mismatch, preventing the pipeline from falsely failing a modernized component just because the legacy baseline was never capturable.

## Extension Points

- **Custom Seam Interpreters:** If a legacy framework uses a different output channel (like writing to a specific file instead of `stdout`), `runCaptureFixture` could be extended to read from a designated output file path provided in `opts` instead of parsing `stdout`.