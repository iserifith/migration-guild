# Phase 1 Contracts: Registry Commands and Agent Procedure Surface

This feature's external interfaces are (a) an addition to the existing `recordApprovalDecision` registry function's side effects (`migration/registry/commands/approval.ts`), and (b) a new read step in the `remediation-agent` procedure (`package/agents/remediation-agent.agent.md`), which already goes through the existing `get-context` CLI command. No new CLI subcommand is introduced — the existing `get-context`/`write-context` surface is reused.

## Registry command contract: `registry/commands/approval.ts` (modified)

### `recordApprovalDecision(db, opts): ApprovalDecision` — additional side effect

Signature and return type are **unchanged** from spec-013 (see `specs/013-approval-gate-attempt-state/contracts/registry-commands.md`). This feature adds one additional, best-effort side effect when `opts.decision === "rejected"`, after the existing `approval_decisions` insert and status transition inside the same function:

```ts
// Inside recordApprovalDecision, after the existing needs-rework transition,
// only when opts.decision === "rejected":
try {
  writeRejectionEnvelope(db, opts.artifactId, opts.reason!);
} catch {
  // fail open (research.md "Decision: Fail-open write, fail-closed decision") —
  // never allow the envelope write to turn a successful rejection into an error.
}
```

**Contract**:
- MUST NOT alter `recordApprovalDecision`'s existing preconditions, transaction boundaries for `approval_decisions`/status transition, return value shape, or thrown-error conditions.
- MUST run only for `decision === "rejected"` (never for `"approved"`), consistent with FR-001's scope.
- MUST NOT propagate any error out of `recordApprovalDecision` (FR-008).

## Registry command contract: `registry/commands/context.ts` (modified)

### `writeRejectionEnvelope(db, artifactId, reason): void` (new, internal)

```ts
function writeRejectionEnvelope(
  db: Database.Database,
  artifactId: string,
  reason: string,
): void;
```

- Writes `reason` (verbatim, FR-009) to `migration/artifacts/<slug>/context/rejection-envelope.md` under a synthesized `## Summary` section, and upserts the corresponding `agent_context` row with `agent = "rejection-envelope"` (the reserved key from research.md / data-model.md), reusing the same row-upsert logic `writeContext` already uses internally.
- MUST NOT touch any `agent_context` row for any other `agent` value on the same artifact (FR-003).
- Idempotent per call: a second rejection on the same artifact upserts (overwrites) this same row — this is what makes "most recent reason wins" (FR-004) automatic.
- Not exported from the module's public CLI-facing surface; it is a helper used only by `recordApprovalDecision`. (If implementation finds it cleaner to expose a small public variant, it MUST NOT replace or change the signature of the existing public `writeContext(db, id, agent, filePath)`.)

### `getRejectionEnvelope(db, artifactId): { reason: string } | null` (new, or equivalent thin wrapper over `getContext`)

```ts
function getRejectionEnvelope(
  db: Database.Database,
  artifactId: string,
): { reason: string } | null;
```

- Equivalent to calling `getContext(db, artifactId, "rejection-envelope")` and returning `null` when the response `form` is `"none"`, or the extracted text otherwise (FR-005).
- Pure read; no side effects; safe to call for any artifact, including one that was never rejected (returns `null`, not an error — FR-007).
- May be implemented as a direct `getContext` call from the CLI layer rather than a new function, provided the reserved key (`"rejection-envelope"`) is the single source of truth for both the write and read sides (e.g. a shared exported constant) so the two never drift.

## CLI / procedure contract: `package/agents/remediation-agent.agent.md` (modified)

No new CLI subcommand. The existing `get-context` command (already wired to `getContext` in `migration/registry/cli.ts`) is reused:

```bash
node migration/registry/dist/cli.js get-context --id "<id>" --agent rejection-envelope
```

- Returns the stored rejection reason (`form: "file"` or `form: "summary"`) when one exists for the artifact, or the existing `form: "none"` fallback response when it does not (FR-007) — no new response shape, no new error mode.
- **Contract on the procedure document**: before executing recovery action **B (Send back one step)** for a `needs-rework` artifact, `remediation-agent.agent.md` MUST run this command and, when a reason is returned, include it in the `--reason`/`--summary` text passed to the existing `set-artifact-status --status planned` and `append-event --type remediated` calls (FR-006). When no reason is returned, the existing reason/summary text is used unchanged (FR-007).
