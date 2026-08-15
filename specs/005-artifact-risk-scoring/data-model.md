# Data Model: Automated Risk Scoring for Legacy Artifacts

**Feature**: `005-artifact-risk-scoring` | **Date**: 2026-08-16

Source of truth for all migration state remains the shared SQLite registry
(`migration/registry_schema.sql`), per Principle III. This document defines the three
Key Entities from `spec.md` in terms of concrete registry tables/columns and the
in-process TypeScript records that produce them, following the exact pattern already
established by `artifact_classifications` / `ClassificationRecord` in
`migration/guildctl/classification.ts`.

## Entity 1: Artifact Risk Assessment

Represents the computed risk profile of one inventoried artifact — mirrors
`artifact_classifications` structurally.

### Registry table: `artifact_risk_assessments`

| Column              | Type    | Constraints                                    | Notes |
|---------------------|---------|-------------------------------------------------|-------|
| `artifact_id`       | TEXT    | PRIMARY KEY, REFERENCES `artifacts(id)` ON DELETE CASCADE | One row per artifact |
| `risk_score`        | REAL    | NOT NULL, CHECK (`risk_score >= 0`)             | 0–100, see research.md §7 formula |
| `high_risk`         | INTEGER | NOT NULL DEFAULT 0, CHECK IN (0,1)              | `risk_score > high_risk_score_cutoff` at computation time |
| `reason_codes_json` | TEXT    | NOT NULL                                        | JSON array of strings, coerced via the same defensive coercion as `evidence_json` |
| `signals_json`      | TEXT    | NOT NULL                                        | JSON object of raw per-heuristic values, for transparency/debugging |
| `updated_at`        | TEXT    | NOT NULL DEFAULT `datetime('now')`              | Set on every insert/upsert |

Indexes: `idx_artifact_risk_assessments_high_risk ON artifact_risk_assessments(high_risk)`
(mirrors `idx_artifact_classifications_ambiguous`; supports the claim-gate `NOT EXISTS`
lookup and any operator query filtering to just high-risk artifacts).

### In-process record shape (`RiskAssessmentRecord`)

```ts
interface RiskAssessmentRecord {
  id: string;              // artifact id
  riskScore: number;       // 0-100, clamped
  highRisk: boolean;
  reasonCodes: string[];   // e.g. ["god-method:processOrder@L142 (187 lines > 80)"]
  signals: Record<string, unknown>; // raw per-heuristic contributing values
}
```

### Validation rules (mirrors `validateBatch` in classification.ts)

- `artifact_id` must reference an existing row in `artifacts`.
- `risk_score` must be a finite number `>= 0` (clamped to `<= 100` before persistence).
- `reason_codes` must be an array (possibly empty — a low/zero-risk artifact has an
  empty list per spec Acceptance Scenario 1.4).
- Every heuristic that fires MUST contribute exactly one reason code; a heuristic that
  could not run MUST contribute a `heuristic-skipped:<name>` reason code instead of
  being silently absent (FR-016).

### Write path

New function `applyRiskAssessment(db, spec, record)` (or a batch variant
`applyBatchRiskAssessment`, mirroring `applyBatchClassification`), transactional
upsert:

```sql
INSERT INTO artifact_risk_assessments
  (artifact_id, risk_score, high_risk, reason_codes_json, signals_json, updated_at)
VALUES (@artifact_id, @risk_score, @high_risk, @reason_codes_json, @signals_json, datetime('now'))
ON CONFLICT(artifact_id) DO UPDATE SET
  risk_score = excluded.risk_score,
  high_risk = excluded.high_risk,
  reason_codes_json = excluded.reason_codes_json,
  signals_json = excluded.signals_json,
  updated_at = datetime('now')
```

The `ON CONFLICT DO UPDATE` shape is what makes FR-015 (recompute replaces, never
accumulates) structurally guaranteed rather than relying on application-level care.

### State transitions

None — this is a derived-metadata table, recomputed wholesale on each (re-)registration
of its artifact. It has no independent lifecycle; it always reflects the latest scan.

### Relationships

- `artifact_risk_assessments.artifact_id` → `artifacts.id` (1:1, cascade delete).
- Feeds `risk_confirmations` (Entity 3): when a freshly-upserted row has
  `high_risk = 1` and no `risk_confirmations` row yet exists for that artifact, a
  `pending` confirmation row is created in the same transaction.

---

## Entity 2: Risk Threshold Configuration

Represents the per-stack-pack configurable limits, plus built-in defaults. This is
**not a registry table** — like `ClassificationSpec.quality`, it is stack-pack YAML
configuration, loaded fresh each run (not persisted state), per research.md §3.

### Location: `risk:` block in each stack pack's `classification.yaml`

(e.g. `stacks/java-spring/classification.yaml`, `stacks/python/classification.yaml`)

### Shape (`RiskSpec`, extending `ClassificationSpec`)

```ts
interface RiskSpec {
  god_method_max_lines?: number;          // default: 80
  cyclomatic_complexity_limit?: number;   // default: 15
  high_risk_score_cutoff?: number;        // default: 50
  method_boundary?: {
    style: "brace" | "indent";            // default: "brace"
    start_pattern: string;                // regex; stack-pack-specific, required if method_boundary is set
  };
  complexity_keywords?: string[];         // default: built-in list, see research.md §2
  reflection_patterns?: Array<{
    id: string;
    match: string;      // regex, evaluated per-line like StackAuditRule.match
    flags?: string;
    evidence: string;   // human-readable description used in reason codes
  }>;
}
```

