# Implementation Plan: Characterization Test Automation

**Branch**: `002-characterization-test-automation` | **Date**: 2026-08-14 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-characterization-test-automation/spec.md`

## Summary

Add a `characterization-fixture` evidence type that lets an operator run an already-passing
unit/invocation-level test seam against legacy code and record what it actually produced —
seam, input, output, content hash — as evidence bound to the target artifact. Migrate can then
diff candidate output against that recorded fixture instead of relying only on forward-written
tests, and the Arbiter can see the fixture-comparison result as evidence on the same
approve/reject terms as every other evidence type, gated by the existing freshness contract.

The mechanism mirrors the existing `guildctl verify` command (runs a command, records
verifier-owned evidence) rather than the plain `guildctl evidence add` path (records
externally-produced evidence): a fixture is produced by executing something, not merely
asserted, so it belongs with `runtime` in `EXECUTABLE_EVIDENCE_TYPES`, not with the
externally-supplied types.

## Technical Context

**Language/Version**: TypeScript, targeting the Node.js runtime already used by
`migration/registry` and `migration/guildctl` (see `migration/tsconfig.json` / `package.json`
engines).

**Primary Dependencies**: `better-sqlite3` (registry storage), `commander` (CLI), the existing
internal modules `migration/registry/types.ts`, `migration/registry/commands/evidence.ts`,
`migration/guildctl/commands/evidence.ts`, `migration/guildctl/commands/verify.ts` (structural
precedent), `migration/guildctl/config.ts`. No new external dependencies are introduced.

**Storage**: SQLite via the existing registry (`migration/registry/db`), specifically the
`acceptance_evidence` table already used by all other evidence types. No new table; the fixture
payload (seam, input, output, content hash) is carried in the existing evidence row's
`command`/`output_path`/`output_excerpt`/`content_sha256` fields plus a JSON blob in
`event_data`/an evidence-specific payload field, following the same pattern `runtime` evidence
already uses for its structured payload. The filesystem evidence directory
(`.guild/evidence`, `migration/guildctl/config.ts`) may hold the full captured fixture file
(inputs/outputs), referenced by `output_path`, exactly as other evidence types reference their
full output on disk.

**Testing**: `node --import tsx --test test/*.test.ts` (existing convention;
see `migration/test/evidence-*.test.ts` for the pattern to follow — one test file per new
behavior slice: capture command, evidence-type plumbing, freshness interaction, Migrate-phase
comparison, Arbiter consumption).

**Target Platform**: Same as the rest of `migration/guildctl` — a Node.js CLI run by operators
and orchestration phases against a local or CI workspace; no browser or mobile target.

**Project Type**: Extension to an existing CLI + library monorepo package
(`@migration-guild/registry`), not a new project.

**Performance Goals**: Not a throughput-sensitive path — fixture capture runs at most once per
artifact per operator invocation, on the same order of cost as an existing `guildctl verify`
run (single test-seam execution). No new performance target beyond "doesn't materially slow an
inventory/plan-phase pass over a wave."

**Constraints**: Must not require a live runtime (HTTP server, database) for the seams it
captures — first slice only harvests already-passing unit/invocation-level tests (per spec
Assumptions). Must not weaken or duplicate the existing evidence-freshness contract
(`checkEvidenceFreshness()` in `migration/registry/commands/evidence.ts`) — FR-009.

**Scale/Scope**: Scoped to one new evidence type, its capture command, its consumption point in
Migrate-phase comparison, and its visibility to Arbiter evidence gating. No changes to wave
scheduling, classification, or unrelated phases.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **I. Evidence Over Assertion (NON-NEGOTIABLE)** — PASS. This feature *is* an evidence
  mechanism: a fixture is only real once explicitly recorded via `addAcceptanceEvidence`
  (spec FR-003), never inferred from a file existing on disk. It is content-bound via
  `content_sha256`, matching the existing evidence contract, and reuses
  `checkEvidenceFreshness()` rather than adding a parallel, weaker check (FR-009). No new
  self-report path is introduced.
- **II. Legacy Is Read-Only; `modern/` Is the Only Write Target (NON-NEGOTIABLE)** — PASS.
  Capture executes existing legacy tests read-only against `legacy/` and writes only to
  `.guild/evidence/` and the registry DB — never to `legacy/` or `modern/`. This must be
  verified in design (Phase 1) by confirming the capture command opens no write handle under
  `legacy/`.
  - *Watch item*: if a legacy unit test itself writes temp/output files as a side effect (e.g.
    into a build directory under `legacy/`), that is pre-existing legacy test behavior, not
    behavior this feature introduces — capture must not add write scope beyond what the seam's
    existing test already does. No plan action needed beyond documenting this boundary in
    quickstart.md.
- **III. Registry-Mediated Coordination** — PASS. Fixture evidence lives in the registry like
  every other evidence type; no new coordination channel, no chat-transcript state.
- **IV. Separation of Powers: Builder, Critic, Arbiter** — PASS. Fixture capture does not grant
  approval by itself; it only supplies evidence that the existing, already-independent arbiter
  gate consumes (spec Story 3). `addAcceptanceEvidence`'s existing arbiter-independence checks
  are untouched.
- **V. Tests Before Production Code** — PASS (kit-behavior clause). This is a change to the
  evidence gate/kit behavior, so it MUST ship with `migration/test` regression coverage — see
  Testing above and Phase 1 quickstart.
- **VI. Fail-Closed Automation** — PASS. Per spec FR-005/Edge Cases, a seam that cannot be
  captured (needs a live runtime, or fails outright) causes capture to skip that artifact with
  a stated reason — it does not fabricate a fixture or silently continue as if one exists.
- **VII. Pluggable Stacks, Neutral Providers** — PASS. Fixture capture invokes an already-
  configured, already-passing test command for the seam; it introduces no new stack-specific
  or vendor-specific logic — the "how to run this legacy stack's tests" knowledge already lives
  in stack packs, unchanged by this feature.

No violations requiring the Complexity Tracking table.

## Project Structure

### Documentation (this feature)

```text
specs/002-characterization-test-automation/
├── plan.md              # This file ($speckit-plan command output)
├── research.md          # Phase 0 output ($speckit-plan command)
├── data-model.md         # Phase 1 output ($speckit-plan command)
├── quickstart.md         # Phase 1 output ($speckit-plan command)
├── contracts/            # Phase 1 output ($speckit-plan command)
└── tasks.md              # Phase 2 output ($speckit-tasks command - NOT created by $speckit-plan)
```

### Source Code (repository root)

```text
migration/
├── registry/
│   ├── types.ts                        # extend EvidenceType union with "characterization-fixture"
│   └── commands/
│       └── evidence.ts                 # extend EXECUTABLE_EVIDENCE_TYPES; fixture-comparison helper;
│                                        # checkEvidenceFreshness already generic over evidence_type
├── guildctl/
│   ├── config.ts                       # no change expected (reuses evidence.output_dir)
│   ├── commands/
│   │   ├── evidence.ts                 # extend VALID_EVIDENCE_TYPES; capture-and-record path
│   │   └── verify.ts                   # structural precedent only, not modified
│   └── cli.ts                          # new `guildctl evidence capture` command (or `evidence add
│                                        # --type characterization-fixture` extension — decided in
│                                        # Phase 0 research.md)
└── test/
    ├── evidence-characterization.test.ts   # new: capture, recording, freshness interaction
    └── evidence-cli.test.ts                # extended: new CLI surface coverage
```

**Structure Decision**: This feature is additive within the existing single-package
`migration/` monorepo layout (`registry` = storage/domain library, `guildctl` = CLI, `test` =
regression suite) — no new top-level project or directory. It follows the same
type-union → allowlist → CLI-command → test-file shape as the existing `runtime` evidence
type, since `runtime` is the closest existing precedent for "evidence produced by executing
something" rather than "evidence asserted by an external caller."

## Complexity Tracking

*No Constitution Check violations — table not needed.*
