# Artifact Risk Scoring (spec 005)

How every inventoried artifact gets a deterministic risk score, where that score
is persisted, and how it gates claims, approvals, and UI display.

## TL;DR data flow

```
runInventory (guildctl/commands/inventory.ts:419-440)
  └─ loadRiskSpec(pack) → guildctl/risk.ts        (stack-pack thresholds or defaults)
  └─ scoreArtifact(id, sourceText, spec)          (per first-class artifact)
       └─ RiskAssessmentRecord { riskScore, highRisk, reasonCodes, signals }
  └─ applyBatchRiskAssessment(db, records)        (upsert + seed risk_confirmations)
        ↓
artifact_risk_assessments / risk_confirmations tables (registry_schema.sql:513-534)
        ↓
Consumers:
  • claim gate        — registry/commands/claim.ts:547-557 (blocks claim unless confirmed)
  • approval gate     — registry/commands/evidence.ts:530-545 via resolveGateScope (approval.ts:141-167)
  • plan confirmation — guildctl/commands/plan.ts:787-791 → confirmHighRiskArtifacts (plan.ts:82-150)
  • UI                — ui/src/components/ApprovalsPanel.tsx (riskReasonCodes chips)
```

## 1. Signal collection and the scoring formula

Everything lives in `migration/guildctl/risk.ts`. `scoreArtifact`
(risk.ts:253) scans the artifact's raw source text for three signal families:

1. **Reflection usage** — regex line scan against configurable patterns
   (`detectReflection`, risk.ts:234). Defaults
   (`DEFAULT_REFLECTION_PATTERNS`, risk.ts:45): `Class.forName(` and
   `.getMethod(...).invoke(`. Each distinct pattern id that hits emits a
   reason code `reflection-usage:<patternId>`.
2. **God method** — method boundaries are found by brace matching or
   indentation (`findMethodBoundaries`, risk.ts:152-216; boundary detection is
   configurable via `risk.method_boundary`, default is a Java signature regex).
   The *worst* (longest) method is compared to `godMethodMaxLines`; overage
   emits `god-method:<name>@L<line> (N lines > limit)`.
3. **Cyclomatic complexity** — a keyword-count approximation
   (`countComplexityKeywords`, risk.ts:222): `1 + count(keywords)` per method,
   default keywords `["if","else if","for","while","case","catch","&&","||","?"]`.
   The worst method vs `cyclomaticComplexityLimit` emits
   `cyclomatic-complexity:<name>@L<line> (complexity N > limit)`.

The formula (risk.ts:300-305) is a **weighted sum of capped overages, clamped
to [0, 100]**:

```ts
const riskScore = Math.min(
  100,
  (reflectionHits.length > 0 ? 30 : 0) +
    Math.min(35, methodLinesOverage * 0.5) +
    Math.min(35, complexityOverage * 2),
);
```

So: reflection is a flat binary +30; god-method overage contributes 0.5/line
capped at 35; complexity overage contributes 2/point capped at 35. The caps
make the score deterministic and non-dominating — no single heuristic can
exceed 35, so any *two* signals firing can cross the default cutoff but no
single one can alone (max 35 < 50).

**High-risk flag**: `highRisk: riskScore > spec.highRiskScoreCutoff`
(risk.ts:310) — strictly greater-than; a score of exactly 50 with the default
cutoff is *not* high risk (asserted in `test/risk-assessment-persistence.test.ts:105-107`).

### Threshold configuration (US2)

`resolveRiskSpec` (risk.ts:100) layers a stack pack's optional `risk:` block
over built-in defaults: `god_method_max_lines` 80, `cyclomatic_complexity_limit`
15, `high_risk_score_cutoff` 50, method boundary regex, complexity keywords,
reflection patterns. `validateRiskSpec` (risk.ts:68) fail-closes on bad config:
non-positive numbers, non-compilable regexes, duplicate reflection pattern ids.
`loadRiskSpec` (risk.ts:113) is the entry point used by inventory and
`registry/commands/approval.ts:3`. Notably, **neither shipped stack pack
(`stacks/java-spring`, `stacks/python`) currently declares a `risk:` block** —
all production scoring runs on the built-in defaults; the override path is
exercised by `test/risk-scanner.test.ts` and `test/risk-spec-validation.test.ts`.

## 2. Where scoring runs

Scoring is a **deterministic, in-process pass at the end of the Inventory
phase** — not agent-driven. In `runInventory` (guildctl/commands/inventory.ts:419-440),
after classification completes and *before* `validateInventoryQuality`, so a
scoring failure fails the phase rather than passing silently. For every
first-class artifact it reads the source file and calls `scoreArtifact`.

Edge cases:

- **Unreadable source** is scored with empty content (inventory.ts:427-433),
  so the artifact still gets a row carrying
  `heuristic-skipped:god-method` / `heuristic-skipped:cyclomatic-complexity`
  reason codes (risk.ts:267-271) instead of being silently missed. Note
  reflection is still scanned (trivially zero hits on empty text).
- **No methods detected** (e.g. non-conforming source): both method heuristics
  are marked skipped; reflection still scores.
- **Rescore timing**: re-running Inventory fully recomputes and *replaces* —
  `applyRiskAssessment` (risk.ts:329) is an `INSERT ... ON CONFLICT(artifact_id)
  DO UPDATE`, never accumulating (FR-015). Stale reason codes disappear when
  the source is fixed (confirmed by `test/inventory-risk-scoring.test.ts:143-179`).

## 3. Persistence

Two tables in `migration/registry_schema.sql:513-534` (mirrored in
`registry/db/schema.ts`, verified by `test/risk-schema.test.ts`):

