# Contract: `compareToFixture()` (library function)

New function in `migration/registry/commands/evidence.ts`, alongside the other evidence
helpers (`addAcceptanceEvidence`, `checkEvidenceFreshness`, etc.). Consumed by the Migrate
phase (Story 2 / FR-006) and by whatever records the Arbiter-facing comparison evidence row
(Story 3 / FR-008, research Decision 4).

## Signature

```ts
export function compareToFixture(
  db: Database.Database,
  artifactId: string,
  candidateOutput: unknown,
): { match: true } | { match: false; diff: string };
```

## Behavior

1. Looks up the latest `characterization-fixture` evidence row for `artifactId` (reuses the
   same "latest executable evidence for artifact" query pattern `checkEvidenceFreshness()`
   already uses for `runtime`/`static-check`).
2. If none exists, throws a typed `RegistryError` (analogous to `RegistryError(2, "Artifact not
   found")`) distinguishing "no fixture captured" from "fixture didn't match" — callers (Migrate
   phase) must handle "no fixture" as non-blocking per FR-007, not as a comparison failure.
3. Loads the fixture file at the row's `output_path`.
4. Compares `candidateOutput` to the fixture's recorded `output` using a structural equality
   check (deep-equal on the serialized value). Exact comparison semantics (e.g. how floating
   point or ordering-insensitive collections are handled) are an implementation detail deferred
   to `/speckit-tasks`, not a contract-level decision — this contract only fixes the input/output
   shape.
5. Returns `{ match: true }` on equality, or `{ match: false, diff }` with a human-readable
   description of the first/primary difference on mismatch.

## Callers and what they do with the result

- **Migrate phase (Story 2)**: calls this after producing candidate output, to check
  against the recorded behavioral target. On `match: false`, surfaces `diff` to the agent as
  actionable feedback. On "no fixture" error, proceeds using existing forward-written-test
  behavior (FR-007) — this is not an error condition for Migrate.
- **Comparison-evidence recorder (Story 3)**: after Migrate's own verification step normally
  run before arbitration, calls `compareToFixture()` (if a fixture exists) and records a new
  `characterization-fixture` evidence row with `pass` set from `match` (research Decision 4),
  so the Arbiter sees the result without re-deriving it.

## Non-goals

- Does not itself write any evidence row — it is a pure read/compare function. Recording the
  comparison result as evidence is the caller's responsibility (keeps the function testable in
  isolation, per constitution Principle V).
- Does not decide approve/reject — that remains the Arbiter's exclusive authority
  (constitution Principle IV); this function only supplies one input to that decision.
