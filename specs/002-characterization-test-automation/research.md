# Phase 0 Research: Characterization Test Automation

No `[NEEDS CLARIFICATION]` markers remained in the Technical Context — the codebase already
supplies a close structural precedent (`runtime` evidence + `guildctl verify`) for every open
design question. This document records the decisions made by following that precedent, and the
alternatives considered.

## Decision 1: New CLI command vs. extending `evidence add`

**Decision**: Add a new top-level `guildctl capture-fixture` (or `guildctl evidence capture` —
exact name finalized in Phase 1 contract, not a research blocker) command, modeled on
`guildctl verify`, rather than extending `guildctl evidence add --type characterization-fixture`.

**Rationale**: `evidence add` (`migration/guildctl/commands/evidence.ts`) records evidence an
external caller already produced and is asserting — it takes `--pass`/`--fail` and a summary
as input, trusting the caller. A characterization fixture is produced *by executing something
the command itself runs* (the legacy test seam) — the same shape as `runtime` evidence, which
is deliberately excluded from `VALID_EVIDENCE_TYPES` (the `evidence add` allowlist) and instead
has its own dedicated command (`guildctl verify`) that runs the check and records the result
itself, with `addAcceptanceEvidence()` explicitly rejecting a caller-asserted `"runtime"` type
(`migration/registry/commands/evidence.ts`: `if (opts.evidenceType === "runtime") throw ...`).
Characterization-fixture evidence must follow that same rule: it is captured by a command that
runs the seam, not asserted by `evidence add`.

**Alternatives considered**:
- *Extend `evidence add` with a new type*: rejected — would let a caller assert a fixture
  happened without the system having actually executed anything, breaking Evidence Over
  Assertion (constitution Principle I) the same way letting a caller assert `runtime` evidence
  would.
