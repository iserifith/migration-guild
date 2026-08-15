# Contract: Registry Schema Additions

**Feature**: `005-artifact-risk-scoring`

This is the persisted-data contract between the risk-scoring scanner (writer),
the Plan-phase confirmation step (writer), the Claim machinery (reader/gate), and
any operator/tooling query (reader) — i.e. what `FR-006` ("registry-visible... without
needing to re-run the scan") and `FR-014` ("available to the planning step") actually
mean in schema terms. Full rationale for these shapes is in `../research.md` (§4, §5)
and `../data-model.md`.

Appended to the base (idempotent `CREATE TABLE IF NOT EXISTS`) section of
`migration/registry_schema.sql`, immediately after the existing
`artifact_classifications` block (line ~421), before the JVM audit findings section.

## Table: `artifact_risk_assessments`

```sql
CREATE TABLE IF NOT EXISTS artifact_risk_assessments (
    artifact_id       TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
    risk_score        REAL NOT NULL CHECK (risk_score >= 0),
    high_risk         INTEGER NOT NULL DEFAULT 0 CHECK (high_risk IN (0, 1)),
    reason_codes_json TEXT NOT NULL,
    signals_json      TEXT NOT NULL,
    updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_artifact_risk_assessments_high_risk
  ON artifact_risk_assessments(high_risk);
```

**Invariants**:
- Exactly one row per artifact that has been through risk scoring (0 or 1, never many
  — enforced by `artifact_id PRIMARY KEY` + upsert-only writes).
- `risk_score` is always in `[0, 100]` by construction (the scoring formula clamps it;
  the CHECK constraint only enforces the lower bound, matching the precedent set by
  `artifact_classifications.confidence`'s CHECK, which likewise only bounds what SQLite
  can cheaply enforce).
- `high_risk = 1` if and only if, at the time of the most recent write, `risk_score >
  <stack pack's high_risk_score_cutoff>`. This table does not re-derive `high_risk` from
  a live threshold lookup — it is a snapshot, consistent with `artifact_classifications`
  also snapshotting `ambiguous` rather than recomputing it on read.
- `reason_codes_json` and `signals_json` are always valid JSON (array / object
  respectively) — never null, never a bare string. Writers MUST use the same
  coercion discipline as `coerceEvidence` in `classification.ts`; readers MUST use
  the same never-throwing parse discipline as `parseEvidence`.

## Table: `risk_confirmations`

```sql
CREATE TABLE IF NOT EXISTS risk_confirmations (
    artifact_id  TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
    decision     TEXT NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending', 'confirmed', 'declined')),
    decided_by   TEXT,
    decided_at   TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_risk_confirmations_decision
  ON risk_confirmations(decision);
```

**Invariants**:
- A row exists for an artifact **if and only if** that artifact has, at some point,
  been scored `high_risk = 1`. Artifacts that have never crossed the cutoff have no
  row here (not a `decision='pending'` row for everyone — that would make the claim
  gate's `NOT EXISTS` check scan a much larger table for no benefit).
- Once a row exists, `decision` only ever moves `pending → confirmed`,
  `pending → declined`, or `declined → confirmed` (an operator revisiting a prior
  decline). It is never reset to `pending` by a recompute of `artifact_risk_assessments`
  (see `../data-model.md` Entity 3 state transitions).
- `decided_by`/`decided_at` are both null while `decision = 'pending'`, both non-null
  otherwise.

## Claim-eligibility contract (consumer of `risk_confirmations`)

`migration/registry/commands/claim.ts`'s `claimNextTask` candidate query and
`claimArtifactById`'s pre-update check both gain:

```sql
AND NOT EXISTS (
  SELECT 1 FROM risk_confirmations rc
  WHERE rc.artifact_id = a.id AND rc.decision != 'confirmed'
)
```

**Contract**: an artifact is claimable through the normal wave/claim machinery if and
only if it has no `risk_confirmations` row, or its row's `decision = 'confirmed'`.
This is the sole enforcement point for FR-010; no other code path may claim an
artifact without passing through `claimNextTask` or `claimArtifactById`.

## Migration mechanics

Both tables are **new** — no `ALTER TABLE`, no `ensureColumn` runtime guard, and no
CHECK-constraint rebuild are required. `CREATE TABLE IF NOT EXISTS` is safe to run
unconditionally against every existing registry database, consistent with how
`artifact_classifications` itself was originally introduced.
