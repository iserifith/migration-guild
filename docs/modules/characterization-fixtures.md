# Characterization Fixtures

This document details the Characterization Fixtures subsystem in the Migration Guild. This system provides empirical baseline validation for legacy code modernization, acting as a crucial component of the evidence layer. Instead of requiring upfront human specification, it observes the existing behavior of a legacy "seam" and records its outputs to serve as strict regression targets for candidate replacements.

## Overview and Purpose

A Characterization Fixture captures the exact output of a legacy software component under a given set of conditions. These fixtures operate as immutable evidence against which modernized, translated, or refactored code (the "candidate output") is evaluated.

The core principle behind characterization fixtures is that **the runtime database (`registry.db`) is the absolute system of record**, whereas the file system (`.guild/evidence/characterization/`) merely stores the potentially large artifact blobs, tethered to the registry by cryptographic hashes.

The key lifecycle of a fixture includes:
1. **Capture:** Invoking the legacy execution seam.
2. **Storage:** Writing the output to disk and recording an `acceptance_evidence` row in the database.
3. **Comparison:** Using `JSON.stringify` to perform strict equality checks between modernized outputs and the baseline.

## The Capture Phase

The capture lifecycle begins with `runCaptureFixture` located in `migration/guildctl/commands/capture-fixture.ts` (specifically line 35). This function takes a `CaptureFixtureOptions` parameter that defines the specific command, target workspace, and output directories.

### Execution and Failure Modes

The seam execution is managed by standard `node:child_process.exec` (via `promisify`). There are two specific fallback behaviors during capture that ensure robustness across a diverse set of legacy codebases:

1. **Non-Zero Exits Are Expected Failures, Not Exceptions:**
   If the execution fails (returns a non-zero exit code), the process *does not throw*. As per specification FR-005, a seam that fails is simply recorded as a failed capture (returning `{ captured: false, ... }`). This allows the pipeline to tolerate seams that require live environments that may be temporarily unavailable without aborting the broader guild capture loop (`capture-fixture.ts:49-58`).

2. **Tolerating Non-JSON Output:**
   While modern components might emit structured JSON, legacy bash scripts or early-stage seams often emit raw text. `runCaptureFixture` attempts to parse the standard output using `JSON.parse`. If parsing fails, it traps the exception and falls back to preserving the `.trim()` raw stdout string. This ensures that any seam output is capably handled (`capture-fixture.ts:61-67`).

## Storage and Cryptographic Tethering

The storage protocol distinctly splits responsibilities: the JSON file stores the payload, and the database stores the verifiable claim.

### 1. Writing the File Payload

The function `writeFixtureFile` (`migration/registry/commands/fixture-file.ts:24`) handles the file system writing. It creates a payload adhering to the `CharacterizationFixture` interface, which includes the seam name, input, output, timestamp, and a `contentSha256` hash.

The fixture file is written out to `.guild/evidence/characterization/<id>.json` where `<id>` is a pseudo-random identifier composed of a timestamp and UUID (`capture-fixture.ts:71`).

### 2. Recording Evidence

The `writeFixtureFile` function returns the file path and the `contentSha256` hash. This data immediately flows into `addCharacterizationFixtureEvidence` (`migration/registry/commands/evidence.ts:230`).

This function creates an `acceptance_evidence` row in the database with the `evidence_type` explicitly set to `characterization-fixture`. It is critical to note that the `addCharacterizationFixtureEvidence` explicitly sets `producedBy` to `guildctl-capture-fixture`. It captures:
- `outputPath`: The pointer to the on-disk JSON file.
- `outputExcerpt`: The first 4000 characters of stdout.
- `contentSha256`: Crucially, the hash, which provides tamper resistance by ensuring the file hasn't been altered independently of the registry row (`capture-fixture.ts:86`).

## The Comparison Phase

When modernizing an artifact, the new candidate's behavior must be strictly evaluated against the captured baseline. This validation occurs in `compareToFixture` (`migration/registry/commands/evidence.ts:271`).

### Strict Stringification Equality

The comparison evaluates the candidate output against the latest *passing* fixture retrieved via `getLatestCharacterizationFixture` (`evidence.ts:241`). The lookup enforces an `ORDER BY created_at DESC, rowid DESC LIMIT 1` specifically filtering for `evidence_type = 'characterization-fixture'` and `pass = 1`.

The actual comparison is implemented as a strict string equality check on JSON representations:
```typescript
const match = JSON.stringify(fixture.output) === JSON.stringify(candidateOutput);
```
(`evidence.ts:282`)

This implementation dictates that candidate systems must serialize identically to the baseline, maintaining all relevant keys and structural shapes. Any deviation returns `{ match: false, diff: ... }`.

### Absence is Non-Blocking

In accordance with specification FR-007, if `getLatestCharacterizationFixture` returns `null` or if the returned row lacks an `output_path`, the system explicitly throws a `RegistryError` (`evidence.ts:279`). This distinguishes between a mismatched candidate and a candidate that simply has no baseline to compare against. The calling layers handle this explicitly, recognizing the absence of a fixture as non-blocking for certain pipeline phases.

## Summary

The Characterization Fixture subsystem demonstrates the migration guild's philosophy:
- **Registry as Truth:** Files are ephemeral and hash-checked; the SQLite registry row provides authority.
- **Robust Capture:** Raw string fallbacks and non-throwing execution errors allow wide compatibility with messy legacy systems.
- **Strict Verification:** `JSON.stringify` equivalence ensures candidate replacements have no observable regressions in data format or contents.