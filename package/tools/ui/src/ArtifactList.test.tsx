/**
 * Tests for ArtifactList — the shared data-fetching/render path.
 *
 * ArtifactList is a pure presentational component (no internal fetch calls
 * after the refactor — data arrives via props from the App shell). This makes
 * it straightforward to test rendering and filter logic directly.
 *
 * Coverage:
 *  - Renders a row per artifact
 *  - Shows the empty message when no artifacts match the active filter
 *  - Status filter hides non-matching rows
 *  - Module filter hides non-matching rows
 *  - Count indicator reflects filtered / total
 *  - Clicking a row toggles the detail panel (smoke test)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import ArtifactList from "./components/ArtifactList";
import { useEvents } from "./hooks";
import type { Artifact, ArtifactEvent } from "./types";

// vi.mock is hoisted by Vitest so the stub is in place before any module settles.
vi.mock("./hooks", () => ({
  useEvents: vi.fn(),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: `legacy-source:com.acme:${overrides.path ?? "Foo"}`,
    slug: "legacy-source--com.acme--foo",
    kind: "legacy-source",
    tier: "first-class",
    path: "legacy/Foo.java",
    module: "acme",
    role: "service",
    framework: null,
    status: "pending",
    wave: 1,
    data_path: null,
    claimed_by: null,
    claimed_at: null,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

const ARTIFACTS: Artifact[] = [
  makeArtifact({ id: "legacy-source:acme:Alpha", path: "Alpha.java", status: "pending",     module: "acme" }),
  makeArtifact({ id: "legacy-source:acme:Beta",  path: "Beta.java",  status: "in-progress", module: "acme" }),
  makeArtifact({ id: "legacy-source:core:Gamma", path: "Gamma.java", status: "migrated",    module: "core" }),
];

// Stub useEvents so ArtifactDetail (mounted when a row is clicked) doesn't
// attempt a real fetch.
beforeEach(() => {
  vi.mocked(useEvents).mockReturnValue({
    events: [] as ArtifactEvent[],
    loading: false,
    error: null,
    reload: vi.fn(),
  });
});

afterEach(() => {
  vi.mocked(useEvents).mockReset();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ArtifactList", () => {
  const renderList = (artifacts: Artifact[] = ARTIFACTS) =>
    render(
      <ArtifactList
        artifacts={artifacts}
        loading={false}
        error={null}
        onRetry={vi.fn()}
        timeMode="utc"
      />,
    );

  it("renders a table row for each artifact", () => {
    renderList();
    const rows = screen.getAllByRole("row");
    // +1 for the header row
    expect(rows).toHaveLength(ARTIFACTS.length + 1);
  });

  it("shows artifact paths in the table", () => {
    renderList();
    expect(screen.getByText("Alpha.java")).toBeInTheDocument();
    expect(screen.getByText("Beta.java")).toBeInTheDocument();
    expect(screen.getByText("Gamma.java")).toBeInTheDocument();
  });

  it("shows count as 'total / total' when no filter is active", () => {
    renderList();
    expect(screen.getByText(`${ARTIFACTS.length} / ${ARTIFACTS.length}`)).toBeInTheDocument();
  });

  it("filters rows by status and updates the count", () => {
    renderList();
    const selects = screen.getAllByRole("combobox");
    // First select is the status filter
    fireEvent.change(selects[0], { target: { value: "in-progress" } });

    expect(screen.queryByText("Alpha.java")).not.toBeInTheDocument();
    expect(screen.getByText("Beta.java")).toBeInTheDocument();
    expect(screen.queryByText("Gamma.java")).not.toBeInTheDocument();
    expect(screen.getByText("1 / 3")).toBeInTheDocument();
  });

  it("filters rows by module", () => {
    renderList();
    const selects = screen.getAllByRole("combobox");
    // Second select is the module filter
    fireEvent.change(selects[1], { target: { value: "core" } });

    expect(screen.getByText("Gamma.java")).toBeInTheDocument();
    expect(screen.queryByText("Alpha.java")).not.toBeInTheDocument();
    expect(screen.getByText("1 / 3")).toBeInTheDocument();
  });

  it("shows the empty message when no artifacts match the filter", () => {
    renderList();
    const selects = screen.getAllByRole("combobox");
    fireEvent.change(selects[0], { target: { value: "reviewed" } });
    expect(screen.getByText(/no artifacts match filters/i)).toBeInTheDocument();
    expect(screen.getByText("0 / 3")).toBeInTheDocument();
  });

  it("shows the empty message when the artifact list is empty", () => {
    renderList([]);
    expect(screen.getByText(/no artifacts found/i)).toBeInTheDocument();
  });

  it("opens the detail panel when a row is clicked", () => {
    renderList();
    // Click the first data row
    const rows = screen.getAllByRole("row");
    fireEvent.click(rows[1]); // rows[0] is the header
    // Detail panel should now contain the artifact id
    expect(screen.getByRole("heading", { name: /alpha/i })).toBeInTheDocument();
  });

  it("closes the detail panel when the same row is clicked again", () => {
    renderList();
    const rows = screen.getAllByRole("row");
    fireEvent.click(rows[1]);
    // Panel should be open
    expect(screen.getByRole("heading", { name: /alpha/i })).toBeInTheDocument();
    // Click again to close
    fireEvent.click(rows[1]);
    expect(screen.queryByRole("heading", { name: /alpha/i })).not.toBeInTheDocument();
  });

  it("closes the detail panel via the close button", () => {
    renderList();
    const rows = screen.getAllByRole("row");
    fireEvent.click(rows[1]);
    const detail = screen.getByRole("heading", { name: /alpha/i }).closest("div.detail") as HTMLElement;
    const closeBtn = within(detail).getByRole("button");
    fireEvent.click(closeBtn);
    expect(screen.queryByRole("heading", { name: /alpha/i })).not.toBeInTheDocument();
  });
});
