# Characterization Fixtures

## Purpose and Overview

The **Characterization Fixtures** subsystem is a mechanism for capturing the concrete input and output of legacy code execution (via "seams") and using it as a baseline for deterministic structural regression testing during modernization. Its purpose is to guarantee that as legacy artifacts are migrated to modern equivalents, their observable behavior remains identical to the original implementation.

Unlike traditional unit tests that assert specific logical conditions, characterization fixtures are purely observational: they run a known-good legacy process, snapshot its exact output, and strictly require the modernized process to emit identical output when provided the same input. This enforces structural integrity across language or framework migrations.

## Architecture

The characterization fixtures pipeline is built on three core phases spanning capture, storage, and evaluation:

1. **Capture (`runCaptureFixture`)**: Executes a legacy seam command in the workspace and extracts its output.
2. **Storage (`writeFixtureFile` & DB Registration)**: Persists the captured output to disk alongside a content hash, and records its metadata in the registry database as `characterization-fixture` evidence.
3. **Comparison (`compareToFixture`)**: Evaluates a modernized candidate's output against the captured baseline during the `migrate` phase.
4. **Integrity (`checkEvidenceFreshness`)**: Ensures the stored fixture file has not been tampered with or become stale relative to the registry state.

## Step-by-Step Flow

### 1. Capture Legacy Seam Execution
The process is initiated via `runCaptureFixture` in `migration/guildctl/commands/capture-fixture.ts:32`.
- A shell command representing the test seam is executed via `execAsync` within the workspace root.
- The command's standard output (`stdout`) is collected.
- The subsystem attempts to parse the output as JSON: `output = JSON.parse(stdout.trim())`.
- If the output is not valid JSON, the system safely catches the error and falls back to using the raw, trimmed standard output string: `output = stdout.trim()`. This ensures seams emitting plain text or custom formats are not rejected as failures.

### 2. Storage and Registration
Once the output is captured, it must be persisted immutably:
- `writeFixtureFile` (`migration/registry/commands/fixture-file.ts:25`) creates a uniquely named JSON file containing the seam identifier, the captured output, and a cryptographic digest.
- The digest is generated using `sha256Json` (`migration/registry/commands/fixture-file.ts:11`), which computes a SHA-256 hash of the JSON stringified value.
- The metadata is then registered in the SQLite database via `addCharacterizationFixtureEvidence` (`migration/registry/commands/evidence.ts:233`), which stores it as an `AcceptanceEvidence` entry with the specific `evidence_type: 'characterization-fixture'`. The `content_sha256` column binds the file's hash to the immutable registry record.

### 3. Comparison During Migration
During the `migrate` phase, modernized candidates are evaluated using `compareToFixture` (`migration/registry/commands/evidence.ts:271`):
- The function retrieves the latest passing characterization fixture for the given artifact from the registry.
- It loads the corresponding fixture file from disk using `readFixtureFile`.
- The evaluation strictly enforces structural equality by stringifying both the baseline and the candidate output: `const match = JSON.stringify(fixture.output) === JSON.stringify(candidateOutput);`.
- If the outputs match exactly, the comparison passes (`{ match: true }`). If they diverge, a detailed diff string is generated indicating the discrepancy.

### 4. Integrity and Freshness Validation
Before arbitration or approval, `checkEvidenceFreshness` (`migration/registry/commands/evidence.ts:795`) validates the integrity of the fixture evidence:
- It locates the artifact's latest characterization fixture.
- It parses the current fixture file from disk and recalculates its hash.
- The hash is compared against the database's recorded `content_sha256` using `safeEqual(sha256Json(fixture.output), latestFixture.content_sha256)`. If they do not match, the evidence is considered stale or tampered with, and approval is blocked.

## Invariants and Edge Cases

- **Fail-Open on Capture Failure**: If the legacy seam command fails to execute or returns a non-zero exit code (caught in the try-catch block of `execAsync`), `runCaptureFixture` intercepts the error and returns `{ captured: false, ... }` instead of fabricating a failed fixture. Seams requiring live runtimes that fail here are treated as expected legacy behavior, not pipeline crashes.
- **Resilience to Non-Parsable Output**: The fallback mechanism (`catch { output = stdout.trim(); }`) in `runCaptureFixture` guarantees that unparsable `stdout` is still captured as a valid baseline.
- **Fail-Closed on Missing Baselines**: In `compareToFixture`, if an artifact lacks a valid characterization fixture in the database or on disk, the system explicitly throws a `RegistryError` (`No characterization-fixture evidence found for artifact...`). This allows callers to safely distinguish a "missing target" exception from a legitimate comparison mismatch.

## Gotchas and Extension Points

- **Stringify Ordering Gotcha**: Because `compareToFixture` relies on `JSON.stringify(fixture.output) === JSON.stringify(candidateOutput)`, modernized implementations must return object keys in the exact same order as the legacy system, as `JSON.stringify` is key-order sensitive.
- **Extending Seams**: Operators can define completely arbitrary commands for the `seam` argument. As long as the command prints deterministic output to `stdout`, it can act as a valid structural regression baseline without modifying the core pipeline code.
