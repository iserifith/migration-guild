# Data Model: Rejection Reason Envelope

No new tables. This feature reuses the existing `agent_context` table (defined via `migration/registry/commands/context.ts` and the registry schema it targets) with a reserved key convention layered on top.

## Rejection Envelope Entry (conceptual entity — not a new table)

Represented as one row of the existing `agent_context` table, distinguished only by its `agent` value.

| Field | Source | Notes |
|---|---|---|
| `artifact_id` | Existing `agent_context.artifact_id` | The rejected artifact. |
| `agent` | Existing `agent_context.agent`, fixed reserved value (e.g. `rejection-envelope`) | Never used by a real context-writing agent; this is what makes the entry distinguishable per FR-002. Exact literal is a naming decision for tasks/implementation, not a new column. |
| `file_path` | Existing `agent_context.file_path` | Points at `migration/artifacts/<slug>/context/rejection-envelope.md`, following the same canonical layout `getContext`'s step-3 fallback already rebuilds from `idToSlug(id)`. |
| `summary` | Existing `agent_context.summary` | The operator's rejection reason text, verbatim (FR-009), stored as the extracted `## Summary` body — same shape every other `agent_context` row already has. |
| `updated_at` | Existing `agent_context.updated_at` | Upserted on every new rejection; this is what gives "most recent rejection reason" (FR-004) for free — a second rejection's write simply upserts this same row. |

**Relationships**: One rejection-envelope row per artifact (0 or 1), independent of and never overwriting any other `(artifact_id, agent)` row for the same artifact (FR-003) because it lives under its own reserved `agent` key. Sourced from, but not a replacement for, the permanent `approval_decisions` row created by `recordApprovalDecision` — that remains the durable decision-history record (Assumptions, FR-004).

**Lifecycle**:
1. Created/updated when `recordApprovalDecision` records a `decision: "rejected"` outcome (FR-001).
2. Read by remediation before it requeues a `needs-rework` artifact (FR-005/FR-006).
3. Left untouched by an `approved` decision, by artifacts that never go through the human approval gate, and by the automated-arbiter rejection path (`rejectArtifactWithEvidence`) — out of scope per clarification.
4. Never expires or is marked consumed (per clarification; matches existing `agent_context` semantics — a later rejection simply upserts it again).

**Validation rules** (inherited/extended from `context.ts`):
- Content must still satisfy `writeContext`'s existing `## Summary` extraction contract at the file level, since `getContext`'s read path and any human inspecting the file expect that shape — the envelope write synthesizes a minimal file with a `## Summary` section wrapping the reason text (see research.md).
- An empty/whitespace-only reason cannot occur on this path: `recordApprovalDecision` already throws `RegistryError` for a rejection with no reason before any write happens (existing behavior in `migration/registry/commands/approval.ts`, unchanged by this feature).
- A write failure here (fs error, etc.) MUST NOT raise out of `recordApprovalDecision` (FR-008) — caught and swallowed, symmetric with `commitPromotedArtifact`'s existing fail-open pattern.