- *Fold into `guildctl verify` itself as a new flag*: rejected — `verify` is scoped to
  verifying *migrated* output already exists; fixture capture targets *legacy* code before
  migration happens (Inventory/Plan phase, per the spec), a different lifecycle point with a
  different input (a legacy test seam, not a migrated artifact's own verification command).
  Keeping it a separate command matches the spec's phase framing and avoids overloading
  `verify`'s option surface with legacy-vs-migrated branching.

## Decision 2: Where the fixture payload (seam, input, output) lives

**Decision**: Full captured input/output data is written to a JSON file under
`.guild/evidence/characterization/` (parallel to `.guild/evidence/runtime/` used by
`guildctl verify`), referenced by the evidence row's `output_path`; the evidence row itself
carries `command` (the seam invocation), `content_sha256` (hash of the captured output, per
FR-004), `pass`/`exit_code` (whether the seam ran cleanly), and a short `output_excerpt` for at-
a-glance inspection — the same fields every other evidence type already uses. No new database
column or table.

**Rationale**: `AcceptanceEvidence` already has exactly these fields (`migration/registry/types.ts`);
reusing them means no DB schema change beyond widening the `EvidenceType` union, consistent
with the spec's Assumption that this is "a small, mechanical change ... not a schema redesign."
`runtime` evidence already writes its full log to `output_dir`/`runtime` and stores a path
reference — characterization-fixture follows the identical pattern with its own subdirectory so
fixture files are easy to locate and don't collide with runtime logs.

**Alternatives considered**:
- *New `characterization_fixtures` table with structured seam/input/output columns*: rejected
  as unnecessary schema surgery beyond what the spec calls for; the existing evidence row plus
  a referenced JSON file already carries everything FR-004 requires (seam, input, output,
  content hash), and a bespoke table would need its own freshness logic instead of reusing
  `checkEvidenceFreshness()` (violates FR-009's "no second freshness mechanism").

## Decision 3: How Migrate consumes the fixture for comparison (Story 2 / FR-006)

**Decision**: A library function (e.g. `compareToFixture(db, artifactId, candidateOutput)` in
`migration/registry/commands/evidence.ts`, alongside the other evidence helpers) reads the
latest `characterization-fixture` evidence row for an artifact, loads its referenced fixture
file, and returns a `{ match: true }` or `{ match: false, diff: ... }` result. This is a plain
library function callable both by the Migrate-phase agent tooling and, if useful, by a thin CLI
wrapper — not a new registry table or event type.

**Rationale**: Every other cross-phase evidence read in this codebase (e.g. arbitration reading
runtime evidence) goes through `registry/commands/evidence.ts` functions operating on the
existing `acceptance_evidence` rows, not through a bespoke IPC or file-watch mechanism. Reusing
that shape keeps Migrate-phase consumption consistent with how Arbiter-phase consumption
already works (Decision 4), and keeps "compare candidate to fixture" as pure, testable logic
independent of any particular caller.

**Alternatives considered**:
- *Have Migrate re-run the legacy seam itself for comparison*: rejected — re-running legacy
  code from the Migrate phase duplicates Decision-1's capture logic and risks the Migrate phase
  needing legacy-runtime access it shouldn't have; capturing once (Inventory/Plan) and
  comparing against the stored snapshot (Migrate) matches the spec's "behavioral snapshot"
  framing and the read-only boundary in constitution Principle II.

## Decision 4: How Arbiter evidence gating picks up fixture comparisons (Story 3 / FR-008, FR-009)

**Decision**: When a characterization-fixture comparison is run (via Decision 3's
`compareToFixture`), its `match`/`diff` result is recorded as its own evidence row — reusing
the *same* `characterization-fixture` evidence type, with `pass` set from the comparison result
— rather than inventing a second evidence type for "comparison result" as distinct from
"captured fixture." `checkEvidenceFreshness()` already operates generically over evidence rows
by `evidence_type` and `content_sha256`/timestamp, so no changes to that function are needed —
only the `EXECUTABLE_EVIDENCE_TYPES` and type-union extension from Decision 1/2 are required for
it to cover the new type.

**Rationale**: The spec (FR-009) explicitly forbids a second, different freshness mechanism.
Treating "captured fixture" and "comparison result" as the same evidence type — the second
comparison record with `pass=0/1` reflecting outcome — means `checkEvidenceFreshness()`'s
existing content-hash/same-run logic applies unchanged, and the Arbiter's existing evidence-
reading code path needs no new branch beyond recognizing the new type string, matching FR-008's
"same terms as other evidence types."

**Alternatives considered**:
- *Separate `fixture-comparison` evidence type*: rejected — doubles the surface area touched
  (two new type-union members instead of one) for no behavioral gain, and risks the two types
  drifting in how they interact with freshness, which is exactly what FR-009 rules out.

## Decision 5: Test seam discovery ("already-tested seams only", FR-002/FR-005)

**Decision**: Fixture capture takes an explicit seam identifier (a test command/target,
analogous to how `guildctl verify --command` takes explicit commands rather than
auto-discovering them) supplied by the operator or by a Plan/Inventory-phase step that already
knows which tests exist for an artifact. Capture does not attempt to auto-discover "does this
artifact have a runnable unit test" — that determination is made by the caller, consistent with
how `verify` defaults to `npm test` but lets the caller override, and with the spec's framing
that capture targets seams that are "already-tested" (i.e., known in advance), not seams the
system must go hunting for.

**Rationale**: Auto-discovery of runnable-without-runtime test seams across arbitrary legacy
stacks is exactly the kind of stack-specific knowledge constitution Principle VII assigns to
stack packs, not core runtime code — building a bespoke discovery heuristic here would violate
that boundary and expand scope well beyond the "first slice" the spec commits to. Explicit
seam input keeps the feature's first slice mechanical and stack-neutral.

**Alternatives considered**:
- *Auto-detect test seams per stack pack*: deferred, not rejected outright — flagged as a
  natural extension for a later slice once this mechanism exists, but out of scope per the
  spec's Assumptions (first slice excludes runtime-dependent capture and, by the same
  reasoning, excludes automatic seam discovery).
