import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FactoryNavRow } from "@/modules/factory/components/FactoryNavRow";

describe("FactoryNavRow", () => {
  it("shows the Factory label and opens on click", () => {
    const onOpen = vi.fn();
    render(<FactoryNavRow active={false} needsYou={0} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: /factory/i }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("shows no badge when nothing needs you", () => {
    render(<FactoryNavRow active={false} needsYou={0} onOpen={() => {}} />);
    expect(screen.queryByLabelText(/need you/i)).toBeNull();
  });

  it("shows the rail's needs-you badge with the count of runs that need you", () => {
    render(<FactoryNavRow active={false} needsYou={3} onOpen={() => {}} />);
    const badge = screen.getByLabelText("3 runs need you");
    expect(badge.textContent).toBe("3");
    expect(badge.getAttribute("data-tone")).toBe("ask");
  });

  it("says 'run' for one", () => {
    render(<FactoryNavRow active={false} needsYou={1} onOpen={() => {}} />);
    expect(screen.getByLabelText("1 run needs you")).toBeTruthy();
  });

  it("marks the open page", () => {
    render(<FactoryNavRow active needsYou={0} onOpen={() => {}} />);
    expect(screen.getByRole("button", { name: /factory/i }).getAttribute("aria-current")).toBe("page");
  });
});
