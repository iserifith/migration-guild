# Quickstart: Validating Automated Risk Scoring

**Feature**: `005-artifact-risk-scoring`

This is a validation guide, not an implementation guide — it documents how to prove
the feature works end-to-end using this repository's real commands, once
`tasks.md`/implementation lands the changes described in `plan.md`,
`data-model.md`, and `contracts/`. It does not duplicate schema/config detail already
captured there.

## Prerequisites

- Node.js toolchain already set up for this repo (root `npm install`, which installs
  both the root workspace and, per existing project convention, `migration/`'s
  dependencies — see `migration/package.json`).
- Working tree includes the new registry table definitions
  (`contracts/registry-schema.md`) and the new `risk:` blocks in at least one stack
  pack's `classification.yaml` (`contracts/risk-spec-yaml.md`).

## 1. Build and unit-test the kit

From the repository root:

```bash
npm run build          # tsup setup.ts — root CLI installer bundle
npm run test           # npm --prefix migration test && npm --prefix migration/ui test
```

`npm run test` is what actually exercises the new code: it runs
`migration/package.json`'s `test` script (`node --import tsx --test test/*.test.ts`),
which is where the new risk-scanning unit tests, `artifact_risk_assessments` /
`risk_confirmations` schema tests, and the extended `plan-invariant-verification.test.ts`
/ `claim-ordering.test.ts`-style coverage belong (per Constitution Principle V —
kit behavior itself must be covered by the `migration/test` suite; `tasks.md` is
where these individual test files get enumerated).

If you only need the registry/CLI package rebuilt (faster inner loop while iterating):

```bash
npm --prefix migration run build   # tsc -p migration/tsconfig.json
npm --prefix migration test        # node --import tsx --test test/*.test.ts
```

## 2. End-to-end scenario: User Story 1 — risk scores visible after Inventory

This does **not** run against the repository root (Constitution: "Migration phases
MUST NOT be run against this repository root"). Use a scratch workspace seeded from
`package/mock/`, mirroring how the repo's own manual-validation flow works for any
installed-behavior check.

```bash
# from a throwaway directory, e.g. /tmp/risk-scoring-check
mkdir -p /tmp/risk-scoring-check && cd /tmp/risk-scoring-check
cp -r <repo>/package/mock/* .          # or the fixture the team already uses for manual QA
# ... run guildctl init / preflight per GETTING-STARTED.md as normal ...
guildctl inventory
```

**Expected outcome (Acceptance Scenarios 1–4 in `spec.md`)**:
- Inventory completes and prints a summary that includes a high-risk artifact count
  (see `contracts/cli-surface.md`).
- Querying the registry directly confirms every registered artifact has a row in
  `artifact_risk_assessments`:
  ```bash
  sqlite3 .guild/registry.db \
    "SELECT artifact_id, risk_score, high_risk, reason_codes_json FROM artifact_risk_assessments;"
  ```
- An artifact with a planted `Class.forName(...)`/`Method.invoke(...)` call shows a
  `reflection-usage:*` reason code and a higher score than an artifact without one.
- An artifact with a method longer than the active stack pack's
  `god_method_max_lines` shows a `god-method:*` reason code.
- An artifact with a method whose keyword-counted branching exceeds
  `cyclomatic_complexity_limit` shows a `cyclomatic-complexity:*` reason code.
- A plain artifact (no planted risk constructs) shows `risk_score` at/near 0 and
  `reason_codes_json = "[]"`.
- No re-scan is needed to see this — it's a plain `SELECT` against data already
  written during the `guildctl inventory` run just completed (FR-006/SC-001).

## 3. Scenario: User Story 2 — per-stack-pack thresholds

```bash
# Fixture A: stack pack with a stricter (lower) god_method_max_lines
# Fixture B: stack pack with a looser (higher) god_method_max_lines
guildctl inventory   # run once per fixture workspace, each pointed at the respective stack pack
```

**Expected outcome**: the same artifact (or an equivalent-length artifact planted in
each fixture) is flagged `high_risk = 1` under the stricter pack's threshold and not
flagged under the looser pack's threshold — confirms `contracts/risk-spec-yaml.md`'s
per-pack override is actually taking effect over the built-in default (Acceptance
Scenario 2.1–2.3).

## 4. Scenario: User Story 3 — claim gate blocks high-risk artifacts until confirmed

```bash
guildctl plan
```

**Expected outcome**:
- Below-threshold artifacts reach `status = 'planned'` and are claimable normally.
- Above-threshold artifacts get a `risk_confirmations` row with `decision='pending'`
  (verify: `sqlite3 .guild/registry.db "SELECT * FROM risk_confirmations;"`).
- Attempting to claim a pending-confirmation artifact (e.g. via the migrate phase, or
  directly through `registry claim`) fails to select it as a candidate — it is
  excluded by the `NOT EXISTS` clause documented in
  `contracts/registry-schema.md`'s claim-eligibility contract.
- Interactively confirming it (`y` at the prompt printed by `confirmHighRiskArtifacts`,
  or setting `GUILDCTL_AUTO_CONFIRM_RISK=1` before `guildctl plan` for a non-interactive
  run) flips `decision` to `'confirmed'`; the artifact becomes claimable on the next
  claim attempt with no other change needed (Acceptance Scenario 3.2).
- Declining leaves it `declined` — still not claimable, and the run does not error out
  or hang (Acceptance Scenario 3.3–3.4).

## 5. Scenario: User Story 4 — planner visibility (lower priority, P3)

Inspect the wave assignment the Planner agent produced
(`guildctl plan`'s own `printWavePlan` output, or `SELECT id, wave FROM artifacts`)
and confirm pending-high-risk artifacts are not placed ahead of confirmed
lower-risk work with no dependency requiring otherwise (Acceptance Scenario 4.1) —
this is an ordering property to eyeball/assert in a test fixture with mixed risk
scores, not a new command.

## Regression coverage this quickstart maps to (for `tasks.md` to enumerate)

- `migration/test/inventory-classification.test.ts`-style additions: risk-scan unit
  tests (reflection/god-method/cyclomatic-complexity detection, skipped-heuristic
  edge case).
- A new `migration/test/*.test.ts` file covering `applyRiskAssessment`/upsert-replace
  semantics (FR-015) and the `risk:` YAML validation contract (FR-009).
- `migration/test/plan-invariant-verification.test.ts`-style additions:
  `confirmHighRiskArtifacts` interactive + `GUILDCTL_AUTO_CONFIRM_RISK` paths.
- `migration/test/claim-ordering.test.ts`-style additions: claim candidate query
  correctly excludes `pending`/`declined` risk-confirmation artifacts and includes
  `confirmed`/no-row artifacts.
- `migration/test/inventory-risk-benchmark.test.ts` (T035): benchmark-corpus test asserting
  the measured ≥95% flag rate on planted-risky artifacts and ≥95% zero-reason-code rate on
  planted-simple artifacts (SC-002).
