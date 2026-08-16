# Phase 0 Research: Planner-Emitted Dependency Disposition Records

**Feature**: `006-dependency-disposition` | **Date**: 2026-08-16

This document resolves the technical unknowns needed before design (Phase 1). Each
decision is grounded in an existing pattern already present in the repository, per
the spec's precedent references (`approveDependencyStrategy` in
`migration/registry/commands/modernization.ts`, `confirmMappings` /
`confirmHighRiskArtifacts` in `migration/guildctl/commands/plan.ts`, planning
readiness gating in `migration/guildctl/readiness.ts`) and the constitution's
registry-mediation principle (III).

## 1. Relationship to the existing dependency_findings / dependency_strategies machinery

**Decision**: Add a NEW pair of tables (`dependency_dispositions`,
`dependency_disposition_history`) and a new commands module
(`migration/registry/commands/dispositions.ts`) rather than extending
`dependency_strategies` with new CHECK values or repurposing `dependency_findings`.

**Rationale**: The existing machinery is *per-artifact, per-risk-finding*: a row in
`dependency_findings` exists only when the audit pass flagged a dependency as
outdated/EOL/incompatible for one artifact, and `dependency_strategies` answers
"how do we modernize this risky finding" with upgrade/replace/remove. This feature
is *per-library, workspace-wide*: EVERY third-party library in scope gets a
disposition — including perfectly healthy libraries that merely need a keep/lock
decision — with a different vocabulary (keep / replace-with-native / inline).
Widening `dependency_strategies.strategy`'s CHECK constraint would force a table
rebuild migration (SQLite cannot widen CHECKs via ALTER — see
`ensureCharacterizationFixtureEvidenceType` in `migration/registry/db/schema.ts`
for the rebuild dance that would be needed), would couple the new vocabulary to
finding rows that only exist for flagged dependencies, and would blur the semantic
difference between "remediation plan for a risky finding" and "disposition decision
for every library." A separate table with its own vocabulary keeps both contracts
honest. The two remain complementary: a library whose disposition is `keep` may
still carry dependency findings requiring an approved upgrade strategy.

**Alternatives considered**:
- *Extend `dependency_strategies.strategy` CHECK to include keep/replace-with-native/inline*:
  rejected — requires a table-rebuild migration, ties dispositions to risk findings
  (healthy libraries have no finding to hang a strategy on), and overloads two
  different decisions in one column.
- *Add rows to `dependency_findings` for every library (including healthy ones)*:
  rejected — `dependency_findings.category` is CHECK-constrained to
  ('outdated','eol','incompatible'); healthy libraries fit none of these, and
  polluting the findings stream would break the readiness gate's
  "unresolved findings" semantics (readiness.ts:48).
- *Store dispositions in `operator_state` as a JSON blob*: rejected — violates
  Principle III's "all migration state lives in first-class registry tables";
  operator_state is for small key/value operator guidance (`setNext`), not
  queryable per-library records.

## 2. Where disposition scanning hooks into the Plan phase

