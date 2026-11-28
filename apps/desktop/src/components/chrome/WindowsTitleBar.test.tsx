import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WindowsTitleBar } from "./WindowsTitleBar";

const api = vi.hoisted(() => ({
  showWindowMenu: vi.fn(() => Promise.resolve()),
  minimizeCurrentWindow: vi.fn(() => Promise.resolve()),
  toggleCurrentWindowMaximize: vi.fn(() => Promise.resolve()),
  closeCurrentWindow: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/tauri-api", () => api);

describe("WindowsTitleBar", () => {
  beforeEach(() => vi.clearAllMocks());

  it("draws one menu button and the window buttons, with no menu-title row", () => {
    render(<WindowsTitleBar />);
    for (const name of ["Application menu", "Minimize", "Maximize", "Close"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    for (const name of ["File", "Edit", "Window", "Help"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });

  it("flags the document so top bars reserve room for the overlay", () => {
    const { unmount } = render(<WindowsTitleBar />);
    expect(document.documentElement.dataset.windowsCaption).toBe("true");
    unmount();
    expect(document.documentElement.dataset.windowsCaption).toBeUndefined();
  });

  it("pops the whole native app menu under the menu button", () => {
    render(<WindowsTitleBar />);
    fireEvent.click(screen.getByRole("button", { name: "Application menu" }));
    // jsdom lays nothing out, so the button's rect is all zeros: x = left, y = bottom.
    expect(api.showWindowMenu).toHaveBeenCalledWith("", 0, 0);
  });

  it("drives the window from its own buttons", () => {
    render(<WindowsTitleBar />);
    fireEvent.click(screen.getByRole("button", { name: "Minimize" }));
    fireEvent.click(screen.getByRole("button", { name: "Maximize" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(api.minimizeCurrentWindow).toHaveBeenCalledOnce();
    expect(api.toggleCurrentWindowMaximize).toHaveBeenCalledOnce();
    expect(api.closeCurrentWindow).toHaveBeenCalledOnce();
  });
});
