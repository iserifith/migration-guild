# Research: Rejection Reason Envelope

No open `NEEDS CLARIFICATION` markers remain from Technical Context — all decisions below were resolved directly against verified source during specification (see spec.md's checklist Notes) and the `/speckit-clarify` session. This file records the resulting decisions for traceability into Phase 1 design.

## Decision: Reserved context slot for the rejection envelope

**Decision**: Store the rejection reason under a reserved `agent` value in the existing `agent_context` table/file layout (`migration/artifacts/<slug>/context/<agent>.md`) — e.g. `rejection-envelope` — rather than inside any real contributing agent's slot (`remediation-agent`, `context-agent`, etc.) or as a new column/table.

**Rationale**: `agent_context` is already keyed `UNIQUE(artifact_id, agent)` with upsert semantics (`ON CONFLICT (artifact_id, agent) DO UPDATE`), confirmed in `migration/registry/commands/context.ts`. Reusing an existing real agent's slot would silently clobber that agent's genuine analysis on the next rejection (violates spec FR-003). A reserved, dedicated `agent` value gets the existing non-clobbering guarantee for free — it's a distinct row — and requires no schema change. It is trivially distinguishable on read: the caller asks for context under a known, documented key.

**Alternatives considered**:
- *Delimited section within an existing agent's file* (e.g. append a "## Rejection Reason" section to `remediation-agent.md`). Rejected: `agent_context` has no concept of appending to or sectioning an existing file — `writeContext` fully replaces the destination file's content and re-extracts a single `## Summary`; layering a second convention on top of that would require parsing/merging logic the current store doesn't have, for no benefit over a separate key.
- *New `rejection_envelope` table*. Rejected by the feature's own explicit scope boundary (spec Assumptions: "no new database table"; proposal: "not a new transport/subsystem").

## Decision: Envelope write path bypasses `writeContext`'s file-argument contract

**Decision**: `recordApprovalDecision` will not call the existing `writeContext(db, id, agent, filePath)` as-is, because that function requires an already-existing source file containing a `## Summary` heading (`extractSummary` throws `RegistryError` otherwise). Instead, the rejection-envelope write derives the file content directly from the reason string (synthesizing a minimal `## Summary` section) and performs the same two effects `writeContext` performs — copy/write the file to `migration/artifacts/<slug>/context/<agent>.md` and upsert the `agent_context` row — either by writing a small temp file and delegating to `writeContext`, or via a narrow sibling helper in `context.ts` that both `writeContext` and the new call share for the row-upsert logic.

**Rationale**: Reason text comes from the operator's rejection call (`opts.reason` in `RecordApprovalDecisionOptions`), not from a pre-existing file on disk. Forcing a temp-file round trip through the public CLI-oriented `writeContext` contract is possible but adds an unnecessary filesystem hop inside a DB transaction context; a small shared internal helper (`writeContextContent(db, id, agent, content)` used by both `writeContext` after it reads `filePath` and by the new rejection path) keeps the single source of truth for the row-upsert while avoiding a synthetic file requirement. Exact implementation shape is a task-level decision; both approaches satisfy FR-001/FR-002/FR-003/FR-009 identically from the outside.

**Alternatives considered**:
- *Write a real temp file and call `writeContext` unchanged*. Viable, slightly wasteful (extra fs write/read), kept as fallback if refactoring `context.ts` internals proves riskier than expected during implementation.

## Decision: Attach point is `remediation-agent` only for v1

**Decision**: The read/carry-forward step is added to `package/agents/remediation-agent.agent.md` (its existing Procedure step 4 option B, "Send back one step"), not to `package/agents/migration-agent.agent.md`.

**Rationale**: Verified that `remediation-agent` already triggers on `needs-rework` artifacts and already performs the exact registry calls (`set-artifact-status --status planned`, `append-event`) that are the natural place to fold in the rejection reason's content. `migration-agent` (the agent that performs the actual next migrate attempt) has no context-reading step today and claiming/attempting is its hot loop; adding a context read to every claim was assessed as materially larger in scope than the proposal's stated "small, additive change" and was explicitly deferred as a stretch goal during `/speckit-clarify`.

**Alternatives considered**:
- *Also modify `migration-agent.agent.md` to read context before every attempt*. Deferred — out of v1 scope per clarification answer; the reason is still available in `agent_context` for a future extension to pick up without any rework of this feature's write side.

## Decision: Fail-open write, fail-closed decision

**Decision**: The envelope write inside `recordApprovalDecision` must not be allowed to fail the rejection itself.

**Rationale**: Directly precedented in this codebase — `commitPromotedArtifact` in `migration/registry/commands/evidence.ts` wraps its git-commit side effect in `try { ... } catch { /* fail open */ }` with an explicit doc comment explaining that a report/side-effect failure must not turn a successful approval into a crash. This feature applies the identical pattern symmetrically to rejection: the `approval_decisions` insert and the `needs-rework` status transition are the safety-critical, evidence-bearing effects (Constitution I/VI) and must remain fail-closed; the envelope write is a best-effort relay and is the only fail-open piece (spec FR-008).

**Alternatives considered**:
- *Make the envelope write part of the same atomic transaction, failing the rejection if it fails*. Rejected: turns a filesystem hiccup (e.g. a full disk, a permissions issue in `migration/artifacts/`) into an inability to record a human rejection decision at all, which is a worse failure mode than an operator's rejection reason simply not being relayed this one time — and contradicts the existing fail-open precedent for this exact class of side effect.

## Decision: No expiry / consumed-marking

**Decision**: The envelope has no TTL, no "consumed" flag, and no automatic clearing after remediation reads it.

**Rationale**: Confirmed via `/speckit-clarify` — the store's existing last-write-wins semantics are inherited as-is. Adding consumption-tracking would require new state (a new column, or repurposing `updated_at` with a "read at" comparison) for a scenario (an artifact re-entering `needs-rework` through an unrelated path, re-surfacing a stale reason) assessed as a low-impact, acceptable tradeoff rather than a defect worth new mechanism.

**Alternatives considered**:
- *Add a `consumed_at` marker, cleared/reset per rejection*. Deferred — no requirement currently depends on it; would expand scope beyond the "thin envelope" framing in the proposal.
