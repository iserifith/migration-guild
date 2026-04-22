import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useRegistryData,
  useRunLog,
  useSessions,
  useWavePlan,
} from "./hooks";
import {
  fetchArtifacts,
  fetchBlockers,
  fetchCost,
  fetchEvaluations,
  fetchIssues,
  fetchRunLog,
  fetchRuns,
  fetchSessions,
  fetchStatus,
  fetchWavePlan,
} from "./api";
import type {
  BlockerEntry,
  IssueEntry,
  RunEntry,
  SessionQuery,
  SessionEntry,
} from "./types";

vi.mock("./api", () => ({
  fetchArtifacts: vi.fn(),
  fetchBlockers: vi.fn(),
  fetchCost: vi.fn(),
  fetchEvaluations: vi.fn(),
  fetchEvents: vi.fn(),
  fetchIssues: vi.fn(),
  fetchRunLog: vi.fn(),
  fetchRuns: vi.fn(),
  fetchSessions: vi.fn(),
  fetchStatus: vi.fn(),
  fetchWavePlan: vi.fn(),
}));

function paged<T>(items: T[], overrides: Partial<{
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
}> = {}) {
  return {
    items,
    total: overrides.total ?? items.length,
    page: overrides.page ?? 1,
    page_size: overrides.page_size ?? 25,
    total_pages: overrides.total_pages ?? Math.max(1, Math.ceil((overrides.total ?? items.length) / (overrides.page_size ?? 25))),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("hooks", () => {
  beforeEach(() => {
    vi.resetAllMocks();

    vi.mocked(fetchArtifacts).mockResolvedValue([]);
    vi.mocked(fetchStatus).mockResolvedValue({
      files: {
        total: 0,
        completed: 0,
        in_progress: 0,
        pending: 0,
        by_status: {},
      },
      current_focus: null,
      next: null,
      open_blockers: [],
      open_issues: [],
    });
    vi.mocked(fetchWavePlan).mockResolvedValue([]);
    vi.mocked(fetchSessions).mockResolvedValue(
      paged<SessionEntry>([], { total: 0, total_pages: 1 }),
    );
    vi.mocked(fetchBlockers).mockResolvedValue(
      paged<BlockerEntry>([], { total: 0, total_pages: 1 }),
    );
    vi.mocked(fetchIssues).mockResolvedValue(
      paged<IssueEntry>([], { total: 0, total_pages: 1 }),
    );
    vi.mocked(fetchRuns).mockResolvedValue(
      paged<RunEntry>([], { total: 0, total_pages: 1 }),
    );
    vi.mocked(fetchEvaluations).mockResolvedValue([]);
    vi.mocked(fetchCost).mockResolvedValue({
      total_tokens_in: 0,
      total_tokens_out: 0,
      total_cost_usd: 0,
      total_calls: 0,
      by_model: [],
    });
    vi.mocked(fetchRunLog).mockResolvedValue("log output");
  });

  it("useWavePlan loads server-provided wave entries", async () => {
    vi.mocked(fetchWavePlan).mockResolvedValueOnce([
      { wave: 2, total: 5, by_status: { pending: 3, completed: 2 } },
    ]);

    const { result } = renderHook(() => useWavePlan());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(fetchWavePlan).toHaveBeenCalledOnce();
    expect(result.current.wavePlan).toEqual([
      { wave: 2, total: 5, by_status: { pending: 3, completed: 2 } },
    ]);
  });

  it("useSessions surfaces endpoint errors", async () => {
    vi.mocked(fetchSessions).mockRejectedValueOnce(new Error("sessions down"));

    const { result } = renderHook(() => useSessions());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error?.message).toBe("sessions down");
    expect(result.current.sessions).toEqual([]);
  });

  it("useSessions ignores stale responses when query changes rapidly", async () => {
    const first = deferred<{
      items: SessionEntry[];
      total: number;
      page: number;
      page_size: number;
      total_pages: number;
    }>();
    const second = deferred<{
      items: SessionEntry[];
      total: number;
      page: number;
      page_size: number;
      total_pages: number;
    }>();

    vi.mocked(fetchSessions)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const { result, rerender } = renderHook(
      ({ query }) => useSessions(query),
      {
        initialProps: {
          query: {
            stalled: "all",
            sort: "age-desc",
            page: 1,
            page_size: 25,
          } as SessionQuery,
        },
      },
    );

    rerender({
      query: {
        stalled: "stalled",
        sort: "age-desc",
        page: 1,
        page_size: 25,
      } as SessionQuery,
    });

    await act(async () => {
      second.resolve(
        paged([
          {
            id: "artifact-new",
            path: "src/New.ts",
            module: "core",
            role: "service",
            status: "in-progress",
            claimed_by: "agent-new",
            claimed_at: "2024-01-02T00:10:00Z",
            claimed_minutes_ago: 70,
            stalled: true,
          },
        ]),
      );
    });

    await waitFor(() => {
      expect(result.current.sessions).toEqual([
        expect.objectContaining({ id: "artifact-new" }),
      ]);
    });

    await act(async () => {
      first.resolve(
        paged([
          {
            id: "artifact-old",
            path: "src/Old.ts",
            module: "core",
            role: "service",
            status: "in-progress",
            claimed_by: "agent-old",
            claimed_at: "2024-01-02T00:00:00Z",
            claimed_minutes_ago: 5,
            stalled: false,
          },
        ]),
      );
    });

    expect(result.current.sessions).toEqual([
      expect.objectContaining({ id: "artifact-new" }),
    ]);
  });

  it("useRunLog waits for a selected run id before fetching", async () => {
    const { result, rerender } = renderHook(
      ({ runId }) => useRunLog(runId),
      { initialProps: { runId: null as string | null } },
    );

    expect(fetchRunLog).not.toHaveBeenCalled();
    expect(result.current.log).toBeNull();

    rerender({ runId: "run-7" });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(fetchRunLog).toHaveBeenCalledWith("run-7");
    expect(result.current.log).toBe("log output");
  });

  it("useRegistryData reload refreshes all active data surfaces", async () => {
    const { result } = renderHook(() =>
      useRegistryData({
        sessions: { stalled: "all", sort: "age-desc", page: 1, page_size: 25 },
        blockers: { sort: "oldest", page: 1, page_size: 25 },
        issues: { sort: "severity", page: 1, page_size: 25 },
        runs: { sort: "newest", page: 1, page_size: 25 },
      }),
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      result.current.reload();
    });

    await waitFor(() => {
      expect(vi.mocked(fetchArtifacts).mock.calls.length).toBeGreaterThan(1);
    });

    expect(vi.mocked(fetchStatus).mock.calls.length).toBeGreaterThan(1);
    expect(vi.mocked(fetchWavePlan).mock.calls.length).toBeGreaterThan(1);
    expect(vi.mocked(fetchSessions).mock.calls.length).toBeGreaterThan(1);
    expect(vi.mocked(fetchBlockers).mock.calls.length).toBeGreaterThan(1);
    expect(vi.mocked(fetchIssues).mock.calls.length).toBeGreaterThan(1);
    expect(vi.mocked(fetchRuns).mock.calls.length).toBeGreaterThan(1);
    expect(vi.mocked(fetchEvaluations).mock.calls.length).toBeGreaterThan(1);
    expect(vi.mocked(fetchCost).mock.calls.length).toBeGreaterThan(1);
  });
});
