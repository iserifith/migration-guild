# Data Model: Adversary Agent Role Between Review and the Approval Gate

No new tables. This feature reuses the existing `agent_context` table (via `migration/registry/commands/context.ts`) with a second reserved-key convention layered on top of the one issue #216 introduced, plus the existing `events` table for routing/pass records.

## Adversary Finding (conceptual entity — not a new table)

Represented as one row of the existing `agent_context` table, distinguished from every other row for the same artifact only by its `agent` value.

| Field | Source | Notes |
|---|---|---|
| `artifact_id` | Existing `agent_context.artifact_id` | The probed artifact. |
| `agent` | Existing `agent_context.agent`, fixed reserved value `adversary-envelope` | Never used by a real analysis-writing agent, and distinct from #216's `rejection-envelope` reserved value — this is what makes the entry distinguishable per FR-008. |
| `file_path` | Existing `agent_context.file_path` | Points at `migration/artifacts/<slug>/context/adversary-envelope.md`, following the same canonical layout `getContext`'s step-3 fallback already rebuilds from `idToSlug(id)` — identical pattern to #216's `rejection-envelope.md`. |
| `summary` | Existing `agent_context.summary` | The adversary-agent's finding text, verbatim (FR-016): either the constructed violating case and the spec intent it violates, or — when the probe was inconclusive (FR-008a) — a description of why the probe could not run. Stored as the extracted `## Summary` body, same shape every other `agent_context` row already has. |
| `updated_at` | Existing `agent_context.updated_at` | Upserted on every new adversary-agent run against the artifact; gives "most recent finding" for free, matching #216's precedent (Assumptions: no expiry/consumed-marking). |

**Relationships**: One adversary-envelope row per artifact (0 or 1), independent of and never overwriting any other `(artifact_id, agent)` row for the same artifact — including the `rejection-envelope` row #216 may have written for the same artifact on an unrelated cycle (FR-009). Sourced from, but not a replacement for, the permanent `events` row appended at routing time — that remains the durable, always-present record of "this artifact was sent to `needs-rework` and why," even when the detailed envelope write fails (FR-015).

**Lifecycle**:
1. Created/updated when the adversary-agent runs against an artifact that has passed `review-agent` and finds a spec-violating case, or cannot run its probe at all (FR-001, FR-004, FR-008a).
2. Left untouched (no row written or updated) when the adversary-agent finds no violating case — the clean-pass path (FR-003) writes only the lightweight pass event described below for gate-bound artifacts (FR-008b), not an `agent_context` row.
3. Read by remediation before it requeues a `needs-rework` artifact, alongside (not instead of) the existing `rejection-envelope` read #216 added (FR-010–FR-012).
4. Never expires or is marked consumed (matches #216's `agent_context` precedent) — a later adversary-agent run on the same artifact simply upserts this same row again, most-recent-wins.

**Validation rules** (inherited/extended from `context.ts`, mirroring #216):
- Content must satisfy the existing `## Summary` extraction contract at the file level (`extractSummary` in `context.ts`), since `getContext`'s read path expects that shape.
- A write failure here (fs error, etc.) MUST NOT raise out of the routing call site inside `approveArtifactWithEvidence` (FR-015) — caught and swallowed, symmetric with `commitPromotedArtifact`'s and #216's `writeRejectionEnvelope`'s existing fail-open pattern.

## Adversary Probe Event (uses the existing `events` table — no new table)

Two distinct outcomes are recorded as ordinary `events` rows, appended via the existing `appendEvent` helper (`migration/registry/commands/events.ts`), the same primitive `rejectArtifactWithEvidence` and `recordApprovalDecision` already use for their own routing/decision records:

| Outcome | `events.type` (proposed literal — implementation-level naming, task-level decision) | Artifact status effect | `agent_context` effect |
|---|---|---|---|
| Violation found | `adversary-flagged` | `setArtifactStatus(..., "needs-rework")` | `adversary-envelope` row written (finding text) |
| Probe inconclusive (FR-008a) | `adversary-inconclusive` | `setArtifactStatus(..., "needs-rework")` | `adversary-envelope` row written (inconclusive reason) |
| Clean pass, gate-bound artifact (FR-008b) | `adversary-probe-passed` | none — status transition proceeds exactly as today (`pending-approval` or `reviewed`, per existing gate logic) | none — no envelope row; this is a signal-only event, explicitly not evidence (FR-008b) |
| Clean pass, below-cutoff artifact | none (no event) | none — status transition proceeds exactly as today | none |

**Note on the fourth row**: a clean pass on a below-cutoff artifact produces no new record at all, matching FR-003's "proceeds exactly as it does today" and avoiding event-log noise on the (expected-common) success path; only the gate-bound clean-pass case gets an explicit signal event, per FR-008b's clarification-driven requirement that a human operator's context at the gate include whether the adversarial check ran and found nothing.

**Relationships**: Every `adversary-flagged`/`adversary-inconclusive` event has a corresponding `adversary-envelope` `agent_context` row for the same artifact as of that moment (write-then-append ordering, or vice versa, is a task-level implementation detail; either order must tolerate the envelope write failing per FR-015). `adversary-probe-passed` events have no corresponding `agent_context` row by design.

**Validation rules**:
- `adversary-flagged` / `adversary-inconclusive` MUST both result in `needs-rework`, indistinguishable from each other at the status level — they differ only in the `agent_context` content and the `events.type` literal, per FR-008a treating an inconclusive probe the same as a found violation for routing purposes.
- `adversary-probe-passed` MUST NOT alter `artifacts.status`, MUST NOT be consumable as `acceptance_evidence` or arbitration evidence, and MUST NOT be producible for a below-cutoff artifact (FR-008b scopes it to gate-bound artifacts only, since that is the only case a human operator's context is relevant).
