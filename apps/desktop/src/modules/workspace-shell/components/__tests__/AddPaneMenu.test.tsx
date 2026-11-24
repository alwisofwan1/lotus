import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AddPaneMenu } from "../AddPaneMenu";

function renderMenu(overrides: Partial<React.ComponentProps<typeof AddPaneMenu>> = {}) {
  const props = {
    workspaceName: "lotus",
    anchor: { x: 120, y: 200 },
    onAddPane: vi.fn(),
    onStartPreset: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  render(<AddPaneMenu {...props} />);
  return props;
}

describe("AddPaneMenu", () => {
  it("names the workspace the pane will belong to", () => {
    renderMenu();
    expect(screen.getByRole("menu", { name: "Add pane in lotus" })).toBeTruthy();
    expect(screen.getByText(/inherits the workspace folder/)).toBeTruthy();
  });

  /** jsdom reports no platform, and "no platform" is not macOS — so state it per test. */
  function pretendPlatform(platform: string) {
    Object.defineProperty(window.navigator, "platform", { value: platform, configurable: true });
  }

  it("offers every pane kind with its shortcut", () => {
    pretendPlatform("MacIntel");
    renderMenu();
    for (const label of ["Terminal", "Thread", "Browser", "Editor"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getByText("⌘⇧T")).toBeTruthy();
    // ⌘B belongs to the rail toggle, so the Browser row must not advertise it.
    expect(screen.getByText("⌘⇧B")).toBeTruthy();
    expect(screen.queryByText("⌘B")).toBeNull();
  });

  it("writes the chord for the keyboard in front of the person", () => {
    // A Windows or Linux keyboard has no ⌘ key; printing one is a chord nobody can press.
    pretendPlatform("Win32");
    renderMenu();
    expect(screen.getByText("Ctrl+Shift+T")).toBeTruthy();
    expect(screen.queryByText("⌘⇧T")).toBeNull();
  });

  it("opens a single pane immediately — that part is cheap", () => {
    const props = renderMenu();
    fireEvent.click(screen.getByText("Terminal"));
    expect(props.onAddPane).toHaveBeenCalledWith("terminal");
  });

  it("stops on the lineup before starting a squad, and starts nothing until committed", () => {
    const props = renderMenu();
    fireEvent.click(screen.getByText("Workbench"));

    expect(props.onStartPreset).not.toHaveBeenCalled();
    expect(screen.getByRole("menu", { name: "Workbench squad lineup" })).toBeTruthy();
    expect(screen.getByText("Builder")).toBeTruthy();
    expect(screen.getByText("Reviewer")).toBeTruthy();
    expect(screen.getByText("Evidence")).toBeTruthy();
    expect(screen.getByText(/2 agents · 1 surface/)).toBeTruthy();

    fireEvent.click(screen.getByText("Start 3 panes"));
    expect(props.onStartPreset).toHaveBeenCalledWith(expect.objectContaining({ id: "workbench" }));
  });

  it("steps back to the list on Escape before it closes", () => {
    const props = renderMenu();
    fireEvent.click(screen.getByText("Pair"));
    expect(screen.getByRole("menu", { name: /squad lineup/ })).toBeTruthy();

    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(props.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("menu", { name: "Add pane in lotus" })).toBeTruthy();

    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(props.onClose).toHaveBeenCalled();
  });

  it("closes when the pointer goes down outside it", () => {
    const props = renderMenu();
    fireEvent.pointerDown(document.body);
    expect(props.onClose).toHaveBeenCalled();
  });

  it("stays open when the pointer goes down inside it", () => {
    const props = renderMenu();
    fireEvent.pointerDown(screen.getByRole("menu"));
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("walks its items with the arrow keys", () => {
    renderMenu();
    const menu = screen.getByRole("menu");
    const items = screen.getAllByRole("menuitem");
    expect(document.activeElement).toBe(items[0]);

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);

    fireEvent.keyDown(menu, { key: "ArrowUp" });
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    // Wraps to the end rather than dead-ending on the first row.
    expect(document.activeElement).toBe(items[items.length - 1]);
  });
});
