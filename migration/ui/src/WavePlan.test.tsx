import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import WavePlan from "./components/WavePlan";

describe("WavePlan", () => {
  it("renders endpoint-backed wave entries", () => {
    render(
      <WavePlan
        entries={[{ wave: 3, total: 8, by_status: { pending: 3, completed: 5 } }]}
        loading={false}
        error={null}
        onRetry={() => undefined}
      />,
    );

    expect(screen.getByText(/wave 3/i)).toBeInTheDocument();
    expect(screen.getByText(/8 files · 63% done/i)).toBeInTheDocument();
    expect(screen.getByText(/5 completed/i)).toBeInTheDocument();
  });

  it("shows a clear error state", () => {
    render(
      <WavePlan
        entries={[]}
        loading={false}
        error={new Error("offline")}
        onRetry={() => undefined}
      />,
    );
    expect(screen.getByText(/couldn't load wave plan/i)).toBeInTheDocument();
    expect(screen.getByText(/offline/i)).toBeInTheDocument();
  });
});
