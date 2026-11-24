import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CodeSpaceSettingsSection } from "../CodeSpaceSettingsSection";
import { getCanvasBehaviorSettings } from "@/modules/codecanvas/hooks/useCanvasBehaviorSettings";

describe("CodeSpaceSettingsSection — Workbench Editor", () => {
  it("shows 13px and no wrap when nothing is set", () => {
    render(<CodeSpaceSettingsSection settings={{}} update={vi.fn()} />);
    expect(screen.getByRole("combobox", { name: "Editor font size" })).toHaveValue("13");
    expect(screen.getByRole("switch", { name: "Toggle editor word wrap" })).toHaveAttribute("aria-checked", "false");
  });

  it("saves the font size and word wrap under codespace, keeping its other keys", () => {
    const update = vi.fn();
    render(<CodeSpaceSettingsSection settings={{ codespace: { autoPaneTitles: false } }} update={update} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Editor font size" }), { target: { value: "16" } });
    expect(update).toHaveBeenLastCalledWith({ codespace: { autoPaneTitles: false, editorFontSize: 16 } });

    fireEvent.click(screen.getByRole("switch", { name: "Toggle editor word wrap" }));
    expect(update).toHaveBeenLastCalledWith({ codespace: { autoPaneTitles: false, editorWordWrap: true } });
  });

  it("offers Lotus Dark and Lotus Light first and selects them when no editor theme is saved", () => {
    render(<CodeSpaceSettingsSection settings={{}} update={vi.fn()} />);
    const dark = screen.getByRole("combobox", { name: "Editor dark theme" });
    const light = screen.getByRole("combobox", { name: "Editor light theme" });

    expect(dark).toHaveDisplayValue("Lotus Dark");
    expect(light).toHaveDisplayValue("Lotus Light");
    expect(dark.querySelector("option")).toHaveTextContent("Lotus Dark");
    expect(light.querySelector("option")).toHaveTextContent("Lotus Light");
  });

  it("keeps a saved editor theme, Gruvbox included", () => {
    render(<CodeSpaceSettingsSection settings={{ codespace: { editorDarkTheme: "gruvbox-dark-hard", editorLightTheme: "gruvbox-light-soft" } }} update={vi.fn()} />);
    expect(screen.getByRole("combobox", { name: "Editor dark theme" })).toHaveDisplayValue("Gruvbox Dark Hard");
    expect(screen.getByRole("combobox", { name: "Editor light theme" })).toHaveDisplayValue("Gruvbox Light Soft");
  });
});

describe("CodeSpaceSettingsSection — Terminal", () => {
  it("hosts the Shift+Enter newline toggle (canvas behaviour key)", () => {
    render(<CodeSpaceSettingsSection settings={{}} update={vi.fn()} />);
    const toggle = screen.getByRole("switch", { name: "Shift+Enter inserts a newline" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(toggle);
    expect(getCanvasBehaviorSettings().terminalShiftEnterNewline).toBe(false);
  });
});
