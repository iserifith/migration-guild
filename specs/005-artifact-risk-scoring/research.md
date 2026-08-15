# Phase 0 Research: Automated Risk Scoring for Legacy Artifacts

**Feature**: `005-artifact-risk-scoring` | **Date**: 2026-08-16

This document resolves the technical unknowns needed before design (Phase 1). Each
decision is grounded in an existing pattern already present in the repository, per
Principle VII (Pluggable Stacks, Neutral Providers) and the spec's own precedent
references (`inventory.ts` `scanAndRegister`, `classification.ts`, `plan.ts`
`confirmMappings`, wave/claim machinery).

## 1. Where risk scoring hooks into Inventory

**Decision**: Compute risk assessment as a second deterministic pass over already-registered
artifacts, run from `runInventory` in `migration/guildctl/commands/inventory.ts`
immediately after the classification batch loop (around lines 336–405) and before
`validateInventoryQuality` is invoked as the hard gate (line ~420). Unlike classification
— which is LLM-driven (`context-agent` via `batch-classify`) — risk scoring is fully
deterministic and heuristic, so it does not need an agent round-trip; it runs as plain
TypeScript over each artifact's source file, immediately after that artifact is registered
or as one pass over all first-class artifacts once registration completes.

**Rationale**: Mirrors the existing "register, then compute derived metadata, then gate on
completeness" shape already used for classification (`registerArtifact` → `batch-classify`
→ `validateInventoryQuality`). Reusing the same gate function shape means risk-assessment
completeness can be folded into the same `InventoryValidationReport`/exit-code contract
operators already know, rather than inventing a second, parallel pass/fail mechanism.

**Alternatives considered**:
- *Compute inline inside `registerArtifact`*: rejected — `registerArtifact`
  (`migration/registry/commands/artifacts.ts:41`) is a narrow, synchronous row-insert
  helper reused by every artifact kind (including non-source kinds like `config`,
  `sql-schema`); folding file-content heuristics into it would couple an unrelated
  concern into the registration primitive and make it impossible to unit-test risk
  scoring independently (as `classification.ts` already keeps `classifyArtifactSource`
  separate from `registerArtifact` for the same reason).
- *Compute lazily at Plan time*: rejected — FR-001 requires the score to exist "at the
  point it is registered," and FR-006 requires it to be queryable "without needing to
  re-run the scan." Deferring to Plan would violate both and would also leave User
  Story 1 (score visible right after Inventory) unsatisfied.

## 2. Cyclomatic-complexity / God-method approach for the TS scanner

**Decision**: A lightweight, per-line, text-based heuristic scanner — no AST parser, no
new npm dependency. The scanner:
1. Splits file content on `/\r?\n/` (the same primitive `audit.ts`'s
   `collectLineMatches` already uses at `migration/guildctl/audit.ts:41-55`).
2. Locates method-start lines using a per-stack-pack configurable regex
   (`risk.method_boundary.start_pattern`), e.g. a Java/C-family method signature
   pattern or a Python `def ...:` pattern.
