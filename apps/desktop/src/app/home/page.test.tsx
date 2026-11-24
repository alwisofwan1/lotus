import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/home",
  useSearchParams: () => new URLSearchParams(),
}));

import HomePage from "./page";
import { LotusSettingsProvider } from "@/modules/lotus-settings/lotus-settings-context";
import { settingsSectionStub } from "@/modules/lotus-settings/testing/settings-section-stub";

describe("Launcher page (/home)", () => {
  beforeEach(() => {
    mockPush.mockReset();
  });

  it("opens the workspace, not the retired CodeSpace route", () => {
    render(<HomePage />);

    const workspaceLink = screen.getAllByRole("link", { name: /workspace/i })
      .find((link) => link.getAttribute("href") === "/");
    expect(workspaceLink).toBeInTheDocument();

    // CodeSpace was retired: its card and its route are gone, and nothing on the launcher may
    // still offer them.
    expect(screen.queryByRole("link", { name: /codespace/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /codeswarm/i })).not.toBeInTheDocument();
  });

  it("uses viewport height that accounts for app shell top offset", () => {
    const { container } = render(<HomePage />);
    const launchpad = container.querySelector(".home-launchpad");
    expect(launchpad).toHaveClass("h-[calc(100dvh-var(--app-shell-top-offset,0px)-var(--windows-titlebar-h,0px))]");
  });

  // The chord people already press, now opening the surface that replaced what it used to open.
  it("navigates to the workspace on ⌘T", () => {
    render(<HomePage />);
    fireEvent.keyDown(window, { key: "t", metaKey: true });
    expect(mockPush).toHaveBeenCalledWith("/");
  });

  it("leaves ⌘S unbound now that CodeSwarm is gone", () => {
    render(<HomePage />);
    fireEvent.keyDown(window, { key: "s", metaKey: true });
    expect(mockPush).not.toHaveBeenCalled();
  });

  // ⌘, opens Lotus Settings from every route (LotusSettingsProvider in AppShell); routing here too
  // would yank the launcher away from under the modal.
  it("leaves ⌘, to Lotus Settings instead of routing to the Settings page", () => {
    render(<HomePage />);
    fireEvent.keyDown(window, { key: ",", metaKey: true });
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("opens Lotus Settings from the Settings pill instead of going to a settings page", () => {
    render(<LotusSettingsProvider sections={[settingsSectionStub("lotus", "editor")]}><HomePage /></LotusSettingsProvider>);
    expect(screen.queryByRole("link", { name: /settings/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /settings/i }));

    expect(screen.getByRole("dialog")).toHaveTextContent("editor body");
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("renders the Chat card with correct link", () => {
    render(<HomePage />);
    const chatLink = screen.getByRole("link", { name: /chat \(beta\)/i });
    expect(chatLink).toHaveAttribute("href", "/chat");
  });

  it("navigates to /chat on ⌘A (07o: CodeChat's shortcut)", () => {
    render(<HomePage />);
    fireEvent.keyDown(window, { key: "a", metaKey: true });
    expect(mockPush).toHaveBeenCalledWith("/chat");
  });
});
