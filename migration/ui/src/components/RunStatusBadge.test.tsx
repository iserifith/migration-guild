/**
 * T008/T011/T013 (spec 016, #220) — RunStatusBadge tests.
 *
 * Covers all three user stories with one shared component:
 *  - US1: renders "working" for a working-labeled entry, and a poll-cycle
 *    refetch that flips an entry from working -> idle updates the badge
 *    without a manual reload (SC-003, FR-011).
 *  - US2: renders "idle" distinctly from "working".
 *  - US3: renders "waiting-for-approval"/"rejected" through the same shared
 *    styling system as "working"/"idle" (not ApprovalsPanel-specific markup).
 */
import { act, render, renderHook, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import RunStatusBadge, { RunStatusLegend } from "./RunStatusBadge";
import { RUN_STATUS_COLORS } from "../constants";
import { useRunStatus } from "../hooks";
import { fetchRunStatus } from "../api";
import type { RunStatusEntry } from "../types";

vi.mock("../api", () => ({
  fetchRunStatus: vi.fn(),
}));

describe("RunStatusBadge", () => {
  it('renders "working" for a working-labeled entry', () => {
    render(<RunStatusBadge label="working" />);
    expect(screen.getByText("working")).toBeInTheDocument();
  });

  it('renders "idle" for an idle-labeled entry, visually distinct from "working"', () => {
    render(<RunStatusBadge label="idle" />);
    const badge = screen.getByText("idle");
    expect(badge).toBeInTheDocument();
    expect(RUN_STATUS_COLORS.idle).not.toBe(RUN_STATUS_COLORS.working);
  });

  it('renders "waiting-for-approval" and "rejected" via the same shared badge markup as working/idle', () => {
    const { container: waiting } = render(<RunStatusBadge label="waiting-for-approval" />);
    const { container: rejected } = render(<RunStatusBadge label="rejected" />);
    const { container: working } = render(<RunStatusBadge label="working" />);

    const waitingBadge = waiting.querySelector(".run-status-badge");
    const rejectedBadge = rejected.querySelector(".run-status-badge");
    const workingBadge = working.querySelector(".run-status-badge");

    expect(waitingBadge).not.toBeNull();
    expect(rejectedBadge).not.toBeNull();
    expect(waitingBadge?.className).toContain("run-status-badge");
    expect(rejectedBadge?.className).toContain("run-status-badge");
    expect(workingBadge?.className).toContain("run-status-badge");

    expect(screen.getByText("waiting for approval")).toBeInTheDocument();
    expect(screen.getAllByText("rejected").length).toBeGreaterThan(0);
  });

  it("RunStatusLegend renders all four labels using the shared vocabulary", () => {
    render(<RunStatusLegend />);
    expect(screen.getByText("working")).toBeInTheDocument();
    expect(screen.getByText("idle")).toBeInTheDocument();
    expect(screen.getByText("waiting for approval")).toBeInTheDocument();
    expect(screen.getByText("rejected")).toBeInTheDocument();
  });
});

describe("RunStatusBadge + useRunStatus poll cycle", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("a poll-cycle refetch that changes working -> idle updates the badge without a manual reload", async () => {
    vi.useFakeTimers();
    vi.mocked(fetchRunStatus)
      .mockResolvedValueOnce([
        { artifact_id: "legacy-source:com.acme:Foo", label: "working", heartbeat_age_ms: 1000 },
      ] as RunStatusEntry[])
      .mockResolvedValueOnce([
        { artifact_id: "legacy-source:com.acme:Foo", label: "idle", heartbeat_age_ms: 999_000 },
      ] as RunStatusEntry[]);

    const { result } = renderHook(() => useRunStatus());

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.runStatus[0]?.label).toBe("working");

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchRunStatus).toHaveBeenCalledTimes(2);
    expect(result.current.runStatus[0]?.label).toBe("idle");
    vi.useRealTimers();
  });
});