- `artifact_risk_assessments (artifact_id PK, risk_score REAL NOT NULL CHECK >= 0,
  high_risk INTEGER CHECK IN (0,1), reason_codes_json, signals_json, updated_at)`,
  indexed on `high_risk`.
- `risk_confirmations (artifact_id PK, decision CHECK IN
  ('pending','confirmed','declined') DEFAULT 'pending', decided_by, decided_at)`,
  indexed on `decision`.

`applyRiskAssessment` (risk.ts:329-356) upserts the assessment and, in the
same transaction, seeds a `pending` `risk_confirmations` row **only when the
record is high-risk and no row exists** (`ON CONFLICT DO NOTHING`). An existing
`confirmed`/`declined` decision is never reset by a recompute — only newly
high-risk artifacts enter the review queue. `applyBatchRiskAssessment`
(risk.ts:359) wraps many artifacts in one transaction.

## 4. Consumers

### 4.1 Claim gate (US3 — the hard enforcement)

`registry/commands/claim.ts:547-557`: before any claim (both `claimNextTask`
and `claimArtifactById`), the row's `decision` is checked. Anything other than
`confirmed` (pending **or** declined) refuses the claim:

> `Artifact "<id>" is pending human risk confirmation (high-risk). Refusing
> claim until confirmed.` (declined gets a "declined for migration" message)

Artifacts with **no** `risk_confirmations` row claim normally (FR-013) — the
gate is keyed on the confirmation row, not on `high_risk`, so low-risk
artifacts are untouched (`test/risk-confirmation-claim-gate.test.ts`).

### 4.2 Plan-phase confirmation prompt

`guildctl/commands/plan.ts` runs `confirmHighRiskArtifacts` (plan.ts:82-150)
**after** the Planner phase (plan.ts:787-791), deliberately — pending
high-risk work never blocks wave assignment for everything else; enforcement
lives at the claim boundary. The prompt lists pending artifacts
`ORDER BY ra.risk_score DESC` (plan.ts:104) and offers confirm/decline;
`GUILDCTL_AUTO_CONFIRM_RISK=1` bulk-confirms for unattended runs
(decided_by `benchmark-runner`), preserving the "never silently migrate
high-risk work" invariant (spec US3 scenario 4).

### 4.3 Approval gate (spec 013 interplay)

Independent of the claim gate: when an arbiter records a verdict,
`resolveGateScope` (registry/commands/approval.ts:141-167) checks the stored
`high_risk` flag; in-scope artifacts are held at `pending-approval` instead of
transitioning to `reviewed`, with an atomic `approval-gated` event
(registry/commands/evidence.ts:530-545). The cutoff comparison is *not*
recomputed here — the flag computed at inventory time is authoritative.

### 4.4 UI display

`ui/src/components/ApprovalsPanel.tsx` renders each held artifact's
`riskReasonCodes` as chips (lines 147-155), with an explicit "No risk reason
codes recorded." placeholder when empty. The field is parsed defensively from
`reason_codes_json` in `approval.ts:85-98` (`[]` on missing/malformed JSON)
and typed in `ui/src/types.ts:313`. CLI/JSON parity of `riskReasonCodes`
between the dashboard API and CLI output is asserted by
`test/approval-dashboard-parity.test.ts:58`.

### 4.5 Wave ordering (US4 — partially implemented)

The spec's US4 ("planner orders work using risk visibility", P3) is only
**advisory/partially built**: the planner prompt (plan.ts:762) never mentions
risk scores, and there is no risk-aware wave-sorting code. What exists is the
*non-blocking* guarantee — the confirmation prompt runs after wave assignment,
and `tasks.md` T027/T028 describe a risk-visible query helper and a
`migration/test/risk-wave-ordering.test.ts` that **do not exist yet**
(`migration/test/` has no risk-wave file). So: high-risk artifacts are gated
at claim time, but waves themselves are ordered purely by dependency
structure, not risk.

## 5. Tests and what they confirm

| Test | Confirms |
|---|---|
| `test/risk-scanner.test.ts` | Formula behavior: reflection/god/complexity scoring, caps, worst-case sum, cutoff boundary |
| `test/risk-schema.test.ts` | Table columns, CHECK constraints, indexes |
| `test/risk-assessment-persistence.test.ts` | Upsert-replaces (never accumulates), batch transaction, cutoff `>` (50 = not high, 51 = high), pending row seeded only for high-risk, decisions never reset |
| `test/inventory-risk-scoring.test.ts` | End-to-end `runInventory` scoring of planted fixtures; plain artifact = score 0 / `[]`; re-run replaces stale codes |
| `test/risk-spec-validation.test.ts` | Stack-pack config validation fail-closes |
| `test/risk-confirmation-claim-gate.test.ts` | Pending/declined artifacts unclaimable; no-row artifacts claim normally |
| `test/approval-fixtures.ts`, `approve-command.test.ts`, `supervisor-held-approval.test.ts`, `approval-gate.test.ts` | Approval-gate hold at `pending-approval` for above-cutoff artifacts |
| `test/approval-dashboard-parity.test.ts` | UI/CLI `riskReasonCodes` parity |

## 6. Extension points

Adding a new signal means: (1) add a pattern/threshold to `RiskSpec` +
`ResolvedRiskSpec` + defaults in `guildctl/risk.ts` with validation in
`validateRiskSpec`; (2) compute it inside `scoreArtifact`, pushing a reason
code and a `signals` entry, and add its capped term to the formula (keep the
cap ≤ 35 if you want to preserve the "no single signal crosses the default
cutoff alone" property); (3) extend `test/risk-scanner.test.ts`. Per-stack
tuning needs no code change — just a `risk:` block in a stack pack's
classification config, which currently no shipped pack uses.
