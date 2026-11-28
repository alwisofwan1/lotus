import { describe, expect, it } from "vitest";
import { ariaKeyShortcuts, formatShortcut } from "@/lib/hotkeys/format-shortcut";

describe("formatShortcut", () => {
  it("prints the label unchanged on macOS", () => {
    for (const label of ["⌘K", "⇧⌘G", "⌘↵", "⌥1–9", "⌘⌫"]) {
      expect(formatShortcut(label, "MacIntel")).toBe(label);
    }
  });

  it("names the modifiers in Ctrl, Alt, Shift order elsewhere, whatever order the label used", () => {
    expect(formatShortcut("⌘T", "Win32")).toBe("Ctrl+T");
    expect(formatShortcut("⌘⇧B", "Win32")).toBe("Ctrl+Shift+B");
    expect(formatShortcut("⇧⌘G", "Win32")).toBe("Ctrl+Shift+G");
    expect(formatShortcut("⌥⌘N", "Linux x86_64")).toBe("Ctrl+Alt+N");
  });

  it("names the key glyphs too", () => {
    expect(formatShortcut("⌘↵", "Win32")).toBe("Ctrl+Enter");
    expect(formatShortcut("⌘⏎", "Win32")).toBe("Ctrl+Enter");
    expect(formatShortcut("⌘↩", "Win32")).toBe("Ctrl+Enter");
    expect(formatShortcut("⌘⌫", "Win32")).toBe("Ctrl+Backspace");
    expect(formatShortcut("⌘ Enter", "Win32")).toBe("Ctrl+Enter");
  });

  it("formats a chord inside running text and leaves the text alone", () => {
    expect(formatShortcut("paste it with ⌘V", "Win32")).toBe("paste it with Ctrl+V");
    expect(formatShortcut("Group (⌘G)", "Win32")).toBe("Group (Ctrl+G)");
    expect(formatShortcut("⌥1–9", "Win32")).toBe("Alt+1–9");
  });

  it("keeps a modifier that stands on its own as a word, not a chord", () => {
    expect(formatShortcut("Hold ⌘ to select", "Win32")).toBe("Hold Ctrl to select");
    expect(formatShortcut("⌘-click a link", "Win32")).toBe("Ctrl-click a link");
    expect(formatShortcut("(⇧)", "Win32")).toBe("(Shift)");
  });

  it("does not double Ctrl when a label holds both ⌃ and ⌘", () => {
    expect(formatShortcut("⌃⌘F", "Win32")).toBe("Ctrl+F");
  });
});

describe("ariaKeyShortcuts", () => {
  it("is Meta on macOS and Control elsewhere", () => {
    expect(ariaKeyShortcuts("⌘L", "MacIntel")).toBe("Meta+L");
    expect(ariaKeyShortcuts("⌘L", "Win32")).toBe("Control+L");
    expect(ariaKeyShortcuts("⇧⌘G", "Win32")).toBe("Shift+Control+G");
    expect(ariaKeyShortcuts("⌘↵", "Win32")).toBe("Control+Enter");
  });
});
