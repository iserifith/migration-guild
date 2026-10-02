/**
 * Rendered integration tests for the shared dashboard state owner (issue #297)
 * and the direct tab rendering (issue #298).
 *
 * Unlike App.test.tsx — which mocks the hook layer — these tests mock only the
 * API module so the real hooks run inside the real App shell, letting the
 * assertions cover what is actually rendered:
 *  - a shell refresh visibly updates Mission Control content, which now renders
 *    from the shell-owned artifacts/status/wave-plan instances;
 *  - submitting an approval decision updates the panel AND the Approvals nav
 *    badge together through the single shared useApprovals instance;
 *  - the shell's filtered/paginated sessions query and Mission Control's
 *    unfiltered sessions view remain two distinct queries;
 *  - approvals loading/error/retry still work on the affected surface.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import App from "./App";
import * as api from "./api";
import type {
  ApprovalDecision,
  PendingApproval,
  SocietyResponse,
  StatusResponse,
} from "./types";

vi.mock("./api", () => ({
  fetchArtifacts: vi.fn(),
  fetchStatus: vi.fn(),
  getSociety: vi.fn(),
  fetchWavePlan: vi.fn(),
  fetchEvents: vi.fn(),
  fetchSessions: vi.fn(),
  fetchBlockers: vi.fn(),
  fetchIssues: vi.fn(),
  fetchRuns: vi.fn(),
  fetchRunLog: vi.fn(),
  fetchPendingApprovals: vi.fn(),
  fetchApprovalHistory: vi.fn(),
  postApprovalDecision: vi.fn(),
  fetchRunStatus: vi.fn(),
}));

const PENDING_ID = "legacy-source:com.acme:Foo";

function statusResponse(completed: number): StatusResponse {
  return {
    files: {
      total: 10,
      completed,
      in_progress: 2,
      pending: 10 - completed - 2,
      by_status: {},
    },
    current_focus: null,
    next: null,
    open_blockers: [],
    open_issues: [],
  };
}

function societyResponse(): SocietyResponse {
  return {
    roles: { "builder-agent": 2, "critic-agent": 1 },
    task_division: { by_status: {}, by_wave: {}, by_tier: {}, active_claims: 0 },
    dialogue: {},
    conflict_resolution: {
      claim_releases: 0,
      claim_expirations: 0,
      reaped_runs: 0,
      arbitration_approved: 0,
      arbitration_rejected: 0,
    },
    evidence: {
      total: 10,
      passed: 8,
      failed: 2,
      pass_rate: 0.8,
      artifacts_awaiting_evidence: 0,
      artifacts_awaiting_arbitration: 1,
    },
    efficiency: { elapsed_runtime_ms: null, failed_runs: 0, reworked_artifacts: 0 },
  };
}

function pendingApproval(artifactId: string): PendingApproval {
  return {
    artifactId,
    riskReasonCodes: ["high-risk"],
    arbitrationVerdictSummary: "arbiter approved evidence",
    enteredPendingApprovalAt: "2024-01-02T00:00:00Z",
  };
}

function approvalDecision(artifactId: string): ApprovalDecision {
  return {
    decisionId: "dec-1",
    artifactId,
    runId: null,
    operator: "mission-control",
    decision: "approved",
    reason: null,
    operatorTokenHash: null,
    decidedAt: "2024-01-03T00:00:00Z",
  };
}

describe("App shared dashboard state (issue #297)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.fetchArtifacts).mockResolvedValue([]);
    vi.mocked(api.fetchStatus).mockResolvedValue(statusResponse(3));
    vi.mocked(api.getSociety).mockResolvedValue(societyResponse());
    vi.mocked(api.fetchWavePlan).mockResolvedValue([
      { wave: 1, total: 10, by_status: { pending: 7, completed: 3 } },
    ]);
    vi.mocked(api.fetchEvents).mockResolvedValue([]);
    vi.mocked(api.fetchSessions).mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      page_size: 25,
      total_pages: 1,
    });
    vi.mocked(api.fetchBlockers).mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      page_size: 25,
      total_pages: 0,
    });
    vi.mocked(api.fetchIssues).mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      page_size: 25,
      total_pages: 0,
    });
    vi.mocked(api.fetchRuns).mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      page_size: 25,
      total_pages: 0,
    });
    vi.mocked(api.fetchRunLog).mockResolvedValue("");
    vi.mocked(api.fetchPendingApprovals).mockResolvedValue([]);
    vi.mocked(api.fetchApprovalHistory).mockResolvedValue([]);
    vi.mocked(api.postApprovalDecision).mockResolvedValue(approvalDecision(PENDING_ID));
    vi.mocked(api.fetchRunStatus).mockResolvedValue([]);
  });

  it("global refresh visibly updates Mission Control from shell-owned state", async () => {
    vi.mocked(api.fetchStatus)
      .mockResolvedValueOnce(statusResponse(3))
      .mockResolvedValue(statusResponse(5));

    render(<App />);

    // Mission Control (default tab) renders the shell-owned completion metric.
    expect(await screen.findByText("30%")).toBeInTheDocument();
    expect(screen.getByText("3 / 10 artifacts")).toBeInTheDocument();

    // The shell refresh button must update the visible dashboard content,
    // not just hidden shell state.
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));

    expect(await screen.findByText("50%")).toBeInTheDocument();
    expect(screen.getByText("5 / 10 artifacts")).toBeInTheDocument();
    expect(screen.queryByText("30%")).not.toBeInTheDocument();
  });

  it("approval decision synchronizes the panel and the nav badge via one shared instance", async () => {
    vi.mocked(api.fetchPendingApprovals)
      .mockResolvedValueOnce([pendingApproval(PENDING_ID)])
      .mockResolvedValue([]);
    vi.mocked(api.fetchApprovalHistory)
      .mockResolvedValueOnce([])
      .mockResolvedValue([approvalDecision(PENDING_ID)]);

    render(<App />);

    const approvalsTab = screen.getByText("Approvals").closest('[role="tab"]');
    expect(approvalsTab).not.toBeNull();

    fireEvent.click(screen.getByText("Approvals"));
    expect(await screen.findByText(PENDING_ID)).toBeInTheDocument();

    // One shared approvals instance owns the data: opening the Approvals tab
    // must not start a second independent polling loop for the panel.
    expect(api.fetchPendingApprovals).toHaveBeenCalledTimes(1);
    expect(approvalsTab?.querySelector(".badge.pending-approval")).toHaveTextContent("1");

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByText("No artifacts awaiting approval.")).toBeInTheDocument();

    // Same shared instance feeds badge and panel: both update together.
    expect(approvalsTab?.querySelector(".badge.pending-approval")).toBeNull();
    expect(screen.getByText("approved")).toBeInTheDocument();
    expect(api.postApprovalDecision).toHaveBeenCalledWith(PENDING_ID, {
      decision: "approved",
    });
    // One decision reload on the shared instance refetches pending + history.
    expect(api.fetchPendingApprovals).toHaveBeenCalledTimes(2);
    expect(api.fetchApprovalHistory).toHaveBeenCalledTimes(2);
  });

  it("keeps the shell's filtered sessions query and Mission Control's unfiltered view distinct", async () => {
    render(<App />);
    await screen.findByText("30%");

    const sessionQueries = vi.mocked(api.fetchSessions).mock.calls.map((call) => call[0]);
    // Mission Control's own unfiltered sessions view.
    expect(sessionQueries).toContainEqual({});
    // The shell's filtered/paginated sessions query.
    expect(sessionQueries).toContainEqual({
      stalled: "all",
      sort: "age-desc",
      page: 1,
      page_size: 25,
    });
  });

  it("approvals error and retry run through the shared approvals instance", async () => {
    vi.mocked(api.fetchPendingApprovals)
      .mockRejectedValueOnce(new Error("approvals down"))
      .mockResolvedValueOnce([pendingApproval(PENDING_ID)]);

    render(<App />);
    fireEvent.click(screen.getByText("Approvals"));

    expect(await screen.findByText(/approvals down/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /retry approvals/i }));

    // Retrying the shared instance recovers the panel and drives the badge.
    expect(await screen.findByText(PENDING_ID)).toBeInTheDocument();
    const approvalsTab = screen.getByText("Approvals").closest('[role="tab"]');
    expect(approvalsTab?.querySelector(".badge.pending-approval")).toHaveTextContent("1");
  });
});