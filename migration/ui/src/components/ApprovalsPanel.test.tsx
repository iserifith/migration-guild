import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalDecision, PendingApproval } from "../types";
import ApprovalsPanel from "./ApprovalsPanel";

const PENDING: PendingApproval[] = [
  {
    artifactId: "legacy-source:com.acme:Foo",
    riskReasonCodes: ["high-blast-radius", "untested-module"],
    arbitrationVerdictSummary: "Migration approved by arbiter; held for operator review.",
    enteredPendingApprovalAt: "2024-01-02T00:00:00Z",
  },
  {
    artifactId: "module:com.acme:Bar",
    riskReasonCodes: [],
    arbitrationVerdictSummary: "Auto-approved with warnings.",
    enteredPendingApprovalAt: "2024-01-03T12:30:00Z",
  },
];

const HISTORY: ApprovalDecision[] = [
  {
    decisionId: "dec-2",
    artifactId: "legacy-source:com.acme:Baz",
    runId: null,
    operator: "mission-control",
    decision: "rejected",
    reason: "Diff touches billing path",
    operatorTokenHash: null,
    decidedAt: "2024-01-04T09:15:00Z",
  },
  {
    decisionId: "dec-1",
    artifactId: "legacy-source:com.acme:Foo",
    runId: "run-9",
    operator: "operator-7",
    decision: "approved",
    reason: null,
    operatorTokenHash: null,
    decidedAt: "2024-01-03T08:00:00Z",
  },
];

function renderPanel(
  overrides: Partial<Parameters<typeof ApprovalsPanel>[0]> = {},
) {
  const props = {
    pending: PENDING,
    history: HISTORY,
    loading: false,
    error: null as Error | null,
    onRetry: vi.fn(),
    onDecide: vi.fn().mockResolvedValue(undefined),
    timeMode: "utc" as const,
    ...overrides,
  };
  render(<ApprovalsPanel {...props} />);
  return props;
}

describe("ApprovalsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the pending list with risk reason codes, verdict summary, and hold timestamp", () => {
    renderPanel();

    expect(
      screen.getByRole("heading", { name: /pending approvals/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("legacy-source:com.acme:Foo"),
    ).toBeInTheDocument();
    expect(screen.getByText("high-blast-radius")).toBeInTheDocument();
    expect(screen.getByText("untested-module")).toBeInTheDocument();
    expect(
      screen.getByText(/held for operator review/i),
    ).toBeInTheDocument();
    expect(screen.getByText("2024-01-02 00:00 UTC")).toBeInTheDocument();
    // No risk codes parsed -> explicit placeholder rather than a blank cell.
    expect(screen.getByText("No risk reason codes recorded.")).toBeInTheDocument();
  });

  it("renders decided history newest first with decision, operator, reason, and decidedAt", () => {
    renderPanel();

    expect(
      screen.getByRole("heading", { name: /decision history/i }),
    ).toBeInTheDocument();
    const historyTable = screen
      .getByRole("table", { name: /decision history/i });
    const rows = within(historyTable).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    // Newest first: Baz (rejected, 2024-01-04) before Foo (approved, 2024-01-03).
    expect(rows[0]).toHaveTextContent("legacy-source:com.acme:Baz");
    expect(rows[0]).toHaveTextContent("rejected");
    expect(rows[0]).toHaveTextContent("mission-control");
    expect(rows[0]).toHaveTextContent("Diff touches billing path");
    expect(rows[0]).toHaveTextContent("2024-01-04 09:15 UTC");
    expect(rows[1]).toHaveTextContent("legacy-source:com.acme:Foo");
    expect(rows[1]).toHaveTextContent("approved");
    expect(rows[1]).toHaveTextContent("operator-7");
  });

  it("shows a clearly-present empty state when nothing is awaiting decision", () => {
    renderPanel({ pending: [], history: [] });

    expect(
      screen.getByRole("heading", { name: /pending approvals/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/no artifacts awaiting approval/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/no approval decisions recorded yet/i),
    ).toBeInTheDocument();
  });

  it("shows loading and error states", () => {
    const { unmount } = render(
      <ApprovalsPanel
        pending={[]}
        history={[]}
        loading
        error={null}
        onRetry={vi.fn()}
        onDecide={vi.fn()}
        timeMode="utc"
      />,
    );
    expect(screen.getByText(/loading approvals/i)).toBeInTheDocument();
    unmount();

    const onRetry = vi.fn();
    render(
      <ApprovalsPanel
        pending={[]}
        history={[]}
        loading={false}
        error={new Error("approvals down")}
        onRetry={onRetry}
        onDecide={vi.fn()}
        timeMode="utc"
      />,
    );
    expect(screen.getByText(/couldn't load approvals/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /retry approvals/i }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("approve submits an approved decision for the row's artifact", async () => {
    const props = renderPanel();

    const row = screen
      .getByText("legacy-source:com.acme:Foo")
      .closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: /^approve$/i }));

    expect(props.onDecide).toHaveBeenCalledWith(
      "legacy-source:com.acme:Foo",
      expect.objectContaining({ decision: "approved" }),
    );
  });

  it("reject requires a reason and submits it with the decision", async () => {
    const props = renderPanel();

    const row = screen
      .getByText("legacy-source:com.acme:Foo")
      .closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: /^reject$/i }));

    // Reason input appears; confirm stays disabled until a reason is given.
    const reasonInput = screen.getByLabelText(/rejection reason/i);
    const confirm = screen.getByRole("button", { name: /confirm rejection/i });
    expect(confirm).toBeDisabled();

    fireEvent.change(reasonInput, { target: { value: "Needs manual diff review" } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);

    expect(props.onDecide).toHaveBeenCalledWith(
      "legacy-source:com.acme:Foo",
      expect.objectContaining({
        decision: "rejected",
        reason: "Needs manual diff review",
      }),
    );
  });

  it("cancelling a rejection hides the reason form without submitting", () => {
    const props = renderPanel();

    const row = screen
      .getByText("legacy-source:com.acme:Foo")
      .closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: /^reject$/i }));
    expect(screen.getByLabelText(/rejection reason/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(screen.queryByLabelText(/rejection reason/i)).not.toBeInTheDocument();
    expect(props.onDecide).not.toHaveBeenCalled();
  });
});
