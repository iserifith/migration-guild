/**
 * Tests for the App shell.
 *
 * Strategy: mock the useRegistryData hook so we control loading/error/data
 * states without touching fetch. This keeps tests fast and deterministic.
 *
 * Coverage:
 *  - Loading state is shown while data is fetching
 *  - Both tabs are rendered in the nav
 *  - After load the default tab content is visible
 *  - Clicking a tab switches the view
 *  - An error from the hook surfaces a message in the UI
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import App from "./App";
import { useRegistryData } from "./hooks";
import type { Artifact, StatusResponse } from "./types";

// vi.mock is hoisted by Vitest so this always runs before imports settle.
vi.mock("./hooks", () => ({
  useRegistryData: vi.fn(),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

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
  claimed_from: null,
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-02T00:00:00Z",
};

const MOCK_STATUS: StatusResponse = {
  files: { total: 10, completed: 3, in_progress: 2, by_status: { "in-progress": 2, migrated: 3, pending: 5 } },
  current_focus: null,
  next: null,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function mockRegistryData(
  overrides: Partial<ReturnType<typeof useRegistryData>> = {}
) {
  vi.mocked(useRegistryData).mockReturnValue({
    artifacts: [MOCK_ARTIFACT],
    status: MOCK_STATUS,
    loading: false,
    error: null,
    reload: vi.fn(),
    ...overrides,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("App shell", () => {
  beforeEach(() => {
    vi.mocked(useRegistryData).mockReset();
  });

  it("shows a loading indicator while data is being fetched", () => {
    mockRegistryData({ loading: true, artifacts: [], status: null });
    render(<App />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("renders the application title", () => {
    mockRegistryData();
    render(<App />);
    expect(screen.getByRole("heading", { name: /legmod/i })).toBeInTheDocument();
  });

  it("renders the Artifacts and Wave Plan tabs", () => {
    mockRegistryData();
    render(<App />);
    expect(screen.getByText("Artifacts")).toBeInTheDocument();
    expect(screen.getByText("Wave Plan")).toBeInTheDocument();
  });

  it("shows the Artifacts table by default after load", () => {
    mockRegistryData();
    render(<App />);
    // The table header cell is only rendered when ArtifactList is mounted
    expect(screen.getByRole("columnheader", { name: /path/i })).toBeInTheDocument();
  });

  it("switches to Wave Plan when that tab is clicked", () => {
    mockRegistryData();
    render(<App />);
    fireEvent.click(screen.getByText("Wave Plan"));
    // WavePlan renders wave cards, or the empty message if no wave data
    // Either way the artifact table columns should no longer be present
    expect(screen.queryByRole("columnheader", { name: /path/i })).not.toBeInTheDocument();
  });

  it("displays status badge counts from the status response", () => {
    mockRegistryData();
    render(<App />);
    // "2 in-progress", "3 migrated", "5 pending" should all appear in the header
    expect(screen.getByText(/2\s+in-progress/)).toBeInTheDocument();
    expect(screen.getByText(/3\s+migrated/)).toBeInTheDocument();
  });

  it("shows an error message when the hook returns an error", () => {
    mockRegistryData({ loading: false, error: new Error("Network failure"), artifacts: [], status: null });
    render(<App />);
    expect(screen.getByText(/failed to load registry data/i)).toBeInTheDocument();
    expect(screen.getByText(/network failure/i)).toBeInTheDocument();
  });

  it("calls reload when the refresh button is clicked", () => {
    const reload = vi.fn();
    mockRegistryData({ reload });
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    expect(reload).toHaveBeenCalledOnce();
  });
});
