/**
 * Tests for the typed API client (api.ts).
 *
 * Strategy: stub global.fetch so we can assert on URL construction and
 * response parsing without a running server.
 *
 * Coverage:
 *  - fetchArtifacts builds the correct URL with and without query params
 *  - fetchStatus calls the right endpoint
 *  - fetchEvents URL-encodes the artifact ID
 *  - buildUrl helper (via fetchArtifacts) omits blank/undefined params
 *  - API errors (non-2xx) are thrown as Error instances with the status code
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  fetchArtifacts,
  fetchStatus,
  fetchEvents,
  fetchWavePlan,
} from "./api";
import type { Artifact, StatusResponse, ArtifactEvent, WavePlanEntry } from "./types";

// ── Mock helpers ──────────────────────────────────────────────────────────────

function mockFetch<T>(body: T, status = 200): ReturnType<typeof vi.fn> {
  const mockFetchFn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: () => Promise.resolve(body),
  } as unknown as Response);
  vi.stubGlobal("fetch", mockFetchFn);
  return mockFetchFn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── fetchArtifacts ─────────────────────────────────────────────────────────────

describe("fetchArtifacts", () => {
  it("calls /api/artifacts with no query string when called with no args", async () => {
    const spy = mockFetch<Artifact[]>([]);
    await fetchArtifacts();
    expect(spy).toHaveBeenCalledWith("/api/artifacts");
  });

  it("appends status param when provided", async () => {
    const spy = mockFetch<Artifact[]>([]);
    await fetchArtifacts({ status: "in-progress" });
    expect(spy).toHaveBeenCalledWith("/api/artifacts?status=in-progress");
  });

  it("appends multiple query params", async () => {
    const spy = mockFetch<Artifact[]>([]);
    await fetchArtifacts({ status: "migrated", module: "acme", kind: "legacy-source" });
    const url = spy.mock.calls[0][0] as string;
    expect(url).toContain("status=migrated");
    expect(url).toContain("module=acme");
    expect(url).toContain("kind=legacy-source");
  });

  it("omits empty-string query params", async () => {
    const spy = mockFetch<Artifact[]>([]);
    await fetchArtifacts({ status: "", module: "acme" });
    const url = spy.mock.calls[0][0] as string;
    expect(url).not.toContain("status=");
    expect(url).toContain("module=acme");
  });

  it("returns the parsed JSON array", async () => {
    const artifacts: Partial<Artifact>[] = [{ id: "legacy-source:m:C", path: "Foo.java" }];
    mockFetch(artifacts);
    const result = await fetchArtifacts();
    expect(result).toEqual(artifacts);
  });
});

// ── fetchStatus ────────────────────────────────────────────────────────────────

describe("fetchStatus", () => {
  it("calls /api/status", async () => {
    const spy = mockFetch<StatusResponse>({
      files: { total: 0, completed: 0, in_progress: 0, by_status: {} },
      current_focus: null,
      next: null,
    });
    await fetchStatus();
    expect(spy).toHaveBeenCalledWith("/api/status");
  });

  it("returns the parsed status object", async () => {
    const status: StatusResponse = {
      files: { total: 5, completed: 2, in_progress: 1, by_status: { pending: 2, migrated: 2, "in-progress": 1 } },
      current_focus: null,
      next: null,
    };
    mockFetch(status);
    const result = await fetchStatus();
    expect(result.files.total).toBe(5);
    expect(result.files.by_status["in-progress"]).toBe(1);
  });
});

// ── fetchEvents ────────────────────────────────────────────────────────────────

describe("fetchEvents", () => {
  it("calls the events endpoint with the artifact id URL-encoded", async () => {
    const spy = mockFetch<ArtifactEvent[]>([]);
    await fetchEvents("legacy-source:com.acme:Foo");
    const url = spy.mock.calls[0][0] as string;
    expect(url).toContain("/api/events?id=");
    // Colons should be percent-encoded
    expect(url).toContain("%3A");
  });

  it("returns the parsed events array", async () => {
    const events: Partial<ArtifactEvent>[] = [
      { id: "evt1", event_type: "status-changed", agent: "migration-agent", note: "pending -> in-progress", created_at: "2024-01-01T00:00:00Z" },
    ];
    mockFetch(events);
    const result = await fetchEvents("legacy-source:m:C");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "evt1", event_type: "status-changed" });
  });
});

// ── fetchWavePlan ──────────────────────────────────────────────────────────────

describe("fetchWavePlan", () => {
  it("calls /api/wave-plan", async () => {
    const spy = mockFetch<WavePlanEntry[]>([]);
    await fetchWavePlan();
    expect(spy).toHaveBeenCalledWith("/api/wave-plan");
  });
});

// ── Error handling ─────────────────────────────────────────────────────────────

describe("API error handling", () => {
  it("throws an Error with the status code when the server returns non-2xx", async () => {
    mockFetch(null, 500);
    await expect(fetchArtifacts()).rejects.toThrow(/500/);
  });

  it("includes the URL in the error message", async () => {
    mockFetch(null, 404);
    await expect(fetchStatus()).rejects.toThrow("/api/status");
  });
});
