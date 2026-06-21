import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import BlockersView from "./components/BlockersView";
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

    fireEvent.click(screen.getByText("run-1"));
    expect(screen.getByText("Selected run: run-1")).toBeInTheDocument();
    expect(screen.getByText("2 of 2 lines")).toBeInTheDocument();
    expect(screen.getByText("first line")).toBeInTheDocument();
    expect(screen.getByText("second line")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/run log filter/i), {
      target: { value: "second" },
    });

    expect(screen.getByText("second line")).toBeInTheDocument();
    expect(screen.getByText("1 of 2 lines")).toBeInTheDocument();
    expect(screen.queryByText("first line")).not.toBeInTheDocument();
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
});
