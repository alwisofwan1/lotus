import { describe, expect, it } from "vitest";
import {
  isMacCloseFocusedTerminalPaneShortcut,
  shouldIgnorePaneCloseShortcutTarget,
} from "../pane-keyboard-shortcuts";

describe("pane keyboard shortcuts", () => {
  it("recognizes macOS Cmd+W as focused terminal pane close", () => {
    expect(isMacCloseFocusedTerminalPaneShortcut({ key: "w", metaKey: true })).toBe(true);
    expect(isMacCloseFocusedTerminalPaneShortcut({ key: "W", metaKey: true })).toBe(true);
  });

  it("does not steal Ctrl+W from terminal shells", () => {
    expect(isMacCloseFocusedTerminalPaneShortcut({ key: "w", ctrlKey: true })).toBe(false);
  });

  it("requires a plain Cmd+W chord", () => {
    expect(isMacCloseFocusedTerminalPaneShortcut({ key: "w", metaKey: true, shiftKey: true })).toBe(false);
    expect(isMacCloseFocusedTerminalPaneShortcut({ key: "w", metaKey: true, altKey: true })).toBe(false);
    expect(isMacCloseFocusedTerminalPaneShortcut({ key: "w", metaKey: true, ctrlKey: true })).toBe(false);
  });

  it("does not ignore xterm's helper textarea", () => {
    const target = document.createElement("textarea");
    target.className = "xterm-helper-textarea";

    expect(shouldIgnorePaneCloseShortcutTarget(target)).toBe(false);
  });

  it("ignores normal editable fields", () => {
    expect(shouldIgnorePaneCloseShortcutTarget(document.createElement("input"))).toBe(true);
    expect(shouldIgnorePaneCloseShortcutTarget(document.createElement("textarea"))).toBe(true);

    const editable = document.createElement("div");
    editable.contentEditable = "true";
    expect(shouldIgnorePaneCloseShortcutTarget(editable)).toBe(true);
  });
});