All fields optional at the YAML level — an absent `risk:` block entirely, or any
absent field within it, falls back to the built-in default (FR-008). `method_boundary`
and `reflection_patterns` have repo-wide built-in defaults covering the currently
shipped stack packs (Java-style brace/reflection patterns), but a stack pack SHOULD
override `method_boundary.start_pattern` and `reflection_patterns` for its own
language's idioms — the built-in defaults exist for backward compatibility (spec
Assumption: "Existing artifacts and stack packs with no risk configuration continue to
function"), not as a claim of correctness for every language.

### Validation rules (fail-fast at load time, extends `validateSpec`)

- `god_method_max_lines`, if present, MUST be a finite number `> 0`.
- `cyclomatic_complexity_limit`, if present, MUST be a finite number `> 0`.
- `high_risk_score_cutoff`, if present, MUST be a finite number `>= 0`.
- `method_boundary.style`, if present, MUST be one of `"brace" | "indent"`.
- Each `reflection_patterns[].match` MUST compile as a valid `RegExp` (caught at load
  time, not at first scan).
- Violations throw with a clear, actionable message identifying the stack pack id and
  the offending field (FR-009), exactly like `validateSpec`'s existing
  `${source}: frameworks.allowed must not be empty`-style errors.

### Relationships

Consumed by the risk-scanning module during Inventory (Entity 1's computation) and by
the confirmation gate (Entity 3, `high_risk_score_cutoff` specifically) — read-only,
never written by application code.

---

## Entity 3: High-Risk Confirmation Decision

Represents an operator's recorded confirm/decline decision for a specific high-risk
artifact — mirrors `stack_mappings`'s `confirmed`/`confirmed_by`/`confirmed_at`
columns, but as its own table (see research.md §4 for why it's not folded into Entity 1).

### Registry table: `risk_confirmations`

| Column        | Type    | Constraints                                                       | Notes |
|---------------|---------|--------------------------------------------------------------------|-------|
| `artifact_id` | TEXT    | PRIMARY KEY, REFERENCES `artifacts(id)` ON DELETE CASCADE          | One row per artifact that has ever been high-risk |
| `decision`    | TEXT    | NOT NULL DEFAULT `'pending'`, CHECK IN (`'pending'`, `'confirmed'`, `'declined'`) | |
| `decided_by`  | TEXT    | nullable                                                            | `'operator'` (interactive) or `'benchmark-runner'` (auto-confirm), matching the `confirmMappings` precedent's actor labels |
| `decided_at`  | TEXT    | nullable                                                            | Set when `decision` moves off `'pending'` |
| `created_at`  | TEXT    | NOT NULL DEFAULT `datetime('now')`                                  | When the artifact first crossed the high-risk cutoff |

Index: `idx_risk_confirmations_decision ON risk_confirmations(decision)` (supports the
claim-gate `NOT EXISTS` lookup and Plan-phase "list pending" query).

### State transitions

```
(no row) --[risk_score first exceeds cutoff]--> pending
pending  --[operator confirms, or GUILDCTL_AUTO_CONFIRM_RISK=1]--> confirmed
pending  --[operator declines]--> declined
confirmed --[artifact re-scored, still high-risk]--> confirmed (unchanged; re-registration does not reset an existing decision — see spec edge case)
declined  --[operator later confirms via a subsequent Plan run]--> confirmed
```

A `pending` or `declined` row is what the Claim-time gate checks for; only `confirmed`
(or no row at all) permits claiming.

**Threshold-tightening edge case** (spec: "if the stack pack's thresholds are later
tightened... existing confirmations remain valid... only newly scored/re-scored
artifacts are judged against the new thresholds"): the write path for Entity 1 only
*creates* a `risk_confirmations` row when none exists; it never resets an existing
`confirmed`/`declined` row back to `pending` on recompute. A confirmation, once
recorded, survives re-registration unless the artifact is re-inventoried and its score
newly crosses the cutoff for the first time (i.e., no existing row) — which can only
happen if the row was deleted (artifact removed and re-added) or never existed.

### Validation rules

- A `risk_confirmations` row MUST only be created for an artifact whose latest
  `artifact_risk_assessments.high_risk = 1`.
- `decision` transitions MUST be recorded durably (FR-011) — no in-memory-only
  confirmation state.
- Concurrent confirm/decline attempts on the same artifact: last-writer-wins via a
  single `UPDATE ... WHERE artifact_id = ?` (SQLite's transaction serialization
  already prevents a lost-update race, matching "the mechanism follows the same
  conflict handling already used for mapping confirmation" — `stack_mappings` has the
  same last-writer-wins shape today, no additional locking needed).

### Relationships

- `risk_confirmations.artifact_id` → `artifacts.id` (1:1, cascade delete).
- Read by `claimNextTask` / `claimArtifactById` (`migration/registry/commands/claim.ts`)
  as an `AND NOT EXISTS (... decision != 'confirmed')` clause on the claim candidate
  query.
- Written by the new `confirmHighRiskArtifacts` Plan-phase step
  (`migration/guildctl/commands/plan.ts`, new function alongside `confirmMappings`).

---

## Cross-entity summary

```
artifacts (existing)
   │ 1:1
   ├── artifact_classifications (existing — confidence/ambiguous/evidence/signals)
   ├── artifact_risk_assessments (NEW — risk_score/high_risk/reason_codes/signals)
   └── risk_confirmations (NEW — decision/decided_by/decided_at; only present once an artifact has crossed high_risk_score_cutoff at least once)

classification.yaml (per stack pack, existing file)
   └── risk: { ... }  (NEW block — Risk Threshold Configuration; config, not registry state)
```
