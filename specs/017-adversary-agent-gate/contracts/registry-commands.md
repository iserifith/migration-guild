# Phase 1 Contracts: Registry Commands and Agent Procedure Surface

This feature's external interfaces are (a) an addition to the existing `approveArtifactWithEvidence` registry function's below-cutoff and gate-bound branches (`migration/registry/commands/evidence.ts`), (b) a new pair of envelope helpers in `migration/registry/commands/context.ts` mirroring #216's `writeRejectionEnvelope`/`getRejectionEnvelope`, (c) a new pipeline procedure document (`package/agents/adversary-agent.agent.md`), and (d) a second read step in `remediation-agent.agent.md`. No new CLI subcommand is introduced — the existing `get-context`/`append-event`/`set-artifact-status` surface is reused, matching #216's contract shape.

## Registry command contract: `registry/commands/context.ts` (modified)

### `writeAdversaryEnvelope(db, artifactId, finding): void` (new, internal)

```ts
function writeAdversaryEnvelope(
  db: Database.Database,
  artifactId: string,
  finding: string,
): void;
```

- Writes `finding` (verbatim, FR-016) to `migration/artifacts/<slug>/context/adversary-envelope.md` under a synthesized `## Summary` section, and upserts the corresponding `agent_context` row with `agent = "adversary-envelope"` (the reserved key from research.md / data-model.md), reusing the same row-upsert logic `writeContext` and #216's `writeRejectionEnvelope` already use internally.
- MUST NOT touch any `agent_context` row for any other `agent` value on the same artifact, including `rejection-envelope` (FR-009).
- Idempotent per call: a later adversary-agent run on the same artifact upserts (overwrites) this same row — "most recent finding wins," matching #216's precedent.
- Not exported from the module's public CLI-facing surface; a helper used only by the routing call site inside `evidence.ts`. (If implementation finds it cleaner to expose a small public variant, it MUST NOT replace or change the signature of the existing public `writeContext(db, id, agent, filePath)` or #216's `writeRejectionEnvelope`.)
- Used for both the violation-found and probe-inconclusive cases (FR-004, FR-008a) — the caller supplies different `finding` text; the write path itself does not distinguish them.

### `getAdversaryEnvelope(db, artifactId): { finding: string } | null` (new, or equivalent thin wrapper over `getContext`)

```ts
function getAdversaryEnvelope(
  db: Database.Database,
  artifactId: string,
): { finding: string } | null;
```

- Equivalent to calling `getContext(db, artifactId, "adversary-envelope")` and returning `null` when the response `form` is `"none"`, or the extracted text otherwise (FR-010).
- Pure read; no side effects; safe to call for any artifact, including one the adversary-agent never flagged (returns `null`, not an error — FR-013).
- Reserved key `"adversary-envelope"` MUST be the single source of truth for both the write and read sides (e.g. a shared exported constant, following #216's own recommendation for its `"rejection-envelope"` key) so the two never drift.

## Registry command contract: `registry/commands/evidence.ts` (modified)

### `approveArtifactWithEvidence(db, opts): ArbitrationDecision` — additional checkpoint

Signature and return type are **unchanged**. This feature inserts the adversary-agent checkpoint into the existing transaction, at two points:

```ts
// Inside approveArtifactWithEvidence's transaction, after arbitration-approved
// is recorded and gateScope is resolved:

if (gateScope.inScope) {
  // existing pending-approval hold, unchanged —
  // PLUS: on a clean adversary-agent probe already run for this cycle,
  // append an "adversary-probe-passed" event (FR-008b) so the human
  // operator's context at the gate reflects it. This event carries no
  // agent_context write and does not alter targetStatus.
  ...
} else {
  // the below-cutoff branch that today falls straight to "reviewed":
  // the adversary-agent checkpoint gates this transition (FR-001, FR-006).
  //   - clean probe: proceed exactly as today (FR-003) — no new record.
  //   - violation or inconclusive probe: write the adversary-envelope
  //     (writeAdversaryEnvelope, fail-open per FR-015) and route to
  //     needs-rework via the same setArtifactStatus/appendEvent primitives
  //     rejectArtifactWithEvidence already uses, instead of "reviewed".
}
```

**Contract**:
- MUST NOT alter `approveArtifactWithEvidence`'s existing preconditions (`canApproveArtifact`, evidence freshness, independence checks), transaction boundaries, return value shape, or thrown-error conditions for the cases this feature does not touch.
- MUST run the adversary-agent checkpoint for every artifact passing through this function, gate-bound or not (FR-006) — the branch taken on a violation differs (`needs-rework` either way) but the checkpoint itself is unconditional.
- MUST NOT allow an `adversary-envelope` write failure to propagate out of `approveArtifactWithEvidence` or prevent the `needs-rework` transition (FR-015).
- MUST NOT let a clean gate-bound probe (`adversary-probe-passed`) alter `targetStatus`, satisfy any evidence/arbitration precondition, or be selectable as approval evidence (FR-008b, Constitution Principle I).

*Exact call-site wiring (whether the adversary-agent's probe result arrives as an `opts` field, a separate prior registry call whose result this function reads, or another shape) is left to task-level design — this contract fixes the observable behavior (FR-001–FR-006, FR-008a, FR-008b, FR-015), not the internal signature.*

## CLI / procedure contract: `package/agents/adversary-agent.agent.md` (new)

A new pipeline procedure document, modeled on `review-agent.agent.md`'s existing structure (workspace-shape guidance, a narrow procedure, an output-format contract), scoped per FR-002: given an artifact and the stack's configured verify command, construct one input/test case that passes the existing suite but violates spec intent, then record the outcome via the existing CLI surface:

```bash
# On a clean probe: no action (FR-003) — nothing to run.

# On a violation or inconclusive probe: the routing/envelope write happens
# inside approveArtifactWithEvidence per the contract above, not via a
# separate adversary-agent-invoked CLI mutation — this keeps the checkpoint
# structurally unskippable (research.md "Decision: Insertion point").
# adversary-agent's own output is the finding text handed to that call site.
```

*Exact invocation mechanics (how the adversary-agent's finding text reaches the `approveArtifactWithEvidence` call site — e.g. a registry call the agent makes before arbitration proceeds, versus a value the arbitration flow reads back from a prior adversary-agent CLI invocation) are left to task-level design; this contract fixes only that no second, separately-triggered gate is introduced (FR-014).*

## CLI / procedure contract: `package/agents/remediation-agent.agent.md` (modified)

No new CLI subcommand. The existing `get-context` command (already reused by #216 for `rejection-envelope`) is reused a second time:

```bash
node migration/registry/dist/cli.js get-context --id "<id>" --agent rejection-envelope
node migration/registry/dist/cli.js get-context --id "<id>" --agent adversary-envelope
```

- Returns the stored finding (`form: "file"` or `form: "summary"`) when one exists, or the existing `form: "none"` fallback when it does not (FR-013) — no new response shape, no new error mode.
- **Contract on the procedure document**: before executing recovery action **B (Send back one step)** for a `needs-rework` artifact, `remediation-agent.agent.md` MUST run both `get-context` calls above and, for each that returns a reason/finding, include it — distinguishably labeled by origin — in the `--reason`/`--summary` text passed to the existing `set-artifact-status --status planned` and `append-event --type remediated` calls (FR-011, FR-012). When neither returns a result, the existing reason/summary text is used unchanged (FR-013).
