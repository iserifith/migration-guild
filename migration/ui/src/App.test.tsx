/**
 * Tests for the App shell.
 *
 * Strategy: mock the hook layer so we control loading/error/data states
 * without touching fetch. This keeps tests fast and deterministic.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import App from "./App";
import { useRegistryData, useRunLog } from "./hooks";
import type { Artifact, StatusResponse } from "./types";

vi.mock("./hooks", () => ({
  useRegistryData: vi.fn(),
  useRunLog: vi.fn(),
}));

const MOCK_ARTIFACT: Artifact = {
  id: "legacy-source:com.acme:Foo",
  slug: "legacy-source--com.acme--foo",
  kind: "legacy-source",
  tier: "first-class",
  path: "legacy/src/main/java/com/acme/Foo.java",
  module: "acme",
  role: "service",
  framework: null,
  status: "in-progress",
  wave: 1,
  data_path: null,
  claimed_by: null,
  claimed_at: null,
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-02T00:00:00Z",
};

const MOCK_STATUS: StatusResponse = {
  files: {
    total: 10,
    completed: 3,
    in_progress: 2,
    pending: 5,
    by_status: { "in-progress": 2, migrated: 3, pending: 5 },
  },
  current_focus: null,
  next: null,
  open_blockers: [],
  open_issues: [],
};

function mockRegistryData(
  overrides: Partial<ReturnType<typeof useRegistryData>> = {},
) {
  vi.mocked(useRegistryData).mockReturnValue({
    artifacts: {
      artifacts: [MOCK_ARTIFACT],
      loading: false,
      error: null,
      reload: vi.fn(),
    },
    status: {
      status: MOCK_STATUS,
      loading: false,
      error: null,
      reload: vi.fn(),
    },
    wavePlan: {
      wavePlan: [{ wave: 7, total: 4, by_status: { pending: 3, completed: 1 } }],
      loading: false,
      error: null,
      reload: vi.fn(),
    },
    sessions: {
      sessions: [
        {
          id: MOCK_ARTIFACT.id,
          path: MOCK_ARTIFACT.path,
          module: MOCK_ARTIFACT.module,
          role: MOCK_ARTIFACT.role,
          status: MOCK_ARTIFACT.status,
          claimed_by: "agent-1",
          claimed_at: "2024-01-02T00:00:00Z",
          claimed_minutes_ago: 90,
          stalled: true,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 25,
      totalPages: 1,
      availableFilters: { statuses: ["in-progress"] },
      loading: false,
      error: null,
      reload: vi.fn(),
    },
    blockers: {
      blockers: [
        {
          artifact_id: MOCK_ARTIFACT.id,
          blocker_id: "blk-1",
          summary: "Waiting for decision",
          since: "2024-01-02T00:00:00Z",
        },
      ],
      total: 1,
      page: 1,
      pageSize: 25,
      totalPages: 1,
      loading: false,
      error: null,
      reload: vi.fn(),
    },
    issues: {
      issues: [
        {
          artifact_id: MOCK_ARTIFACT.id,
          issue_id: "iss-1",
          severity: "high",
          category: "behavior",
          summary: "Needs follow-up",
          ts: "2024-01-02T00:00:00Z",
        },
      ],
      total: 1,
      page: 1,
      pageSize: 25,
      totalPages: 1,
      availableFilters: { severities: ["high"], categories: ["behavior"] },
      loading: false,
      error: null,
      reload: vi.fn(),
    },
    runs: {
      runs: [
        {
          run_id: "run-1",
          agent: "migration-agent",
          model: "gpt-5.4",
          status: "completed",
          started_at: "2024-01-02T00:00:00Z",
          finished_at: "2024-01-02T00:10:00Z",
          exit_code: 0,
          log_file: "/tmp/run-1.log",
        },
      ],
      total: 1,
      page: 1,
      pageSize: 25,
      totalPages: 1,
      availableFilters: {
        agents: ["migration-agent", "review-agent"],
        statuses: ["completed", "failed"],
        models: ["gpt-5.4", "gpt-5-mini"],
      },
      loading: false,
      error: null,
      reload: vi.fn(),
    },
    evaluations: {
      evaluations: [
        {
          evaluator: "groundedness",
          total: 4,
          passed: 3,
          failed: 1,
          avg_score: 0.87,
        },
      ],
      loading: false,
      error: null,
      reload: vi.fn(),
    },
    cost: {
      cost: {
        total_tokens_in: 120,
        total_tokens_out: 240,
        total_cost_usd: 1.25,
        total_calls: 3,
        by_model: [
          {
            model: "gpt-5.4",
            calls: 3,
            tokens_in: 120,
            tokens_out: 240,
            cost_usd: 1.25,
          },
        ],
      },
      loading: false,
      error: null,
      reload: vi.fn(),
    },
    loading: false,
    error: null,
    reload: vi.fn(),
    ...overrides,
  });
}

describe("App shell", () => {
  beforeEach(() => {
    vi.mocked(useRegistryData).mockReset();
    vi.mocked(useRunLog).mockReset();
    vi.mocked(useRunLog).mockReturnValue({
      log: null,
      loading: false,
      error: null,
      reload: vi.fn(),
    });
  });

  it("shows a loading indicator while data is being fetched", () => {
    mockRegistryData({
      artifacts: {
        artifacts: [],
        loading: true,
        error: null,
        reload: vi.fn(),
      },
      status: {
        status: null,
        loading: false,
        error: null,
        reload: vi.fn(),
      },
    });
    render(<App />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("renders the application title", () => {
    mockRegistryData();
    render(<App />);
    expect(screen.getByRole("heading", { name: /legmod/i })).toBeInTheDocument();
  });

  it("renders all active monitoring tabs", () => {
    mockRegistryData();
    render(<App />);
    for (const label of [
      "Artifacts",
      "Wave Plan",
      "Sessions",
      "Blockers",
      "Runs",
      "Quality",
      "Cost",
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("shows the Artifacts table by default after load", () => {
    mockRegistryData();
    render(<App />);
    expect(screen.getByRole("columnheader", { name: /path/i })).toBeInTheDocument();
  });

  it("renders server-backed wave data even when the artifact list is empty", () => {
    mockRegistryData({
      artifacts: {
        artifacts: [],
        loading: false,
        error: null,
        reload: vi.fn(),
      },
    });
    render(<App />);
    fireEvent.click(screen.getByText("Wave Plan"));
    expect(screen.getByText(/wave 7/i)).toBeInTheDocument();
    expect(screen.getByText(/4 files/i)).toBeInTheDocument();
  });

  it("switches to each new monitoring tab and renders its content", () => {
    mockRegistryData();
    render(<App />);

    fireEvent.click(screen.getByText("Sessions"));
    expect(screen.getByText(/1-1 of 1 total/i)).toBeInTheDocument();

    fireEvent.click(screen.getByText("Blockers"));
    expect(screen.getByRole("heading", { name: /open blockers/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /open issues/i })).toBeInTheDocument();

    fireEvent.click(screen.getByText("Runs"));
    expect(screen.getByRole("heading", { name: /run log/i })).toBeInTheDocument();

    fireEvent.click(screen.getByText("Quality"));
    expect(screen.getByRole("columnheader", { name: /avg score/i })).toBeInTheDocument();

    fireEvent.click(screen.getByText("Cost"));
    expect(screen.getAllByText(/\$1\.2500/)).toHaveLength(2);
  });

  it("passes updated run query state back into the hook when filters change", () => {
    mockRegistryData();
    render(<App />);

    fireEvent.click(screen.getByText("Runs"));
    fireEvent.change(screen.getByLabelText(/run agent filter/i), {
      target: { value: "review-agent" },
    });

    expect(vi.mocked(useRegistryData).mock.lastCall?.[0]).toMatchObject({
      runs: expect.objectContaining({ agent: "review-agent", page: 1 }),
    });
  });

  it("switches timestamp rendering between utc and local mode", () => {
    mockRegistryData();
    render(<App />);

    fireEvent.click(screen.getByText("Runs"));
    expect(screen.getByText("2024-01-02 00:00 UTC")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/time display mode/i), {
      target: { value: "local" },
    });

    expect(screen.getAllByText(/Local$/).length).toBeGreaterThan(0);
  });

  it("displays status badge counts from the status response", () => {
    mockRegistryData();
    render(<App />);
    expect(screen.getByText(/2\s+in-progress/)).toBeInTheDocument();
    expect(screen.getByText(/3\s+migrated/)).toBeInTheDocument();
  });

  it("shows an error message when the hook returns an error", () => {
    mockRegistryData({
      artifacts: {
        artifacts: [],
        loading: false,
        error: new Error("Network failure"),
        reload: vi.fn(),
      },
    });
    render(<App />);
    expect(screen.getByText(/couldn't load artifacts/i)).toBeInTheDocument();
    expect(screen.getByText(/network failure/i)).toBeInTheDocument();
  });

  it("calls reload when the refresh button is clicked", () => {
    const reload = vi.fn();
    mockRegistryData({ reload });
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    expect(reload).toHaveBeenCalledOnce();
  });

  it("retries only the active tab data source", () => {
    const sessionsReload = vi.fn();
    const reload = vi.fn();

    mockRegistryData({
      sessions: {
        sessions: [],
        total: 0,
        page: 1,
        pageSize: 25,
        totalPages: 1,
        availableFilters: { statuses: ["in-progress"] },
        loading: false,
        error: new Error("sessions down"),
        reload: sessionsReload,
      },
      reload,
    });

    render(<App />);
    fireEvent.click(screen.getByText("Sessions"));
    fireEvent.click(screen.getByRole("button", { name: /retry sessions/i }));

    expect(sessionsReload).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
  });
});
