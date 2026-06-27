import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import MissionControl from "./MissionControl";
import { missionControlFixture } from "../fixtures/mission-control";

describe("MissionControl", () => {
  it("renders all live operational panels from the typed fixture", () => {
    render(<MissionControl data={missionControlFixture} />);

    expect(screen.getByText("Completion")).toBeInTheDocument();
    expect(screen.getByText("Evidence pass rate")).toBeInTheDocument();
    expect(screen.getByText("Awaiting arbitration")).toBeInTheDocument();
    expect(screen.getByText("Throughput")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /agent society/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Wave pipeline" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Live activity" })).toBeInTheDocument();
  });

  it("shows role counts, the evidence gate, wave progress, and recent activity", () => {
    render(<MissionControl />);

    expect(screen.getByText("3 active")).toBeInTheDocument();
    expect(screen.getByText("2 active")).toBeInTheDocument();
    expect(screen.getByText("1 pending")).toBeInTheDocument();
    expect(screen.getByText("Evidence gate")).toBeInTheDocument();
    expect(screen.getByText(/no self-approval/i)).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Wave 2 progress" })).toHaveAttribute("aria-valuenow", "75");
    expect(screen.getByText(/accepted Chainr/)).toBeInTheDocument();
    expect(screen.queryByText(/benchmark/i)).not.toBeInTheDocument();
  });
});
