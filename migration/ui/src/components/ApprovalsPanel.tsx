/**
 * ApprovalsPanel — the US4 (spec 013) human approval-gate surface.
 *
 * Shows every artifact currently held at `pending-approval` with the context
 * an operator needs to decide (risk reason codes, arbiter verdict summary,
 * when the hold started), plus Approve/Reject controls, and the decided
 * history (newest first) underneath. Empty is a normal, clearly-present
 * state — not an error (spec.md US4 acceptance scenario 3).
 *
 * Purely presentational + form state: data fetching lives in hooks.ts
 * (`useApprovals`), and the POST call is passed in as `onDecide` so App.tsx
 * owns the refetch-after-action wiring.
 */

import { memo, useState } from "react";
import { formatTimestamp } from "../format";
import type {
  ApprovalDecision,
  ApprovalDecisionRequest,
  PendingApproval,
  TimeDisplayMode,
} from "../types";
import { EmptyState, ErrorState, LoadingState } from "./ViewState";

interface ApprovalsPanelProps {
  pending: PendingApproval[];
  history: ApprovalDecision[];
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
  onDecide: (
    artifactId: string,
    body: ApprovalDecisionRequest,
  ) => Promise<unknown>;
  timeMode: TimeDisplayMode;
}

function RejectForm({
  onConfirm,
  onCancel,
  isSubmitting,
}: {
  onConfirm: (reason: string) => void;
  onCancel: () => void;
  isSubmitting?: boolean;
}) {
  const [reason, setReason] = useState("");
  const trimmed = reason.trim();

  return (
    <div className="filters" style={{ marginBottom: 0 }}>
      <input
        aria-label="Rejection reason"
        className="filter-input"
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason for rejection (required)"
        value={reason}
        disabled={isSubmitting}
      />
      <button
        className="state-button"
        disabled={!trimmed || isSubmitting}
        onClick={() => onConfirm(trimmed)}
        type="button"
        aria-busy={isSubmitting}
        title={!trimmed ? "A rejection reason is required" : undefined}
      >
        <div className="button-content">
          {isSubmitting ? (
            <>
              <span className="spinner" aria-hidden="true" />
              <span>Rejecting...</span>
            </>
          ) : (
            "Confirm rejection"
          )}
        </div>
      </button>
      <button className="state-button" onClick={onCancel} type="button" disabled={isSubmitting} title={isSubmitting ? "Cannot cancel while submitting" : "Cancel"}>
        Cancel
      </button>
    </div>
  );
}

// ⚡ Bolt: Memoize component to prevent unnecessary re-renders when App polls global state
export default memo(function ApprovalsPanel({
  pending,
  history,
  loading,
  error,
  onRetry,
  onDecide,
  timeMode,
}: ApprovalsPanelProps) {
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [submittingDecision, setSubmittingDecision] = useState<"approved" | "rejected" | null>(null);

  const decide = (artifactId: string, body: ApprovalDecisionRequest) => {
    setDecisionError(null);
    setSubmittingId(artifactId);
    setSubmittingDecision(body.decision);
    void onDecide(artifactId, body)
      .then(() => setRejectingId(null))
      .catch((err: unknown) =>
        setDecisionError(
          err instanceof Error ? err.message : "Decision failed.",
        ),
      )
      .finally(() => {
        setSubmittingId(null);
        setSubmittingDecision(null);
      });
  };

  if (loading) {
    return (
      <section aria-label="Approvals">
        <LoadingState resource="approvals" />
      </section>
    );
  }

  if (error) {
    return (
      <section aria-label="Approvals">
        <ErrorState resource="approvals" error={error} onRetry={onRetry} />
      </section>
    );
  }

  return (
    <section aria-label="Approvals">
      <h2>Pending approvals</h2>
      {decisionError ? (
        <p className="state-detail" role="alert">
          {decisionError}
        </p>
      ) : null}
      {pending.length === 0 ? (
        // Acceptance scenario 3: nothing held is a normal, clearly-present
        // empty section, not an error.
        <EmptyState
          compact
          title="No artifacts awaiting approval."
          detail="High-risk artifacts held at the approval gate will appear here."
        />
      ) : (
        <div className="table-wrap">
          <table aria-label="Pending approvals">
            <thead>
              <tr>
                <th>Artifact</th>
                <th>Risk reason codes</th>
                <th>Arbiter verdict</th>
                <th>Held since</th>
                <th>Decision</th>
              </tr>
            </thead>
            <tbody>
              {pending.map((a) => (
                <tr key={a.artifactId}>
                  <td className="mono wrap-text">{a.artifactId}</td>
                  <td>
                    {a.riskReasonCodes.length > 0 ? (
                      a.riskReasonCodes.map((code) => (
                        <span className="badge pending" key={code}>
                          {code}
                        </span>
                      ))
                    ) : (
                      <span className="cell-secondary">
                        No risk reason codes recorded.
                      </span>
                    )}
                  </td>
                  <td className="wrap-text">
                    {a.arbitrationVerdictSummary || "-"}
                  </td>
                  <td>{formatTimestamp(a.enteredPendingApprovalAt, timeMode)}</td>
                  <td>
                    {rejectingId === a.artifactId ? (
                      <RejectForm
                        onConfirm={(reason) =>
                          decide(a.artifactId, { decision: "rejected", reason })
                        }
                        onCancel={() => setRejectingId(null)}
                        isSubmitting={submittingId === a.artifactId && submittingDecision === "rejected"}
                      />
                    ) : (
                      <div className="filters" style={{ marginBottom: 0 }}>
                        <button
                          className="state-button"
                          disabled={submittingId === a.artifactId}
                          onClick={() =>
                            decide(a.artifactId, { decision: "approved" })
                          }
                          type="button"
                          aria-busy={submittingId === a.artifactId && submittingDecision === "approved"}
                          title={submittingId === a.artifactId ? "Decision in progress" : "Approve"}
                        >
                          <div className="button-content">
                            {submittingId === a.artifactId && submittingDecision === "approved" ? (
                              <>
                                <span className="spinner" aria-hidden="true" />
                                <span>Approving...</span>
                              </>
                            ) : (
                              "Approve"
                            )}
                          </div>
                        </button>
                        <button
                          className="state-button"
                          disabled={submittingId === a.artifactId}
                          onClick={() => setRejectingId(a.artifactId)}
                          type="button"
                          title={submittingId === a.artifactId ? "Decision in progress" : "Reject"}
                        >
                          Reject
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Decision history</h2>
      {history.length === 0 ? (
        <EmptyState compact title="No approval decisions recorded yet." />
      ) : (
        <div className="table-wrap">
          <table aria-label="Decision history">
            <thead>
              <tr>
                <th>Artifact</th>
                <th>Decision</th>
                <th>Operator</th>
                <th>Reason</th>
                <th>Decided</th>
              </tr>
            </thead>
            <tbody>
              {history.map((d) => (
                <tr key={d.decisionId}>
                  <td className="mono wrap-text">{d.artifactId}</td>
                  <td>
                    <span
                      className={`badge ${d.decision === "approved" ? "migrated" : "needs-rework"}`}
                    >
                      {d.decision}
                    </span>
                  </td>
                  <td>{d.operator}</td>
                  <td className="wrap-text">{d.reason ?? "-"}</td>
                  <td>{formatTimestamp(d.decidedAt, timeMode)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
});
