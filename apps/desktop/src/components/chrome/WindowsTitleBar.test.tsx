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

  it("puts the app menu and the window buttons in one title row", () => {
    render(<WindowsTitleBar />);
    for (const name of ["File", "Edit", "Window", "Help", "Minimize", "Maximize", "Close"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
  });

  it("opens the native submenu under the clicked title", () => {
    render(<WindowsTitleBar />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    // jsdom lays nothing out, so the button's rect is all zeros: x = left, y = bottom.
    expect(api.showWindowMenu).toHaveBeenCalledWith("Edit", 0, 0);
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
