import { describe, expect, it } from "vitest";
import {
  isJumpPaletteShortcut,
  formatShortcut,
  isClosePaneShortcut,
  isSplitDownShortcut,
  isSplitRightShortcut,
  isToggleRailShortcut,
  isTextSelectionChord,
  paneFocusShortcut,
  paneShortcutKind,
  type ShortcutEvent,
} from "@/modules/workspace-shell/services/shortcuts";

function press(overrides: Partial<ShortcutEvent>): ShortcutEvent {
  return { key: "d", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...overrides };
}

describe("split shortcuts", () => {
  it("splits right on ⌘D on macOS and Ctrl+D elsewhere", () => {
    expect(isSplitRightShortcut(press({ metaKey: true }), "MacIntel")).toBe(true);
    expect(isSplitRightShortcut(press({ ctrlKey: true }), "Win32")).toBe(true);
  });

  it("does not fire on the other platform's modifier", () => {
    // Ctrl+D on macOS is end-of-file in a shell; stealing it would break every terminal.
    expect(isSplitRightShortcut(press({ ctrlKey: true }), "MacIntel")).toBe(false);
    expect(isSplitRightShortcut(press({ metaKey: true }), "Win32")).toBe(false);
  });

  it("splits down only when Shift is held", () => {
    expect(isSplitDownShortcut(press({ metaKey: true, shiftKey: true }), "MacIntel")).toBe(true);
    expect(isSplitDownShortcut(press({ metaKey: true }), "MacIntel")).toBe(false);
    expect(isSplitRightShortcut(press({ metaKey: true, shiftKey: true }), "MacIntel")).toBe(false);
  });

  it("ignores another key, and ignores Alt so option-chords stay free", () => {
    expect(isSplitRightShortcut(press({ key: "k", metaKey: true }), "MacIntel")).toBe(false);
    expect(isSplitRightShortcut(press({ metaKey: true, altKey: true }), "MacIntel")).toBe(false);
  });

  it("accepts an uppercase key, which is what Shift reports", () => {
    expect(isSplitDownShortcut(press({ key: "D", metaKey: true, shiftKey: true }), "MacIntel")).toBe(true);
  });
});

describe("close shortcut", () => {
  it("closes a pane on ⌘W, and on Ctrl+W off macOS", () => {
    expect(isClosePaneShortcut(press({ key: "w", metaKey: true }), "MacIntel")).toBe(true);
    expect(isClosePaneShortcut(press({ key: "w", ctrlKey: true }), "Win32")).toBe(true);
  });

  it("leaves ⌘⇧W alone, which is how the window still gets closed", () => {
    expect(isClosePaneShortcut(press({ key: "w", metaKey: true, shiftKey: true }), "MacIntel")).toBe(false);
  });

  it("does not fire on the other platform's modifier", () => {
    expect(isClosePaneShortcut(press({ key: "w", ctrlKey: true }), "MacIntel")).toBe(false);
  });
});

describe("pane shortcuts", () => {
  it("opens each kind on its own chord", () => {
    expect(paneShortcutKind(press({ key: "t", metaKey: true }), "MacIntel")).toBe("terminal");
    expect(paneShortcutKind(press({ key: "t", metaKey: true, shiftKey: true }), "MacIntel")).toBe("thread");
    expect(paneShortcutKind(press({ key: "b", metaKey: true, shiftKey: true }), "MacIntel")).toBe("browser");
    expect(paneShortcutKind(press({ key: "e", metaKey: true }), "MacIntel")).toBe("editor");
    // ⌘J opened the Bridge pane, which was retired: the chord now belongs to nobody.
    expect(paneShortcutKind(press({ key: "j", metaKey: true }), "MacIntel")).toBeNull();
  });

  it("leaves ⌘B to the rail", () => {
    // The Browser row used to print ⌘B, which collapses the sidebar. Unshifted B must stay the
    // rail's, and the two predicates must not both answer for one press.
    const railChord = press({ key: "b", metaKey: true });
    expect(isToggleRailShortcut(railChord, "MacIntel")).toBe(true);
    expect(paneShortcutKind(railChord, "MacIntel")).toBeNull();

    const browserChord = press({ key: "b", metaKey: true, shiftKey: true });
    expect(isToggleRailShortcut(browserChord, "MacIntel")).toBe(false);
    expect(paneShortcutKind(browserChord, "MacIntel")).toBe("browser");
  });

  it("does not collide with the split and close chords", () => {
    expect(paneShortcutKind(press({ key: "d", metaKey: true }), "MacIntel")).toBeNull();
    expect(paneShortcutKind(press({ key: "w", metaKey: true }), "MacIntel")).toBeNull();
    expect(paneShortcutKind(press({ key: "k", metaKey: true }), "MacIntel")).toBeNull();
  });

  it("uses Ctrl off macOS and ignores a bare key or an Alt chord", () => {
    expect(paneShortcutKind(press({ key: "t", ctrlKey: true }), "Win32")).toBe("terminal");
    expect(paneShortcutKind(press({ key: "t", metaKey: true }), "Win32")).toBeNull();
    expect(paneShortcutKind(press({ key: "t" }), "MacIntel")).toBeNull();
    expect(paneShortcutKind(press({ key: "t", metaKey: true, altKey: true }), "MacIntel")).toBeNull();
  });

  it("accepts the uppercase key a shifted chord reports", () => {
    expect(paneShortcutKind(press({ key: "T", metaKey: true, shiftKey: true }), "MacIntel")).toBe("thread");
  });
});

