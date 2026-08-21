# Migration Drift Evidence Signature

The migration drift evidence signature is a specialized mechanism for detecting, cryptographically committing to, and verifying the structural API drift between a legacy source file and its modernized counterpart. Rather than relying on simple line-diffs or exact byte equivalence, it computes an AST-less semantic hash of public and protected members (methods, fields, constructors) to explicitly gate high-risk regressions while securely binding the resulting evidence to the exact file contents to prevent tampering during the review and approval flows.

This document traces the end-to-end lifecycle of the signature: how it is extracted, how the drift is computed, and how the registry guarantees evidence freshness.

## Architecture & Responsibilities

The mechanism spans the runtime pipeline and the registry:

1. **Extraction and Digest (`migration/guildctl/signature.ts`)**: Parses source code to isolate signatures, normalize them, and produce a canonical SHA-256 hash representing the structural API surface.
2. **The Drift Gate (`migration/guildctl/supervisor/loop.ts`)**: Runs `diffSignatures` during the supervisor loop. It acts as an automated gate, rejecting high-risk drift and producing a `static-check` evidence record containing the structural diff (`signature_json`) and the actual byte hash (`content_sha256`) of the proposed artifact.
3. **Evidence Freshness Binding (`migration/registry/commands/evidence.ts`)**: The registry consumes the `static-check` evidence, ensuring that any human or automated approval evaluates the exact bytes that the drift gate evaluated.

## Step-by-Step Flow

### 1. Signature Extraction and Normalization

When an artifact is evaluated, `migration/guildctl/signature.ts` performs a language-aware (Java or Python) extraction of its structural members.

*   **Extraction**: Using robust regular expressions (`extractJavaSignatures` / `extractPythonSignatures`), it strips annotations and generics and identifies methods, fields, and constructors. This AST-less approach ensures extraction is highly resilient to incomplete or structurally broken code, which is common in mid-migration states.
*   **Normalization**: It normalizes visibility modifiers, method names, and parameters into a consistent string format (e.g., `public method String getName()`).
*   **Digest Generation**: `signatureDigest` sorts the normalized members alphabetically, concatenates them into a single canonical string, and computes a SHA-256 digest. This `SignatureDigest` represents the pure structural surface of the file.

### 2. Drift Computation and the Drift Gate

In the autonomous supervisor loop (`migration/guildctl/supervisor/loop.ts:computeDriftGate`), the legacy source file and the modernized output file are both parsed into `SignatureDigest`s.

`diffSignatures` compares the two digests to detect structural changes (`SignatureDelta`s), such as:
*   `method-added`
*   `public-method-removed`
*   `visibility-narrowed`
*   `field-became-final`

The supervisor evaluates these deltas against a defined set of `highRiskDriftKinds`. If any high-risk changes are detected (e.g., a public method was removed or narrowed), the artifact is immediately marked as `blocked`, terminating the proposal before it can reach review.

### 3. Committing the Static-Check Evidence

If the drift gate passes, it records an `AcceptanceEvidence` row of type `static-check` to the registry via `addAcceptanceEvidence`. This row commits to two crucial pieces of information:

1.  **`signature_json`**: The serialized JSON representation of the `SignatureDiff` (containing the exact deltas detected).
2.  **`content_sha256`**: The exact byte-for-byte SHA-256 hash of the modern file on disk at the exact moment the drift gate passed (`contentSha256(modernBytes)`).

```typescript
// migration/guildctl/supervisor/loop.ts
addAcceptanceEvidence(input.db, {
  artifactId: input.legacyArtifactId,
  // ...
  evidenceType: "static-check",
  pass: 1,
  outputPath: modernPath,
  contentSha256: primaryContentSha256,
  signatureJson,
});
```

By storing both the logical drift (`signature_json`) and the physical file hash (`content_sha256`), the registry creates an immutable, cryptographically verifiable link between the structural assessment and the exact file contents.

### 4. Registry Enforcement: Evidence Freshness

The actual consumption of this signature occurs during the registry's approval flows (e.g., `approveArtifactWithEvidence` and `recordApprovalDecision` in `migration/registry/commands/approval.ts`). Before any decision is recorded, the registry calls `checkEvidenceFreshness` (`migration/registry/commands/evidence.ts`).

`checkEvidenceFreshness` ensures the evidence is not stale:
1.  **Retrieval**: It fetches the latest passing `static-check` evidence row.
2.  **Run Binding**: It enforces that the `static-check` evidence and the `runtime` evidence belong to the exact same run (`latestStatic.run_id === latestEvidence.run_id`).
3.  **Physical Integrity Re-verification**: It reads the actual file from disk (`sha256File(latestStatic.output_path)`) and compares its hash against the stored `content_sha256`.

```typescript
// migration/registry/commands/evidence.ts
if (!safeEqual(sha256File(latestStatic.output_path), latestStatic.content_sha256)) {
  return { ok: false, reason: "Stale evidence: output content changed after the static-check gate" };
}
```

If the file has been modified by *any* agent or operator after the drift gate ran, the byte hash will mis-match the `content_sha256` bound in the signature. The registry will reject the approval with a "Stale evidence" error, forcing the artifact to be re-evaluated and re-gated.

*(Note: While `static-check` binds via `content_sha256`, `runtime` evidence utilizes a similar mechanism by hashing the log output (`log_sha256`) and cryptographically signing the result with an operator token HMAC via `signRuntimeEvidence` in `migration/guildctl/verify.ts` and `validateRuntimeEvidence`).*

## Invariants and Edge Cases

*   **Extraction over Execution**: The AST-less regex extraction intentionally prioritizes resilience over perfect semantic understanding, ensuring the drift gate can evaluate broken syntax during iterative development.
*   **Byte-Level Verification, Not Member-Level**: The registry's freshness check validates the literal bytes of the file against `content_sha256`, not the structural `signature_json`. The structure determines *if* it passes the gate; the bytes guarantee *what* was passed.
*   **Strict Run Coupling**: A valid verification requires the structural check (`static-check`) and the execution check (`runtime`) to originate from the identical run. Mixing a static check from an old run with runtime tests from a new run is explicitly rejected.

## Gotchas

*   **Diffing Signatures Only Detects Supported Deltas**: The `diffSignatures` function only identifies explicit delta kinds (e.g., `public-method-removed`). Changes that do not trigger a delta (e.g., changing a method's implementation logic without altering its signature) do not generate drift records and are invisible to the structural gate.
*   **Stale Evidence Blocks the CLI**: If an operator manually modifies a file after an automated agent finishes, but before running `guildctl approve`, the approval will fail. The operator must either revert the manual edit or re-run the verification pipeline to generate fresh `static-check` and `runtime` evidence matching the new bytes.

## Extension Points

*   `migration/guildctl/signature.ts`: Additional languages or delta kinds (e.g., tracking interface implementation drift or annotation changes) can be added to the extraction and diffing logic.
*   `computeDriftGate` (`migration/guildctl/supervisor/loop.ts`): The definition of `highRiskDriftKinds` could be made configurable per-workspace to loosen or tighten the automated enforcement of structural drift.
