# Characterization Fixtures

## Purpose and Overview

The **Characterization Fixtures** subsystem provides a safe, deterministic way to evaluate the behavior of modernized implementations by comparing their output against the verified output of the legacy code. It accomplishes this without fabricating or simulating data—instead, it actually runs a legacy seam (like a unit test or invocation point), captures the exact inputs and outputs, hashes them for integrity, and stores them in the registry as an immutable baseline.

During the `Migrate` phase, the modern artifact's output is evaluated against this recorded fixture. If the modernized output strictly matches the legacy output using exact JSON comparison, it serves as powerful evidence that the migration successfully preserved the target behavior.

## The Capture Flow

The entry point for generating a characterization fixture is `runCaptureFixture` (`migration/guildctl/commands/capture-fixture.ts:32`).

### 1. Seam Execution and Fail-Open Philosophy
The subsystem spawns the legacy seam as a child process using Node's `child_process.exec` against the legacy code space (`cwd: opts.workspaceRoot`).

A core design principle here is the **fail-open philosophy**. If the command exits with a non-zero code or throws an error (e.g. because it requires a live, unmockable external runtime), the capture process explicitly skips creating a fixture. It returns `captured: false` with the reason (`capture-fixture.ts:46-52`). This fulfills specification FR-005: "a seam that needs a live runtime is expected to fail here and is not treated as an error for the overall capture run." The system will never fabricate a fake passing fixture.

### 2. Flexible Output Parsing
When the seam executes successfully, `runCaptureFixture` attempts to parse the `stdout` as JSON. Not all legacy seams are structured to output clean JSON. To handle this, it employs a fallback mechanism: if `JSON.parse` throws, it falls back to capturing the raw, trimmed string output directly (`capture-fixture.ts:58-62`).

### 3. File Persistence
The captured output is persisted using `writeFixtureFile` (`migration/registry/commands/fixture-file.ts:31`). This writes a new JSON file into `.guild/evidence/characterization/`.
- It generates a UUID independent of the database's `evidence_id` (`id: \`\${Date.now()}-\${Math.random().toString(16).slice(2, 10)}\``).
- It calculates a `contentSha256` hash of the *output data* itself using `sha256Json` (`fixture-file.ts:16`).

### 4. Registry Row Creation
Finally, a `characterization-fixture` evidence row is appended to the registry via `addCharacterizationFixtureEvidence` (`capture-fixture.ts:74`). This binds the artifact, the command executed, the generated `output_path`, the calculated `contentSha256`, and an excerpt of the raw output into a queryable, persistent claim.

## Storage and Integrity Checks

Because these fixtures are immutable baselines generated against legacy code (often in earlier, disconnected pipeline stages), their integrity must be strictly guarded.

### The Staleness Gate
Before the Arbitration gate will approve an artifact, it checks the freshness and validity of all evidence via `checkEvidenceFreshness` (`migration/registry/commands/evidence.ts:770`).

For characterization fixtures (`evidence.ts:792`), it validates two things:
1. The file at `output_path` must still exist.
2. The current output on disk must perfectly hash-match the originally recorded `content_sha256`.

It does this by reading the fixture file (`readFixtureFile`) and re-hashing the `output` property via `sha256Json(fixture.output)` (`evidence.ts:799`). If they differ, it means the fixture was tampered with after capture, and the evidence is marked stale.

Notably, unlike `static-check` evidence, characterization fixtures are intentionally **exempt** from requiring a matching `run_id` with the current runtime evidence (FR-009). The legacy code was evaluated in the past; only its content hash needs to survive into the modern verification runs.

## Comparison and Evaluation

During the modernization cycle, the evaluation phase uses `compareToFixture` (`migration/registry/commands/evidence.ts:271`) to verify the new candidate output.

### The Strict JSON Contract
The comparison is unforgiving. It loads the latest passing (`pass = 1`) characterization fixture for the artifact and compares it to the new `candidateOutput` using exact `JSON.stringify` matching:
`JSON.stringify(fixture.output) === JSON.stringify(candidateOutput)`

**Gotcha:** `JSON.stringify` equality is highly sensitive to object key ordering. Semantically equivalent JSON objects with different key-insertion orders will fail the comparison and generate a diff.

### Distinguishable Failures
If no fixture was successfully captured for an artifact, `compareToFixture` explicitly throws a `RegistryError` (`evidence.ts:276`). This allows the caller to distinguish "there is no target to compare against" (which is non-blocking according to FR-007) from "the candidate output was compared and mismatched" (which returns `{ match: false, diff: ... }`).

## Extension Points

1. **New Serialization Mechanisms:** The system currently relies on string-based or JSON-parseable seam outputs. Supporting a binary output comparison or an XML output comparison would require adding new hashers to `fixture-file.ts` and branching the equality check in `compareToFixture`.
2. **Multiple Seam Selection:** `compareToFixture` currently just grabs the absolute latest passing fixture for the artifact (`getLatestCharacterizationFixture`). If artifacts gain multiple legacy seams that test different domains, the function signature and DB query would need to be extended to select fixtures by a specific `seam` identifier.
