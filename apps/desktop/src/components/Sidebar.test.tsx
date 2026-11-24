import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/teams",
  useSearchParams: () => new URLSearchParams(),
}));

// Sidebar needs useSidebar context from AppShell
import { AppShell } from "@/modules/shell";

describe("Sidebar — Branding", () => {
  it("offers the workspace, and no longer the retired CodeSpace", () => {
    render(
      <AppShell><div>child</div></AppShell>
    );

    expect(screen.getByText("Workspace")).toBeInTheDocument();
    expect(screen.queryByText("CodeSpace")).not.toBeInTheDocument();
    expect(screen.queryByText("Studio")).not.toBeInTheDocument();
  });

  it('shows "Lotus" brand instead of "Swarm"', () => {
    render(
      <AppShell><div>child</div></AppShell>
    );

    expect(screen.getByText("Lotus")).toBeInTheDocument();
    expect(screen.queryByText("Swarm")).not.toBeInTheDocument();
  });

  it("no longer lists CodeChat (07o)", () => {
    render(
      <AppShell><div>child</div></AppShell>
    );

    expect(screen.queryByRole("link", { name: /codechat/i })).toBeNull();
  });
});