describe("how a chord is printed", () => {
  it("keeps the macOS glyphs on macOS", () => {
    expect(formatShortcut("⌘⇧B", "MacIntel")).toBe("⌘⇧B");
  });

  it("says Ctrl and Shift everywhere else — ⌘ is not a key on those keyboards", () => {
    expect(formatShortcut("⌘T", "Win32")).toBe("Ctrl+T");
    expect(formatShortcut("⌘⇧B", "Linux x86_64")).toBe("Ctrl+Shift+B");
  });
});

describe("paneFocusShortcut", () => {
  /**
   * The chord is CodeSpace's, letter for letter (`terminal-v2-layout-keybindings.ts`). The plain
   * ⌘Arrow is deliberately NOT it: a terminal already spends ⌘← and ⌘→ on line-start and line-end
   * (`terminal-keybindings.ts`), so binding it here would take a key every shell user relies on.
   */
  it("moves focus on ⌘⌥Arrow", () => {
    expect(paneFocusShortcut(press({ key: "ArrowRight", metaKey: true, altKey: true }), "MacIntel"))
      .toEqual({ kind: "direction", direction: "right" });
  });

  /** CodeSpace accepts the shifted chord too, and a shell that did not would be a shell that
      answered half the keys its sibling does. */
  it("accepts ⌘⇧Arrow as the same command", () => {
    expect(paneFocusShortcut(press({ key: "ArrowUp", metaKey: true, shiftKey: true }), "MacIntel"))
      .toEqual({ kind: "direction", direction: "up" });
  });

  /**
   * ⌘1..⌘9 jumps straight to a pane, the way a browser jumps to a tab. Reported 0-based because
   * every caller indexes an array with it, and converting at nine call sites is how off-by-one
   * bugs are born.
   */
  it("jumps straight to a pane on ⌘1..⌘9", () => {
    expect(paneFocusShortcut(press({ key: "1", metaKey: true }), "MacIntel"))
      .toEqual({ kind: "index", index: 0 });
    expect(paneFocusShortcut(press({ key: "9", metaKey: true }), "MacIntel"))
      .toEqual({ kind: "index", index: 8 });
  });

  it("leaves ⌘0 alone, which names no pane", () => {
    expect(paneFocusShortcut(press({ key: "0", metaKey: true }), "MacIntel")).toBeNull();
  });

  /**
   * Ctrl+Tab cycles, on every platform — CodeSpace binds it without asking which one, because Tab
   * cycling is a Ctrl chord on macOS too (⌘Tab belongs to the app switcher and is not ours to
   * take).
   */
  it("cycles on Ctrl+Tab, and backwards when Shift is held", () => {
    expect(paneFocusShortcut(press({ key: "Tab", ctrlKey: true }), "MacIntel"))
      .toEqual({ kind: "cycle", direction: "next" });
    expect(paneFocusShortcut(press({ key: "Tab", ctrlKey: true, shiftKey: true }), "MacIntel"))
      .toEqual({ kind: "cycle", direction: "previous" });
  });

  /**
   * The keys this must NOT take.
   *
   * Plain ⌘← and ⌘→ are line-start and line-end inside a terminal — `getTerminalShortcutSequence`
   * turns them into ^A and ^E — so claiming them would break the one movement every shell user
   * makes. A bare arrow or digit is ordinary typing.
   */
  it.each([
    ["plain ⌘Arrow, which a terminal spends on line-start", press({ key: "ArrowLeft", metaKey: true })],
    ["a bare arrow", press({ key: "ArrowLeft" })],
    ["a bare digit", press({ key: "1" })],
    ["⌘⌥ on a letter", press({ key: "k", metaKey: true, altKey: true })],
  ])("leaves %s alone", (_label, event) => {
    expect(paneFocusShortcut(event, "MacIntel")).toBeNull();
  });

  it("uses Ctrl rather than ⌘ away from macOS", () => {
    expect(paneFocusShortcut(press({ key: "ArrowRight", ctrlKey: true, altKey: true }), "Win32"))
      .toEqual({ kind: "direction", direction: "right" });
    expect(paneFocusShortcut(press({ key: "ArrowRight", metaKey: true, altKey: true }), "Win32")).toBeNull();
  });

  /**
   * Which of these chords an ordinary text field would also want. ⌘⇧Arrow extends a selection to
   * the line start or end on macOS; ⌘⌥Arrow, Ctrl+Tab and ⌘1..⌘9 mean nothing in a field, so those
   * the shell can take anywhere.
   */
  it("marks only the shifted arrow as a chord a text field also wants", () => {
    expect(isTextSelectionChord(press({ key: "ArrowLeft", metaKey: true, shiftKey: true }))).toBe(true);
    expect(isTextSelectionChord(press({ key: "ArrowLeft", metaKey: true, altKey: true }))).toBe(false);
    expect(isTextSelectionChord(press({ key: "Tab", ctrlKey: true }))).toBe(false);
    expect(isTextSelectionChord(press({ key: "1", metaKey: true }))).toBe(false);
  });
});

describe("isJumpPaletteShortcut", () => {
  it("is ⌘J on a Mac and leaves Ctrl+J to the terminal's newline", () => {
    expect(isJumpPaletteShortcut(press({ key: "j", metaKey: true }), "MacIntel")).toBe(true);
    expect(isJumpPaletteShortcut(press({ key: "j", ctrlKey: true }), "MacIntel")).toBe(false);
    expect(isJumpPaletteShortcut(press({ key: "j", ctrlKey: true }), "Win32")).toBe(true);
  });
});
