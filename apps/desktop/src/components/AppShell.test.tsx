import { act, render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { LAST_ACTIVE_SHELL_DESTINATION_STORAGE_KEY } from "@/modules/shell/services/last-shell-destination";

// We need to control usePathname per test
const mockUsePathname = vi.fn(() => "/");
const mockPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn(), back: vi.fn() }),
  usePathname: () => mockUsePathname(),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/modules/workspace-shell/containers/WorkspaceShellPage", () => ({
  WorkspaceShellPage: ({ shown }: { shown?: boolean }) => (
    <section data-testid="workspace-shell-host" data-shown={shown ? "true" : "false"}>Shell</section>
  ),
}));


// Must import after mock setup
import { AppShell } from "@/modules/shell";

describe("AppShell — Conditional Sidebar", () => {
  beforeEach(() => {
    mockUsePathname.mockReset();
    localStorage.clear();
  });

  it("hides sidebar when pathname is /", () => {
    mockUsePathname.mockReturnValue("/");

    const { container } = render(
      <AppShell><div>child</div></AppShell>
    );

    expect(container.querySelector("aside")).not.toBeInTheDocument();
  });

  it("shows sidebar on an ordinary route", () => {
    mockUsePathname.mockReturnValue("/teams");

    const { container } = render(
      <AppShell><div>child</div></AppShell>
    );

    expect(container.querySelector("aside")).toBeInTheDocument();
  });

  it("persists the last active module destination", () => {
    mockUsePathname.mockReturnValue("/canvas");

    render(
      <AppShell><div>child</div></AppShell>
    );

    expect(localStorage.getItem(LAST_ACTIVE_SHELL_DESTINATION_STORAGE_KEY)).toBe("/canvas");
  });

  it("does not overwrite the last active module while inside settings", () => {
    localStorage.setItem(LAST_ACTIVE_SHELL_DESTINATION_STORAGE_KEY, "/canvas");
    mockUsePathname.mockReturnValue("/settings");

    render(
      <AppShell><div>child</div></AppShell>
    );

    expect(localStorage.getItem(LAST_ACTIVE_SHELL_DESTINATION_STORAGE_KEY)).toBe("/canvas");
  });

  // /settings only opens Lotus Settings and replaces itself with the last mode; for the frame it
  // is on screen it must not flash the plain sidebar.
  it("draws no sidebar on /settings, which only passes through", () => {
    mockUsePathname.mockReturnValue("/settings");

    const { container } = render(
      <AppShell><div>child</div></AppShell>
    );

    expect(container.querySelector("aside")).not.toBeInTheDocument();
  });
});

/**
 * Who owns the workspaces.
 *
 * `useCodeSpaceWorkspaces` is the snapshot's writer and may be mounted exactly once per window.
 * Both the unified shell (`/`) and CodeSpace (`/terminal`) mount it, and before these tests
 * nothing stopped them overlapping: one visit to `/terminal` latched `keepCodeSpaceMounted` for
 * the life of the window, and `/` then rendered the shell beside it — two writers, older view
 * wins whenever it saves last.
 */
describe("AppShell — one workspace owner", () => {
  beforeEach(() => {
    mockUsePathname.mockReset();
    localStorage.clear();
  });

  /** The latch that keeps a surface mounted is armed from a zero-delay timer. */
  async function settleKeepAlive() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("never mounts the retired CodeSpace surface again", async () => {
    mockUsePathname.mockReturnValue("/terminal");
    render(<AppShell><div>child</div></AppShell>);
    await settleKeepAlive();

    expect(screen.queryByTestId("codespace-host")).not.toBeInTheDocument();
  });

  it("parks the shell — mounted, invisible, quiet — while CodeCanvas draws the window", async () => {
    mockUsePathname.mockReturnValue("/");
    const { rerender } = render(<AppShell><div>child</div></AppShell>);
    await settleKeepAlive();

    mockUsePathname.mockReturnValue("/canvas");
    rerender(<AppShell><div>child</div></AppShell>);

    const host = screen.getByTestId("workspace-shell-host");
    // Still mounted: unmounting it takes every terminal down with it, which is what the mode
    // switcher's Canvas segment used to do.
    expect(host).toBeInTheDocument();
    // Not display:none — a pane out of layout loses its renderer slot and pays to re-attach.
    expect(host.parentElement).toHaveClass("app-shell-parked");
    // And it must stop answering the keyboard while it cannot be seen.
    expect(host).toHaveAttribute("data-shown", "false");
  });
});