**Decision**: A deterministic registry-side collection pass runs FIRST (inside
`runPlan` in `migration/guildctl/commands/plan.ts`, immediately after the
dependency-readiness gate at ~line 552 and before the Phase 2b Planner spawn at
~line 554), upserting one *proposed* disposition row per library discovered from
dependency findings (aggregated by `dependency_name`). The planner-agent prompt is
then extended to instruct the agent to review those proposals and refine them via a
new registry CLI command (`propose-disposition`) using AST-level usage evidence
(imports/usage across the in-scope artifacts' source). After the Planner phase, a
confirmation step (`confirmDispositions`, mirroring `confirmMappings` /
`confirmHighRiskArtifacts`) surfaces pending proposals for operator confirmation.

**Rationale**: This mirrors the two-phase shape already proven for stack mappings:
deterministic groundwork + agent refinement + human confirmation gate
(`plan.ts` Phase 2a stack-advisor → `confirmMappings`). Collecting the library
universe deterministically first means "every library gets exactly one record"
(FR-001, SC-001) does not depend on agent diligence — the agent refines proposals
but cannot omit libraries, because the registry-side pass already wrote a row per
library (default proposal, marked `proposed_by='planner-collector'`, with a
scan-limitation note where no usage evidence was found, satisfying FR-012).
Running the scan before the Planner spawn (not after) means the planner agent can
consume and refine proposals in the same run rather than needing a second spawn.

**Alternatives considered**:
- *Planner agent emits the full disposition set from scratch*: rejected — SC-001
  ("100% of libraries have exactly one record") would rest entirely on agent
  self-report, which Principle I forbids; the deterministic collector makes
  completeness a registry-verifiable invariant (like `verifyPlannerInvariant` for
  wave assignment).
- *A new guildctl phase between plan and migrate*: rejected — the issue scopes
  this to "During the Plan phase"; a new phase would ripple through
  auto-run/supervisor cadence for no benefit.
- *Hook into inventory*: rejected — dispositions depend on target-stack knowledge
  (stack mappings confirmed during Plan) and operator policy; inventory is
  target-stack-agnostic today.

## 3. Library universe source: where the per-library list comes from

**Decision**: The collector derives the library universe from `dependency_findings`
(grouped by `dependency_name`, taking MAX(current_version) as the current version)
PLUS a manifest-declared library set, where manifests are discoverable
(`pom.xml`/`build.gradle*` under the workspace's in-scope module roots for the
java-spring stack; stack packs MAY declare a `dependencies.manifest_globs` list —
see §6). In v1, manifest parsing is a best-effort, regex-level extraction of
declared coordinates — not a full Maven/Gradle model — and unparseable sections
produce rows carrying a `scan_notes` limitation (FR-012) rather than failing the
run.

**Rationale**: `dependency_findings` only covers libraries the audit flagged;
FR-001 requires EVERY third-party library. Manifests are the authoritative
declaration of the third-party set. AST/import scanning alone cannot see declared-
but-unused libraries (an edge case the spec explicitly requires a record for).
Regex-level manifest extraction matches the repository's existing heuristic idiom
(`migration/guildctl/audit.ts` `collectLineMatches`, `classification.ts`'s
signal matching) and introduces no new npm dependency — a hard constraint
established by feature 005's research and the maintainer checklist.

**Alternatives considered**:
- *Full Maven/Gradle model resolution (e.g., invoking `mvn dependency:list`)*:
  rejected — requires the legacy build toolchain to be installed and runnable in
  the operator's environment, is slow, and violates the kit's "agent + registry +
  heuristics" posture; recorded as possible future enhancement in the rationale.
- *Import-scan-only universe*: rejected — misses dead declarations (spec edge
  case #1 requires them to receive dispositions).

## 4. AST-level usage evidence: what it means in v1

**Decision**: "AST-level scan" is implemented as import/usage analysis over each
in-scope artifact's source text: for each library, map its known package/group
prefixes (from stack-pack knowledge, e.g. `org.apache.commons.lang3` for
commons-lang3) to import statements and qualified references found in registered
source files (the same read-only `fs.readFileSync` pattern used by
`classifyArtifactSource` and the risk scanner). The output is a per-library
*used-surface summary*: using artifact count, using artifact ids (capped), and
import frequency — stored on the disposition row as `usage_json`. The planner agent
consumes this summary when refining proposals. No code transformation occurs
(FR-013).

**Rationale**: Spec assumption ("AST-level scan is interpreted as ... imports/usage
analysis ... it does NOT transform code") explicitly licenses this. A real parser
per language would need new dependencies per stack, violating the no-new-dependency
constraint; import analysis is exactly what the existing `source_dependencies`
machinery does for file-to-file imports (`signal='import'` in
`migration/registry_schema.sql:90`), so the idiom is established.

**Alternatives considered**:
- *Full AST via tree-sitter/javaparser*: rejected — new native dependency,
  contradicts feature 005's research outcome (regex heuristics chosen over AST
  libraries for the same reasons).
- *LLM-only usage judgment with no stored evidence*: rejected — Principle I;
  the usage summary must be a registry row (`usage_json`) so confirmation and
  downstream consumers can inspect the evidence, not the agent's claim.

## 5. Confirmation UX and auto-approve path

**Decision**: Reuse the `confirmMappings` / `confirmHighRiskArtifacts` shape
exactly: a `confirmDispositions(db)` function in `plan.ts`, called AFTER the
Phase 2b Planner phase (adjacent to `confirmHighRiskArtifacts`, plan.ts:591),
with: (a) interactive TTY readline loop offering confirm / skip / **override**
(y/n/e — `e` lets the operator change disposition kind and target, recording the
override rationale); (b) `GUILDCTL_AUTO_CONFIRM_DISPOSITIONS=1` env-var bulk
confirm as `benchmark-runner`, mirroring `GUILDCTL_AUTO_CONFIRM_MAPPINGS`,
`GUILDCTL_AUTO_CONFIRM_RISK`, and `GUILDCTL_AUTO_APPROVE_DEPENDENCIES`; (c)
non-interactive stdin with the env var unset: leave rows pending, print the
silence-first warning, and let planning-readiness gating (§7) block full sign-off
— the process does not hang (FR-006).

Override semantics (spec US2 scenario 2): the operator's chosen disposition kind,
target, and rationale REPLACE the proposal on the same row; `confirmed_by` records
the operator; the prior proposal is preserved by copying the row into
`dependency_disposition_history` before update (§8).

**Rationale**: The issue explicitly names the `approveDependencyStrategy` /
`confirmMappings` precedents; spec FR-005 requires "modeled on the existing
mapping-confirmation and dependency-strategy-approval precedents." Three
near-identical confirmation loops already exist in `plan.ts`; a fourth following
the same shape is the lowest-surprise, lowest-risk option and keeps the operator
UX uniform.

**Alternatives considered**:
- *CLI-only confirmation (`approve-disposition` command, no interactive loop)*:
  rejected — breaks UX parity with mappings/risk confirmation and would make the
  Plan-phase interactive path strictly worse for the common case.
- *Fold dispositions into the existing `GUILDCTL_AUTO_APPROVE_DEPENDENCIES` flag*:
  rejected — different decision, different audit trail; the spec requires an
  identifiable automated actor for disposition auto-approval specifically
  (FR-006). A separate flag keeps benchmark runs explicit about which gates they
  bypass.

## 6. Stack-pack knowledge: native equivalents and library identity mapping

**Decision**: Stack packs gain an OPTIONAL `dependencies:` block in their pack
YAML (a sibling of `classification.yaml` or a block within it — decided as a block
within `classification.yaml`'s loader family, parsed by a new small loader in
`migration/guildctl/dispositions.ts` reusing the existing YAML loader), declaring:
- `manifest_globs`: where to find build manifests (e.g. `**/pom.xml`,
  `**/build.gradle`, `**/build.gradle.kts`);
- `library_prefixes`: map from library coordinate → import/package prefixes used
  for usage scanning (e.g. `commons-lang3` → `org.apache.commons.lang3`);
- `native_equivalents`: advisory map from well-known libraries → platform
  replacements (e.g. `guava:com.google.common.base.Optional` →
  `java.util.Optional`, `commons-lang3 StringUtils` → `java.lang.String` /
  `java.util.Objects`, `joda-time` → `java.time`) used to seed
  replace-with-native proposals.
All three are optional; a pack without the block degrades gracefully to
findings-derived library universe + keep-default proposals (fail-closed toward
"keep", never toward silent pruning — spec edge case #2).

**Rationale**: Principle VII — stack-specific knowledge MUST live in stack packs,
not core runtime. The disposition *engine* (tables, collector, confirmation,
gating, locked-set view) is stack-neutral; only the library knowledge is per-stack.
The java-spring pack ships an initial block; the python pack can follow with
stdlib equivalents — v1 scope only requires java-spring content since the issue
targets Java 17/21 equivalents.

**Alternatives considered**:
- *Hardcode a Java native-equivalents table in core runtime*: rejected — direct
  Principle VII violation.
- *LLM-proposed equivalents with no pack knowledge*: rejected for seeding (kept
  as refinement): the planner agent may still refine proposals beyond the pack's
  advisory map, but the deterministic seed means even an agent that does nothing
  leaves a sane, confirmable proposal set.

## 7. Readiness gating: how unresolved dispositions block planning sign-off

**Decision**: Extend `PlanningReadiness` in `migration/guildctl/readiness.ts`
with `unconfirmedDispositions` and extend `formatPlanningBlockMessage` with a
disposition branch, mirroring the existing `unresolvedDependencyFindings` branch.
The Plan command enforces it as a blocking gate (like scope/JVM/dependency gates)
BUT with one deliberate difference per FR-007 "allowing independent confirmed work
to proceed": the gate blocks only while *any* disposition is still in
`proposed` state at the END of the Plan run (after `confirmDispositions` has had
its chance). Within a run, confirmation happens at its scheduled step; pending
rows never block wave assignment mid-run (mirroring research.md §5 of feature
005: high-risk confirmation deliberately does not block the Planner).

**Rationale**: FR-007 requires unresolved dispositions to surface as readiness
items "consistent with existing unresolved dependency-finding gating" — that is
exactly the `formatPlanningBlockMessage` mechanism with `setNext` guidance.
Placing enforcement at the end of `runPlan` (after confirmation, with the
auto-confirm escape) matches how the dependency-strategy gate is enforced before
the Planner today (plan.ts:534-552), just relocated to post-confirmation for
this new artifact type.

**Alternatives considered**:
- *Block the Planner before spawn when prior confirmed dispositions are stale*:
  rejected — re-runs must re-confirm only CHANGED proposals (FR-011); blocking
  wave assignment for unrelated re-planning work would be the failure mode
  feature 005 explicitly avoided.
- *Claim-boundary enforcement (like risk_confirmations)*: rejected — dispositions
  gate *planning sign-off*, not artifact claimability; the claim boundary is the
  wrong seam for a per-library planning artifact.

## 8. Re-run semantics: supersession without silent overwrite

**Decision**: Every mutation of a disposition row (proposal refinement,
confirmation, override) first copies the current row into
`dependency_disposition_history` (an append-only audit table, same shape as the
live row plus `history_id`, `change_kind`, `change_actor`, `superseded_at` —
snapshot carried as JSON). The live table keeps exactly one row per library
(`library_name UNIQUE`), satisfying SC-001 with a trivial hot query.

Re-run semantics (FR-011): the collector upserts proposal fields ONLY on rows
still in `proposed` status; it never modifies `confirmed` rows. When a re-run's
new evidence would change a CONFIRMED row's disposition kind or target, the
collector does not touch the live row; instead it records the pending change on
the SAME live row in a dedicated pending-reproposal column group
(`pending_disposition`, `pending_native_replacement`, `pending_inline_note`,
`pending_locked_target_version`, `pending_rationale`, `pending_proposed_by`,
`pending_at`) — the confirmed decision stays in effect in the primary columns
until an operator confirms the pending proposal, at which point the pending
values are folded into the primary columns (and the prior state snapshotted to
history). A row with `pending_disposition IS NOT NULL` counts as unresolved for
readiness gating (§7) even though it has a confirmed current decision.

**Rationale**: FR-011 demands the previously confirmed record remain in effect
until a new confirmation replaces it. A single live row per library with an
explicit pending-proposal column group is the simplest model that satisfies both
that and SC-001's "exactly one current record per library" — no self-joins, no
partial unique indexes (which this SQLite build's existing schema idiom avoids),
and the "current decision" read is always the primary columns. The history table
mirrors the repository's existing audit-trail posture (`audit_overrides`,
`scope_decisions` — decisions are never silently lost).

**Alternatives considered**:
- *Version-number column on one row*: rejected — "exactly one current record per
  library" queries become MAX(version) self-joins; the two-table live/history
  split keeps the hot query trivial (SC-004: locked-set query under 5s for 500
  libraries — a single indexed scan).
- *Reject re-proposals once confirmed*: rejected — FR-011 explicitly requires
  changed proposals to surface for re-confirmation.

## 9. Locked dependency set view and version locking

**Decision**: A registry query function `getLockedDependencySet(db)` (and CLI
`locked-dependency-set`) returns a deterministic, sorted view: one entry per
library with its current disposition — keeps carry `locked_target_version`;
replace-with-native carries `native_replacement`; inline carries `inline_note`.
Version locking for keeps: the collector resolves the locked version as the MAX
current version observed across findings/manifests; if conflicting target
versions are proposed (manifests disagree or findings' target_hints disagree),
the conflict and the chosen resolution are recorded in the rationale (FR-008,
spec edge case #5). v1 does NOT resolve versions from remote repositories — the
lock is over locally observed version evidence; remote resolution is downstream
work for the doc-RAG feature, which consumes this set unchanged (FR-009).

**Rationale**: FR-008 requires "a single locked target version per kept library"
with conflicts recorded — local MAX-plus-rationale is deterministic, offline, and
honest about its evidence. SC-005 only requires every kept entry to carry *a*
resolved locked version; it does not require remote-repo verification.

**Alternatives considered**:
- *Query Maven Central/npm for latest compatible versions at Plan time*: rejected —
  network dependency in a planning gate (Principle VI: preflight must fail
  closed; a flaky network must not strand planning), and out of the issue's v1
  scope.

## 10. Migration-agent context surfacing (FR-010)

**Decision**: The locked disposition set is injected into migration agents' prompts
via the existing `agent_context`/`writeContext` seam is NOT used; instead, v1 adds
a small deterministic helper `dispositionContextForArtifact(db, artifactId)` in
`migration/registry/commands/dispositions.ts` that returns the confirmed
dispositions for libraries used by that artifact (join via `usage_json` /
dependency findings), formatted as prompt text ("do not re-declare library X; use
native Y"). The migrate command's code-writer pool prompt construction
(`migration/guildctl/commands/migrate.ts` ~line 201-206, `codePrompt`) appends
this text per spawned session when dispositions exist. This is the minimal wiring
satisfying FR-010; richer per-artifact context injection is downstream work.

**Rationale**: The migrate pool spawns agents with short fixed prompts today;
appending a deterministic registry-derived suffix is the same pattern already used
for stack instructions (`readStackInstruction(pack, "tests")` in testPrompt).
No new context channel is invented (Principle III: the registry is the source;
the prompt is a projection of registry state).

**Alternatives considered**:
- *Write per-artifact context files via writeContext*: rejected — writeContext is
  for agent-authored analysis context; machine-generated disposition context would
  collide with the `(artifact_id, agent)` conflict key and overwrite real analysis
  context.
- *Agents query the registry themselves*: rejected as sole mechanism — code-writer
  agents already run with registry access and MAY query; the prompt suffix
  guarantees the signal reaches the agent even when it doesn't think to query.

## Resolved unknowns summary

No NEEDS CLARIFICATION items remain. Key locked decisions:

| # | Decision | Primary artifact |
|---|---|---|
| 1 | New table pair, new commands module — no dependency_strategies widening | contracts/registry-schema.md |
| 2 | Deterministic collector pre-Planner; agent refines; confirmation post-Planner | plan.ts |
| 3 | Universe = dependency_findings ∪ manifest declarations (regex-level) | dispositions.ts |
| 4 | AST-level = import/usage analysis, stored as usage_json | dispositions.ts |
| 5 | confirmMappings-shaped confirmation + GUILDCTL_AUTO_CONFIRM_DISPOSITIONS | plan.ts, cli-surface.md |
| 6 | Optional dependencies: block in stack packs (java-spring ships content) | contracts/disposition-pack-yaml.md |
| 7 | Readiness gate extension, enforced end-of-Plan | readiness.ts |
| 8 | Live/history two-table supersession, one current row per library | data-model.md |
| 9 | Local-evidence version lock; getLockedDependencySet view | dispositions.ts |
| 10 | codePrompt suffix via dispositionContextForArtifact | migrate.ts |
