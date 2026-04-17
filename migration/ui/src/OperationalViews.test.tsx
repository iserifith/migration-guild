import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import BlockersView from "./components/BlockersView";
import CostView from "./components/CostView";
import QualityView from "./components/QualityView";
import RunsView from "./components/RunsView";
import SessionsView from "./components/SessionsView";
import { useRunLog } from "./hooks";

vi.mock("./hooks", () => ({
  useRunLog: vi.fn(),
}));

describe("operational tab views", () => {
  beforeEach(() => {
    vi.mocked(useRunLog).mockReturnValue({
      log: "first line\nsecond line",
      loading: false,
      error: null,
      reload: vi.fn(),
    });
  });

  it("forwards run filter changes and shows server pagination counts", () => {
    const onQueryChange = vi.fn();

    render(
      <RunsView
        runs={[
          {
            run_id: "run-1",
            agent: "migration-agent",
            model: "gpt-5.4",
            status: "completed",
            started_at: "2024-01-02T00:00:00Z",
            finished_at: "2024-01-02T00:10:00Z",
            exit_code: 0,
            log_file: null,
          },
        ]}
        total={42}
        page={2}
        pageSize={1}
        totalPages={42}
        availableFilters={{
          agents: ["migration-agent", "review-agent"],
          statuses: ["completed", "failed"],
          models: ["gpt-5.4", "gpt-5-mini"],
        }}
        loading={false}
        error={null}
        onRetry={vi.fn()}
        query={{ agent: "", status: "", model: "", sort: "newest", page: 2, page_size: 1 }}
        onQueryChange={onQueryChange}
        timeMode="utc"
      />,
    );

    fireEvent.change(screen.getByLabelText(/run agent filter/i), {
      target: { value: "review-agent" },
    });
    fireEvent.change(screen.getByLabelText(/run status filter/i), {
      target: { value: "failed" },
    });

    expect(onQueryChange).toHaveBeenNthCalledWith(1, { agent: "review-agent", page: 1 });
    expect(onQueryChange).toHaveBeenNthCalledWith(2, { status: "failed", page: 1 });
    expect(screen.getByText(/2-2 of 42 total/i)).toBeInTheDocument();
  });

  it("shows scoped blocker retries and issue filters", () => {
    const retryIssues = vi.fn();
    const onIssueQueryChange = vi.fn();

    render(
      <BlockersView
        blockers={[]}
        blockersTotal={0}
        blockersPage={1}
        blockersPageSize={25}
        blockersTotalPages={1}
        blockersLoading={false}
        blockersError={null}
        blockersOnRetry={vi.fn()}
        blockerQuery={{ q: "", sort: "oldest", page: 1, page_size: 25 }}
        onBlockerQueryChange={vi.fn()}
        issues={[
          {
            artifact_id: "artifact-1",
            issue_id: "iss-1",
            severity: "high",
            category: "behavior",
            summary: "Needs follow-up",
            ts: "2024-01-02T00:00:00Z",
          },
          {
            artifact_id: "artifact-2",
            issue_id: "iss-2",
            severity: "low",
            category: "style",
            summary: "Nice to have",
            ts: "2024-01-02T00:10:00Z",
          },
        ]}
        issuesTotal={2}
        issuesPage={1}
        issuesPageSize={25}
        issuesTotalPages={1}
        issueFilters={{
          severities: ["high", "low"],
          categories: ["behavior", "style"],
        }}
        issuesLoading={false}
        issuesError={new Error("issues down")}
        issuesOnRetry={retryIssues}
        issueQuery={{ severity: "", category: "", sort: "severity", page: 1, page_size: 25 }}
        onIssueQueryChange={onIssueQueryChange}
        timeMode="utc"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /retry issues/i }));
    expect(retryIssues).toHaveBeenCalledOnce();
  });

  it("filters issues by severity when the section has data", () => {
    const onIssueQueryChange = vi.fn();

    render(
      <BlockersView
        blockers={[]}
        blockersTotal={0}
        blockersPage={1}
        blockersPageSize={25}
        blockersTotalPages={1}
        blockersLoading={false}
        blockersError={null}
        blockersOnRetry={vi.fn()}
        blockerQuery={{ q: "", sort: "oldest", page: 1, page_size: 25 }}
        onBlockerQueryChange={vi.fn()}
        issues={[
          {
            artifact_id: "artifact-1",
            issue_id: "iss-1",
            severity: "high",
            category: "behavior",
            summary: "Needs follow-up",
            ts: "2024-01-02T00:00:00Z",
          },
          {
            artifact_id: "artifact-2",
            issue_id: "iss-2",
            severity: "low",
            category: "style",
            summary: "Nice to have",
            ts: "2024-01-02T00:10:00Z",
          },
        ]}
        issuesTotal={2}
        issuesPage={1}
        issuesPageSize={25}
        issuesTotalPages={1}
        issueFilters={{
          severities: ["high", "low"],
          categories: ["behavior", "style"],
        }}
        issuesLoading={false}
        issuesError={null}
        issuesOnRetry={vi.fn()}
        issueQuery={{ severity: "", category: "", sort: "severity", page: 1, page_size: 25 }}
        onIssueQueryChange={onIssueQueryChange}
        timeMode="utc"
      />,
    );

    fireEvent.change(screen.getByLabelText(/issue severity filter/i), {
      target: { value: "high" },
    });

    expect(onIssueQueryChange).toHaveBeenCalledWith({ severity: "high", page: 1 });
  });

  it("filters cost rows by model", () => {
    render(
      <CostView
        cost={{
          total_tokens_in: 300,
          total_tokens_out: 450,
          total_cost_usd: 2.5,
          total_calls: 4,
          by_model: [
            {
              model: "gpt-5.4",
              calls: 3,
              tokens_in: 200,
              tokens_out: 300,
              cost_usd: 2.0,
            },
            {
              model: "gpt-5-mini",
              calls: 1,
              tokens_in: 100,
              tokens_out: 150,
              cost_usd: 0.5,
            },
          ],
        }}
        loading={false}
        error={null}
        onRetry={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText(/model filter/i), {
      target: { value: "mini" },
    });

    expect(screen.getByText("gpt-5-mini")).toBeInTheDocument();
    expect(screen.queryByText("gpt-5.4")).not.toBeInTheDocument();
  });

  it("filters sessions to stalled rows only", () => {
    const onQueryChange = vi.fn();

    render(
      <SessionsView
        sessions={[
          {
            id: "artifact-1",
            path: "src/A.ts",
            module: "acme",
            role: "service",
            status: "in-progress",
            claimed_by: "agent-1",
            claimed_at: "2024-01-02T00:00:00Z",
            claimed_minutes_ago: 90,
            stalled: true,
          },
          {
            id: "artifact-2",
            path: "src/B.ts",
            module: "acme",
            role: "service",
            status: "in-progress",
            claimed_by: "agent-2",
            claimed_at: "2024-01-02T00:30:00Z",
            claimed_minutes_ago: 30,
            stalled: false,
          },
        ]}
        total={14}
        page={1}
        pageSize={2}
        totalPages={7}
        availableFilters={{ statuses: ["in-progress"] }}
        loading={false}
        error={null}
        onRetry={vi.fn()}
        query={{ stalled: "all", status: "", sort: "age-desc", page: 1, page_size: 2 }}
        onQueryChange={onQueryChange}
        timeMode="utc"
      />,
    );

    fireEvent.change(screen.getByLabelText(/session stall filter/i), {
      target: { value: "stalled" },
    });

    expect(onQueryChange).toHaveBeenCalledWith({ stalled: "stalled", page: 1 });
    expect(screen.getByText(/1-2 of 14 total/i)).toBeInTheDocument();
  });

  it("filters quality results to failing evaluators", () => {
    render(
      <QualityView
        evaluations={[
          {
            evaluator: "groundedness",
            total: 5,
            passed: 4,
            failed: 1,
            avg_score: 0.88,
          },
          {
            evaluator: "style",
            total: 5,
            passed: 5,
            failed: 0,
            avg_score: 0.95,
          },
        ]}
        loading={false}
        error={null}
        onRetry={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText(/evaluation result filter/i), {
      target: { value: "failed-only" },
    });

    const table = screen.getByRole("table");
    expect(within(table).getByText("groundedness")).toBeInTheDocument();
    expect(within(table).queryByText("style")).not.toBeInTheDocument();
  });
});
