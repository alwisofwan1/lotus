import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CanvasProjectRestoringState } from "../CanvasProjectRestoringState";

describe("CanvasProjectRestoringState", () => {
  it("announces restore without presenting an empty project action", () => {
    render(<CanvasProjectRestoringState />);

    const region = screen.getByRole("status", { name: /restoring canvas/i });
    expect(region).toHaveAttribute("aria-busy", "true");
    expect(region).toHaveTextContent("Restoring canvas…");
    expect(screen.queryByRole("region", { name: /no project open/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /open a project/i })).not.toBeInTheDocument();
  });
});
