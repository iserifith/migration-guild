import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { societyFixture } from "../fixtures/society";
import SocietyView from "./SocietyView";

describe("SocietyView", () => {
  it("renders all role lanes and their active counts", () => {
    render(<SocietyView data={societyFixture} />);

    expect(screen.getByRole("region", { name: "Builder lane" })).toHaveTextContent("3 active");
    expect(screen.getByRole("region", { name: "Critic lane" })).toHaveTextContent("2 active");
    expect(screen.getByRole("region", { name: "Arbiter lane" })).toHaveTextContent("1 pending");
    expect(screen.getByText("rejected")).toBeInTheDocument();
  });

  it("selecting an artifact chip swaps the lifecycle", () => {
    render(<SocietyView />);

    expect(screen.getByRole("heading", { name: "Chainr — lifecycle" })).toBeInTheDocument();
    const arbiterLane = screen.getByRole("region", { name: "Arbiter lane" });
    fireEvent.click(within(arbiterLane).getByRole("button", { name: /Removr/ }));
    expect(screen.getByRole("heading", { name: "Removr — lifecycle" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Chainr — lifecycle" })).not.toBeInTheDocument();
  });

  it("shows the rejection, rework, passing evidence, independence gate, and acceptance", () => {
    render(<SocietyView />);

    const fail = screen.getByText("FAIL");
    const passRows = screen.getAllByText("PASS");
    expect(fail).toBeInTheDocument();
    expect(screen.getByText("Arbiter rejected")).toBeInTheDocument();
    expect(screen.getByText("Builder re-migrated")).toBeInTheDocument();
    expect(passRows).toHaveLength(2);
    expect(screen.getByText(/producer critic-1 ≠ arbiter/)).toBeInTheDocument();
    expect(screen.getByText("Arbiter accepted")).toBeInTheDocument();
    expect(screen.getByText(/cites #e11, #e12/)).toBeInTheDocument();
  });
});
