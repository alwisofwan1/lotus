import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AutomationBoundary } from "../AutomationBoundary";

let broken = true;
function Card() {
  if (broken) throw new Error("draft.content.comments is undefined");
  return <p>Card</p>;
}

describe("AutomationBoundary", () => {
  const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
  afterEach(() => {
    broken = true;
    quiet.mockClear();
  });

  it("keeps a crash inside its region, says why, and tries again on request", () => {
    render(
      <>
        <nav>Sidebar</nav>
        <AutomationBoundary region="reader">
          <Card />
        </AutomationBoundary>
      </>,
    );
    expect(screen.getByText("Sidebar")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("draft.content.comments is undefined");
    broken = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByText("Card")).toBeInTheDocument();
  });

  it("starts fresh when what the region shows changes", () => {
    const { rerender } = render(
      <AutomationBoundary region="reader" resetKey="d1">
        <Card />
      </AutomationBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    broken = false;
    rerender(
      <AutomationBoundary region="reader" resetKey="d2">
        <Card />
      </AutomationBoundary>,
    );
    expect(screen.getByText("Card")).toBeInTheDocument();
  });
});
