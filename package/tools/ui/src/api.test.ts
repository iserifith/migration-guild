/**
 * Tests for the typed API client (api.ts).
 *
 * Strategy: stub global.fetch so we can assert on URL construction and
 * response parsing without a running server.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchArtifacts,
  fetchBlockers,
  fetchEvents,
  fetchIssues,
  fetchRunLog,
  fetchRuns,
  fetchSessions,
  fetchStatus,
  fetchWavePlan,
  getSociety,
} from "./api";
import type {
  Artifact,
  ArtifactEvent,
  BlockerEntry,
  BlockerListResult,
  IssueListResult,
  IssueEntry,
  RunEntry,
  RunListResult,
  SessionEntry,
  SessionListResult,
  StatusResponse,
  WavePlanEntry,
} from "./types";

function mockJsonFetch<T>(body: T, status = 200): ReturnType<typeof vi.fn> {
  const mockFetchFn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: () => Promise.resolve(body),
  } as unknown as Response);
  vi.stubGlobal("fetch", mockFetchFn);
  return mockFetchFn;
}

function mockTextFetch(body: string, status = 200): ReturnType<typeof vi.fn> {
  const mockFetchFn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    text: () => Promise.resolve(body),
  } as unknown as Response);
  vi.stubGlobal("fetch", mockFetchFn);
  return mockFetchFn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchArtifacts", () => {
  it("calls /api/artifacts with no query string when called with no args", async () => {
    const spy = mockJsonFetch<Artifact[]>([]);
    await fetchArtifacts();
    expect(spy).toHaveBeenCalledWith("/api/artifacts");
  });

  it("appends supported query params", async () => {
    const spy = mockJsonFetch<Artifact[]>([]);
    await fetchArtifacts({
      status: "migrated",
      module: "acme",
      kind: "legacy-source",
      tier: "first-class",
    });
    const url = spy.mock.calls[0][0] as string;
    expect(url).toContain("status=migrated");
    expect(url).toContain("module=acme");
    expect(url).toContain("kind=legacy-source");
    expect(url).toContain("tier=first-class");
  });

  it("omits empty-string query params", async () => {
    const spy = mockJsonFetch<Artifact[]>([]);
    await fetchArtifacts({ module: "acme" });
    const url = spy.mock.calls[0][0] as string;
    expect(url).not.toContain("status=");
    expect(url).toContain("module=acme");
  });

  it("returns the parsed JSON array", async () => {
    const artifacts: Partial<Artifact>[] = [{ id: "legacy-source:m:C", path: "Foo.java" }];
    mockJsonFetch(artifacts);
    const result = await fetchArtifacts();
    expect(result).toEqual(artifacts);
  });
});

describe("fetchStatus", () => {
  it("calls /api/status", async () => {
    const spy = mockJsonFetch<StatusResponse>({
      files: { total: 0, completed: 0, in_progress: 0, pending: 0, by_status: {} },
      current_focus: null,
      next: null,
      open_blockers: [],
      open_issues: [],
    });
    await fetchStatus();
    expect(spy).toHaveBeenCalledWith("/api/status");
  });

  it("returns the parsed status object", async () => {
    const status: StatusResponse = {
      files: {
        total: 5,
        completed: 2,
        in_progress: 1,
        pending: 2,
        by_status: { pending: 2, migrated: 2, "in-progress": 1 },
      },
      current_focus: null,
      next: null,
      open_blockers: [],
      open_issues: [],
    };
    mockJsonFetch(status);
    const result = await fetchStatus();
    expect(result.files.total).toBe(5);
    expect(result.files.pending).toBe(2);
    expect(result.files.by_status["in-progress"]).toBe(1);
  });
});

describe("getSociety", () => {
  it("calls the aggregate and per-artifact forms", async () => {
    const spy = mockJsonFetch({ roles: {} });
    await getSociety();
    await getSociety({ id: "legacy-source:com.acme:Foo" });
    expect(spy).toHaveBeenNthCalledWith(1, "/api/society");
    expect(spy).toHaveBeenNthCalledWith(2, "/api/society?id=legacy-source%3Acom.acme%3AFoo");
  });
});

describe("fetchWavePlan", () => {
  it("calls /api/wave-plan", async () => {
    const spy = mockJsonFetch<WavePlanEntry[]>([]);
    await fetchWavePlan();
    expect(spy).toHaveBeenCalledWith("/api/wave-plan");
  });
});

describe("fetchEvents", () => {
  it("calls the events endpoint with the artifact id URL-encoded", async () => {
    const spy = mockJsonFetch<ArtifactEvent[]>([]);
    await fetchEvents({ id: "legacy-source:com.acme:Foo" });
    expect(spy).toHaveBeenCalledWith("/api/events?id=legacy-source%3Acom.acme%3AFoo");
  });

  it("appends limit when provided", async () => {
    const spy = mockJsonFetch<ArtifactEvent[]>([]);
    await fetchEvents({ id: "legacy-source:m:C", limit: 25 });
    expect(spy).toHaveBeenCalledWith(
      "/api/events?id=legacy-source%3Am%3AC&limit=25",
    );
  });

  it("returns the parsed events array", async () => {
    const events: Partial<ArtifactEvent>[] = [
      {
        id: "evt1",
        event_type: "status-changed",
        agent: "migration-agent",
        note: "pending -> in-progress",
        created_at: "2024-01-01T00:00:00Z",
      },
    ];
    mockJsonFetch(events);
    const result = await fetchEvents({ id: "legacy-source:m:C" });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "evt1", event_type: "status-changed" });
  });
});

describe("fetchSessions", () => {
  it("calls /api/sessions with no query string by default", async () => {
    const spy = mockJsonFetch<SessionEntry[]>([]);
    const result = await fetchSessions();
    expect(spy).toHaveBeenCalledWith("/api/sessions");
    expect(result).toEqual({
      items: [],
      total: null,
      page: 1,
      page_size: 0,
      total_pages: null,
    } satisfies SessionListResult);
  });

  it("appends server-side session query params when provided", async () => {
    const spy = mockJsonFetch<SessionEntry[]>([]);
    await fetchSessions({
      stall_minutes: 90,
      stalled: "stalled",
      sort: "artifact",
      page: 2,
      page_size: 10,
    });
    expect(spy).toHaveBeenCalledWith(
      "/api/sessions?stall_minutes=90&stalled=stalled&sort=artifact&page=2&page_size=10",
    );
  });

  it("normalizes paged responses", async () => {
    mockJsonFetch({
      items: [{ id: "artifact-1" }] as Partial<SessionEntry>[],
      total: 20,
      page: 2,
      page_size: 10,
      total_pages: 2,
      available_filters: { statuses: ["in-progress"] },
    });

    const result = await fetchSessions({ page: 2, page_size: 10 });

    expect(result).toMatchObject({
      items: [{ id: "artifact-1" }],
      total: 20,
      page: 2,
      page_size: 10,
      total_pages: 2,
      available_filters: { statuses: ["in-progress"] },
    });
  });
});

describe("fetchBlockers", () => {
  it("calls /api/blockers and normalizes legacy array responses", async () => {
    const spy = mockJsonFetch<BlockerEntry[]>([]);
    const result = await fetchBlockers();
    expect(spy).toHaveBeenCalledWith("/api/blockers");
    expect(result).toEqual({
      items: [],
      total: null,
      page: 1,
      page_size: 0,
      total_pages: null,
    } satisfies BlockerListResult);
  });

  it("appends blocker query params", async () => {
    const spy = mockJsonFetch<BlockerEntry[]>([]);
    await fetchBlockers({ q: "decision", sort: "artifact", page: 3, page_size: 50 });
    expect(spy).toHaveBeenCalledWith(
      "/api/blockers?q=decision&sort=artifact&page=3&page_size=50",
    );
  });
});

describe("fetchIssues", () => {
  it("calls /api/issues and normalizes legacy array responses", async () => {
    const spy = mockJsonFetch<IssueEntry[]>([]);
    const result = await fetchIssues();
    expect(spy).toHaveBeenCalledWith("/api/issues");
    expect(result).toEqual({
      items: [],
      total: null,
      page: 1,
      page_size: 0,
      total_pages: null,
    } satisfies IssueListResult);
  });

  it("appends issue query params", async () => {
    const spy = mockJsonFetch<IssueEntry[]>([]);
    await fetchIssues({
      severity: "high",
      category: "behavior",
      sort: "latest",
      page: 4,
      page_size: 25,
    });
    expect(spy).toHaveBeenCalledWith(
      "/api/issues?severity=high&category=behavior&sort=latest&page=4&page_size=25",
    );
  });
});

describe("fetchRuns", () => {
  it("calls /api/runs with no query string by default", async () => {
    const spy = mockJsonFetch<RunEntry[]>([]);
    const result = await fetchRuns();
    expect(spy).toHaveBeenCalledWith("/api/runs");
    expect(result).toEqual({
      items: [],
      total: null,
      page: 1,
      page_size: 0,
      total_pages: null,
    } satisfies RunListResult);
  });

  it("appends supported query params", async () => {
    const spy = mockJsonFetch<RunEntry[]>([]);
    await fetchRuns({
      agent: "migration-agent",
      status: "completed",
      model: "gpt-5.4",
      sort: "duration",
      page: 2,
      page_size: 25,
    });
    expect(spy).toHaveBeenCalledWith(
      "/api/runs?agent=migration-agent&status=completed&model=gpt-5.4&sort=duration&page=2&page_size=25",
    );
  });

  it("normalizes paged run responses", async () => {
    mockJsonFetch({
      items: [{ run_id: "run-1" }] as Partial<RunEntry>[],
      total: 50,
      page: 2,
      page_size: 25,
      total_pages: 2,
      available_filters: {
        agents: ["migration-agent"],
        statuses: ["completed"],
        models: ["gpt-5.4"],
      },
    });

    const result = await fetchRuns({ page: 2, page_size: 25 });

    expect(result).toMatchObject({
      items: [{ run_id: "run-1" }],
      total: 50,
      page: 2,
      page_size: 25,
      total_pages: 2,
      available_filters: {
        agents: ["migration-agent"],
        statuses: ["completed"],
        models: ["gpt-5.4"],
      },
    });
  });
});

describe("fetchRunLog", () => {
  it("calls the run log endpoint with the run id URL-encoded", async () => {
    const spy = mockTextFetch("log output");
    await fetchRunLog("run/1");
    expect(spy).toHaveBeenCalledWith("/api/runs/run%2F1/log");
  });

  it("returns the plain-text log body", async () => {
    mockTextFetch("line 1\nline 2");
    const result = await fetchRunLog("run-1");
    expect(result).toBe("line 1\nline 2");
  });
});



describe("API error handling", () => {
  it("throws an Error with the status code when the server returns non-2xx", async () => {
    mockJsonFetch(null, 500);
    await expect(fetchArtifacts()).rejects.toThrow(/500/);
  });

  it("includes the URL in the error message", async () => {
    mockJsonFetch(null, 404);
    await expect(fetchStatus()).rejects.toThrow("/api/status");
  });

  it("throws for text endpoints too", async () => {
    mockTextFetch("", 404);
    await expect(fetchRunLog("missing-run")).rejects.toThrow(
      "/api/runs/missing-run/log",
    );
  });
});