3. Determines each method's line range using one of two configurable boundary
   strategies, since legacy stacks in this repo include brace languages (Java) and
   indentation languages (Python): `"brace"` (track `{`/`}` depth from the signature
   line back to zero) or `"indent"` (track indentation level: the method ends at the
   first subsequent line at or below the signature's indentation).
4. Within each method's line range, counts (a) the number of lines → God-method
   signal if it exceeds `god_method_max_lines`, and (b) occurrences of a
   configurable list of complexity-contributing keywords/operators
   (`risk.complexity_keywords`, e.g. `if`, `else if`, `elif`, `for`, `while`, `case`,
   `catch`, `except`, `&&`, `||`, `?`) plus 1 (McCabe baseline) → cyclomatic-complexity
   signal if it exceeds `cyclomatic_complexity_limit`.
5. Reflection/dynamic-invocation detection reuses the *existing* `StackAuditRule` /
   `collectLineMatches` regex-per-line machinery unchanged — a new `risk.reflection_patterns[]`
   list of `{ id, match, flags, evidence }` entries evaluated the same way audit rules
   already are, since single-line regex is already sufficient for `Class.forName(`,
   `.getMethod(`/`.invoke(`, Python `getattr(obj, name)(`, `importlib.import_module(`, etc.
6. If a file can't be meaningfully scanned (e.g. binary content, zero method matches
   found where the language expects some, or a read error), the corresponding
   heuristic(s) contribute zero score and record a `heuristic-skipped:<heuristic>`
   reason code (per the spec's edge case), rather than failing registration.

**Rationale**: Repository research confirmed there is **no existing AST parser and no
cyclomatic-complexity library** as a first-party dependency in either `package.json`
(root or `migration/`) — only incidental transitive deps of the Vite/TypeScript
toolchain, unusable for parsing Java/Python legacy source anyway. The spec's own
Assumptions section explicitly frames this detection as heuristic ("pattern/AST-based,
not a full static-analysis guarantee... aims for practically useful signal"), which
licenses a text-based approach. Line-scoped regex is already the established idiom for
both classification signals (`classification.ts:143-153`) and audit findings
(`audit.ts:41-55`); extending that idiom to method-boundary tracking is consistent with
Principle VII (no new vendor/tooling dependency baked into core) and avoids taking on
a `tree-sitter` + per-language grammar dependency for a feature explicitly scoped as
heuristic, not exhaustive.

**Alternatives considered**:
- *Add `tree-sitter` + `tree-sitter-java`/`tree-sitter-python`*: rejected for this
  feature — real structural accuracy, but a new dependency footprint (native bindings,
  per-language grammars to keep in sync with new stack packs) for a feature the spec
  itself scopes as heuristic. Revisit only if false-positive/negative rates in
  production prove the text heuristic insufficient (SC-002's 95% bar is the trigger to
  reconsider).
- *TypeScript Compiler API*: rejected — only parses JS/TS; none of the current stack
  packs (`java-spring`, `python`) are JS/TS-based, so it wouldn't cover the actual
  legacy languages in scope.
- *Per-stack external tool shell-out (e.g. a Java complexity CLI)*: rejected —
  mirrors the `verify.per_artifact` external-command pattern in `stack.yaml`, but adds
  an availability/installation burden per stack pack for a scanner that must run on
  every artifact at Inventory time (unlike `verify`, which runs once per migrated
  artifact and already tolerates unavailability via `unavailable_note`). Revisit as a
  future opt-in enhancement per stack pack, not a default.

## 3. Where per-stack-pack risk configuration lives

**Decision**: Extend the existing `classification.yaml` (loaded via
`loadClassificationSpec` in `migration/guildctl/classification.ts:98-107`) with a new
top-level `risk:` block, validated by the same `validateSpec`-style fail-fast function
at load time. Shape:

```yaml
risk:
  god_method_max_lines: 80          # optional, default applied if absent
  cyclomatic_complexity_limit: 15   # optional, default applied if absent
  high_risk_score_cutoff: 50        # optional, default applied if absent
  method_boundary:
    style: brace                    # "brace" | "indent"
    start_pattern: '...'            # regex identifying a method signature line
  complexity_keywords: ["if", "else if", "for", "while", "case", "catch", "&&", "||", "?"]
  reflection_patterns:
    - id: java-class-forName
      match: '\bClass\.forName\s*\('
      evidence: "Class.forName reflective load"
    - id: java-method-invoke
      match: '\.getMethod\s*\([^)]*\)\s*\.invoke\s*\('
      evidence: "Method.invoke reflective call"
```

**Rationale**: One load path per stack pack (`loadActiveStack` → `loadClassificationSpec`)
already exists and is already the place FR-007/FR-008/FR-009 (stack-pack-configurable
thresholds, sane defaults, fail-fast validation of malformed config) are satisfied for
classification's own `quality:` block (`fallback_max_percentage`,
`fallback_concentration`, etc. — `migration/guildctl/classification.ts:22-27`).
Extending the same YAML file avoids introducing a second loader/parser/validator
(`stack.yaml` already resolves exactly one `classification_spec` path per pack) and
keeps risk thresholds discoverable in the same file a stack-pack maintainer already
edits for classification tuning — directly satisfying SC-004 ("edit one configuration
file and re-run Inventory").

**Alternatives considered**:
- *New sibling `risk.yaml` + new `loadRiskSpec` loader*: rejected — would duplicate the
  load/validate/error-message plumbing `loadClassificationSpec`/`validateSpec` already
  provide, for no behavioral gain; also means editing two files instead of one for a
  related concern (SC-004 explicitly measures "one configuration file").
- *Fields directly on `stack.yaml`*: rejected — `stack.yaml` declares pack-level wiring
  (globs, audit rules file path, verify command, scaffold), not scoring tunables;
  `classification.yaml` is already the file that owns "how do we judge this artifact"
  concerns (confidence, evidence, quality gates), which risk thresholds are a natural
  extension of.
- *Hardcoded global defaults only, no per-pack override*: rejected outright by
  FR-007/User Story 2 — different stacks have different normal method-length/complexity
  baselines by design.

Built-in defaults (used when a stack pack's `risk:` block, or individual fields within
it, are absent) live as constants alongside the new risk-scanning module — mirroring
how `classification.ts` inlines its own defaults (`spec.quality?.fallback_min_confidence
?? 0.75`) rather than duplicating them per stack pack.

## 4. How risk data is persisted in the registry

**Decision**: A new table `artifact_risk_assessments`, one row per artifact (PK
`artifact_id`, FK to `artifacts(id) ON DELETE CASCADE`), structurally parallel to
`artifact_classifications` (`migration/registry_schema.sql:409-421`):

```sql
CREATE TABLE IF NOT EXISTS artifact_risk_assessments (
    artifact_id       TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
    risk_score        REAL NOT NULL CHECK (risk_score >= 0),
    high_risk         INTEGER NOT NULL DEFAULT 0 CHECK (high_risk IN (0, 1)),
    reason_codes_json TEXT NOT NULL,
    signals_json      TEXT NOT NULL,
    updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
```

`reason_codes_json` and `signals_json` are JSON-encoded string arrays, written/read
through the exact same `coerceEvidence`/`parseEvidence`-style defensive
coercion already proven in `classification.ts:236-277` (renamed for this
module but structurally identical), since reason codes are exactly the same shape of
data as classification `evidence`. `signals_json` records the raw per-heuristic
contributing values (e.g. `{"god-method":{"lines":142},"cyclomatic-complexity":{"value":22}}`)
for operator transparency/debugging, distinct from the human-readable `reason_codes_json`.

Because this is a **brand-new table**, it needs only a `CREATE TABLE IF NOT EXISTS`
block appended to the base (idempotent) section of `migration/registry_schema.sql`,
with no `ensureColumn` runtime guard required — new tables are safe to add
unconditionally, unlike new columns on an existing table (which this SQLite build
cannot add via `ADD COLUMN IF NOT EXISTS`, per `schema.ts:127-139`'s `ensureColumn`
workaround) or new CHECK-constraint values on an existing column (which require the
create-new/copy/drop/rename rebuild pattern in `schema.ts:84-125`). This feature needs
neither of those heavier migration patterns.

A second new table, `risk_confirmations`, holds the human-in-the-loop decision
(see §5) — kept separate from `artifact_risk_assessments` because the assessment is
recomputed and replaced on every re-registration (FR-015) while the confirmation
decision must survive a re-scan unless the artifact's risk status actually changes
(per the spec's edge case: "existing confirmations remain valid... only newly
scored/re-scored artifacts are judged against new thresholds"). Collapsing both
concerns into one row would make it impossible to preserve a confirmation across a
recompute without ad hoc column-level upsert logic.

**Rationale**: `artifact_classifications` is the explicit precedent the spec input
names ("alongside inventory.ts scanAndRegister and classification.ts's existing
confidence/ambiguous/evidence/signals metadata pattern"). A separate one-row-per-artifact
table with JSON array columns, upserted via `INSERT ... ON CONFLICT(artifact_id) DO
UPDATE`, is exactly that pattern, and directly satisfies FR-006 (registry-visible
without re-scanning) and FR-015 (recompute replaces, not accumulates — the `ON
CONFLICT DO UPDATE` shape makes accumulation structurally impossible, matching how
`applyBatchClassification` already behaves).

**Alternatives considered**:
- *Single JSON blob column on `artifacts`*: rejected — `artifact_classifications`
  already establishes that derived-metadata-with-arrays lives in its own table with
  JSON sub-columns, not inline on `artifacts`; deviating here would fragment the
  pattern for no benefit and make risk data harder to index/query (`idx_artifact_classifications_framework`-style
  indexes wouldn't be possible on a blob).
- *Overload `artifacts.status` with a new `needs-risk-confirmation` value*: rejected —
  requires the expensive CHECK-constraint table-rebuild migration (§4 above), and
  `blocked` already carries distinct "agent got stuck after repair attempts" semantics
  elsewhere in the codebase (`supervisor/loop.ts`, `audit.ts`'s `TERMINAL_STATUSES`);
  reusing or extending `status` would conflate two unrelated meanings. A separate
  gating table (§5) keeps `status`'s existing vocabulary untouched.

## 5. How the high-risk confirmation gate integrates with Plan/Claim

**Decision**: Two-part design combining a Plan-time interactive/auto-confirm step
(shape mirrors `confirmMappings`) with a Claim-time hard gate (mirrors nothing — this
is new, since no existing gate blocks claim eligibility for a subset of `planned`
artifacts).

1. **Confirmation table**: `risk_confirmations(artifact_id PK, decision, decided_by,
   decided_at, created_at)` with `decision CHECK (decision IN ('pending', 'confirmed',
   'declined'))`. A row is inserted with `decision='pending'` as part of the same
   transaction that upserts `artifact_risk_assessments`, whenever a freshly computed
   `risk_score` exceeds the stack pack's `high_risk_score_cutoff` and no row already
   exists for that artifact (re-registration must not reset an existing `confirmed`/
   `declined` decision unless the artifact's risk status actually changed — see the
   spec's edge case on threshold changes).
2. **Plan-phase review step**: a new function `confirmHighRiskArtifacts(db, ...)`,
   structurally identical to `confirmMappings` (`plan.ts:20-76`) — same `readline`
   interactive y/n/decline loop, same `GUILDCTL_AUTO_CONFIRM_MAPPINGS`-style env-var
   override (new: `GUILDCTL_AUTO_CONFIRM_RISK=1`) for benchmark/CI runs. Called from
   `runPlan` **after** the Planner agent phase (`plan.ts:476-507`), not before it —
   this is the one deliberate deviation from the `confirmMappings` call site.
3. **Claim-time hard gate**: `claimNextTask`'s candidate query
   (`migration/registry/commands/claim.ts:709-732`) gains one more `AND NOT EXISTS`
   clause excluding artifacts with a `risk_confirmations` row whose `decision !=
   'confirmed'`:
   ```sql
   AND NOT EXISTS (
     SELECT 1 FROM risk_confirmations rc
     WHERE rc.artifact_id = a.id AND rc.decision != 'confirmed'
   )
   ```
   `claimArtifactById` (the explicit single-owner variant, `claim.ts:463-610`) gets
   the equivalent check before its optimistic-concurrency UPDATE. Artifacts with no
   `risk_confirmations` row (never scored high-risk) are unaffected — the `NOT
   EXISTS` is vacuously true for them.

**Rationale — why the gate point differs from `confirmMappings`'s pre-planner
placement**: `confirmMappings` blocks the *entire* Planner agent phase because an
unconfirmed framework mapping makes wave assignment itself meaningless (the planner
can't sensibly plan work against a mapping nobody agreed to). Risk confirmation is
different by explicit spec design — User Story 4 states the planner should still be
able to see and order around pending high-risk work "rather than blocking the whole
run," and User Story 3's independent test expects the *below*-threshold artifact to
"proceed to planning normally" while only the *above*-threshold artifact is held back
specifically from being claimable. Blocking the whole Planner phase (as
`confirmMappings` does) would contradict User Story 4's explicit non-goal. So this
design reuses `confirmMappings`'s *shape* (interactive prompt, env-var bypass,
durable decision recording) — satisfying the spec's own instruction to follow "the
confirmMappings human-in-the-loop precedent" — while moving the actual *enforcement*
point to claim eligibility, where FR-010 ("prevent an artifact... from being claimed")
literally says the gate belongs.

This also directly satisfies FR-012 (no silent unattended bypass) without contradicting
US4: an automated run with `GUILDCTL_AUTO_CONFIRM_RISK` unset simply leaves high-risk
artifacts in `pending` — they are never claimed (claim-gate gets them, unconditionally,
with no code path around it), which is a stronger guarantee than a prompt that could in
principle be misconfigured to auto-answer. The Plan-phase step becomes a *convenience*
surfacing point (shows operators what's pending, offers to resolve it interactively or
via the explicit override), not the sole enforcement mechanism — consistent with
Principle VI (Fail-Closed Automation: "continues independent work after one artifact
blocks... halt on systemic errors," not "block everything").

**Alternatives considered**:
- *Mirror `confirmMappings` exactly, blocking Planner phase*: rejected — directly
  contradicts User Story 4's stated non-goal ("rather than blocking the whole run") and
  User Story 3 AC5 (below-threshold artifacts proceed through planning "with no
  additional confirmation step" — implying the confirmation step is scoped to specific
  artifacts, not a phase-wide gate).
- *Enforce only via the Plan-phase prompt, no claim-time check*: rejected — FR-010's
  language ("prevent... from being claimed") specifically targets the claim boundary,
  and a Plan-only gate could be bypassed by any future or existing caller of
  `claimNextTask`/`claimArtifactById` that doesn't route through `runPlan` first
  (e.g. a direct `registry claim` CLI invocation, or auto-run resuming after an
  interrupted plan phase) — Principle III requires claim atomicity/correctness to hold
  regardless of caller, not just through one code path.

## 6. Reason-code vocabulary

**Decision**: A fixed, documented set of reason-code prefixes, each carrying enough
detail (construct name, location) for an operator to act on it per the spec's edge
case on avoiding "flooding every artifact with false positives":
- `reflection-usage:<pattern-id>` — e.g. `reflection-usage:java-class-forName`
- `god-method:<method-name-or-line>` — e.g. `god-method:processOrder@L142 (187 lines > 80)`
- `cyclomatic-complexity:<method-name-or-line>` — e.g. `cyclomatic-complexity:processOrder@L142 (complexity 22 > 15)`
- `heuristic-skipped:<heuristic-name>` — recorded when a heuristic couldn't evaluate
  (unparseable/unsupported syntax), per the spec's edge case; contributes zero score.

**Rationale**: Directly satisfies FR-002/FR-003/FR-004 (each heuristic gets its own
reason code) and FR-016 (skipped heuristics get an explicit code, never silent
omission), while the `<detail>` suffix satisfies the edge case requiring codes
"specific enough... that an operator can judge relevance."

## 7. Score-combination formula (FR-005: documented, deterministic)

**Decision**: A simple, documented weighted sum, normalized and clamped to `[0, 100]`:

```
score = min(100,
    (reflection_hits > 0 ? 30 : 0)
  + min(35, max(0, method_lines - god_method_max_lines) * 0.5)
  + min(35, max(0, complexity_value - cyclomatic_complexity_limit) * 2)
)
```

Each contributing term is capped independently so no single heuristic alone can
saturate the score past its own weight share, and the overall score is capped at 100.
`high_risk = score > high_risk_score_cutoff`. Exact weight constants are implementation
detail to finalize in `tasks.md`/implementation, but the *shape* (bounded weighted sum
of heuristic overages, each independently capped, deterministic given the same source
+ config) is the Phase-1 decision, satisfying FR-005's "documented, deterministic
method" requirement and making SC-002's 95%-accuracy bar tunable via the weight
constants and stack-pack thresholds without changing the formula's structure.

**Rationale**: A documented deterministic formula, versus e.g. an LLM-scored or
opaque ML-derived score, is required by FR-005 and is consistent with Principle I
(Evidence Over Assertion) — the score must be reproducible and auditable from the
same inputs, not a black box. Weighted-sum-of-overages is the simplest formula that
satisfies "combine individual signal detections into a single overall risk score"
while keeping each heuristic's contribution independently inspectable via
`signals_json` (§4).

**Alternatives considered**:
- *Max of the three signals rather than a sum*: rejected — would hide compounding risk
  (an artifact that is both a God method *and* reflection-heavy is plausibly riskier
  than either alone) and produce far more score ties, weakening the planner-ordering
  use case (User Story 4).
- *Unbounded sum*: rejected — a single pathological method (e.g. 2000 lines) would
  dominate the score to the point of drowning out multi-signal artifacts, and
  unbounded scores complicate `high_risk_score_cutoff` tuning across stack packs of
  very different typical file sizes.
