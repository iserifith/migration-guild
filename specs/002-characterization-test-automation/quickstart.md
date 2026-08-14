# Quickstart: Validating Characterization Test Automation

Validation scenarios below map directly to the spec's Acceptance Scenarios. They assume a
workspace with an initialized guild registry (`guildctl init`) and at least one artifact with
an already-passing legacy unit/invocation-level test.

## Prerequisites

- A workspace with `.guild/registry.db` initialized and an artifact row present (see
  `migration/test/evidence-*.test.ts` for how existing tests set up fixtures — reuse that
  harness pattern rather than a real legacy checkout for automated tests).
- The legacy code under test exposes at least one unit/invocation-level seam runnable without a
  live runtime (per spec Assumptions — first slice excludes runtime-dependent seams).

## Scenario 1: Capture a fixture (spec Story 1)

```sh
guildctl capture-fixture --artifact <id> --seam "UserServiceTest#testCreateUser" \
  --command "npm test -- --grep UserServiceTest" --json
```

**Expected**: JSON output with `"captured": true`, an `evidenceId`, and a `contentSha256`.
Confirm the row exists:

```sh
guildctl evidence list --artifact <id> --json
```

**Expected**: a row with `evidence_type: "characterization-fixture"`, `pass: 1`, and an
`output_path` pointing at a readable JSON file containing `seam`, `input`, `output`.

## Scenario 2: Skip when no runnable seam exists (spec Story 1, Scenario 3)

```sh
guildctl capture-fixture --artifact <id> --seam "IntegrationTest#testCheckout" \
  --command "npm test -- --grep IntegrationTest" --json
```

Run against a seam whose test actually requires a live runtime (e.g. fails without a DB
connection). **Expected**: `"captured": false` with a `reason` field, and no
`characterization-fixture` evidence row added for that invocation. The overall command exits
non-zero for that artifact but does not abort a larger batch (Fail-Closed Automation principle
— confirm this in the Migrate/Plan orchestration wrapper, not in `capture-fixture` itself,
which is a single-artifact primitive).

## Scenario 3: Migrate consults the fixture (spec Story 2)

In a test or REPL exercising `compareToFixture()`:

```ts
import { compareToFixture } from "../registry/commands/evidence";

const result = compareToFixture(db, artifactId, migratedCandidateOutput);
// result.match === true  → migrated output reproduces captured legacy behavior
// result.match === false → result.diff describes the discrepancy
```

**Expected**: for an artifact with a captured fixture, calling with output identical to the
fixture's recorded output returns `{ match: true }`; calling with different output returns
`{ match: false, diff }`. For an artifact with no captured fixture, the call throws a typed,
distinguishable error that a Migrate-phase caller treats as non-blocking (FR-007) rather than
propagating as a hard failure.

## Scenario 4: Arbiter sees fixture evidence (spec Story 3)

After recording a comparison result as evidence (Decision 4):

```sh
guildctl evidence list --artifact <id> --json
guildctl arbitrate --artifact <id> --approve --arbiter reviewer-agent --reason "..." --json
```

**Expected**: the `characterization-fixture` comparison row is visible in `evidence list`
alongside other evidence types; if its `pass` is `0` (mismatch), arbitration behavior is
governed by the same evidence-completeness rules already applied to any other failing evidence
type — this quickstart does not assert a new rule, only that the fixture evidence is visible
and participates.

## Scenario 5: Freshness (spec Story 3, Scenario 3)

1. Capture a fixture for an artifact.
2. Change the underlying legacy output the fixture captured (simulate by mutating the stored
   fixture file's recorded output out of band, or by re-running capture with a deliberately
   different `--command` result).
3. Call `checkEvidenceFreshness(db, artifactId)`.

**Expected**: the same freshness function already used for `runtime`/`static-check` evidence
reports the characterization-fixture evidence as stale under the identical content-hash rule —
no separate "fixture freshness" code path exists to test.

## Regression suite

All of the above should be exercised as automated tests in
`migration/test/evidence-characterization.test.ts`, run via:

```sh
cd migration && npm test
```
