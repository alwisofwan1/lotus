import { describe, expect, it } from "vitest";
import {
  chordLetter,
  hasPrimaryModifier,
  isRedoAliasChord,
  isTerminalOwnedChord,
  isTextEditingOwnedChord,
  keyboardSurfaceOf,
  surfaceOwnsChord,
  type PlatformChordEventLike,
} from "@/lib/hotkeys/platform-chords";

const MAC = "MacIntel";
const WIN = "Win32";

function press(overrides: Partial<PlatformChordEventLike>): PlatformChordEventLike {
  return { key: "k", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...overrides };
}

describe("chordLetter", () => {
  it("reads the printed letter first, then the physical key on a non-Latin layout", () => {
    expect(chordLetter({ key: "V" })).toBe("v");
    expect(chordLetter({ key: "с", code: "KeyC" })).toBe("c");
    expect(chordLetter({ key: "Enter", code: "Enter" })).toBeNull();
  });
});

describe("hasPrimaryModifier", () => {
  it("is ⌘ on macOS and Ctrl elsewhere, never both", () => {
    expect(hasPrimaryModifier(press({ metaKey: true }), MAC)).toBe(true);
    expect(hasPrimaryModifier(press({ ctrlKey: true }), MAC)).toBe(false);
    expect(hasPrimaryModifier(press({ ctrlKey: true }), WIN)).toBe(true);
    expect(hasPrimaryModifier(press({ metaKey: true }), WIN)).toBe(false);
  });
});

describe("isTerminalOwnedChord", () => {
  it("keeps every plain Ctrl+letter for the terminal on Windows", () => {
    for (const key of ["k", "b", "w", "n", "e", "a", "c", "v", "g"]) {
      expect(isTerminalOwnedChord(press({ key, ctrlKey: true }), WIN)).toBe(true);
    }
  });

  it("keeps the control punctuation: Ctrl+\\ is SIGQUIT and Ctrl+[ is Esc", () => {
    for (const key of ["\\", "[", "]", " ", "_"]) {
      expect(isTerminalOwnedChord(press({ key, ctrlKey: true }), WIN)).toBe(true);
    }
  });

  it("keeps Ctrl+Shift+C / Ctrl+Shift+V (copy, paste) but gives the app other Ctrl+Shift letters", () => {
    expect(isTerminalOwnedChord(press({ key: "C", ctrlKey: true, shiftKey: true }), WIN)).toBe(true);
    expect(isTerminalOwnedChord(press({ key: "V", ctrlKey: true, shiftKey: true }), WIN)).toBe(true);
    expect(isTerminalOwnedChord(press({ key: "A", ctrlKey: true, shiftKey: true }), WIN)).toBe(false);
    expect(isTerminalOwnedChord(press({ key: "D", ctrlKey: true, shiftKey: true }), WIN)).toBe(false);
  });

  it("leaves digits, Ctrl+. and Ctrl+` to the app: pane jumps and canvas commands live there", () => {
    for (const key of ["1", "9", ".", "`", ","]) {
      expect(isTerminalOwnedChord(press({ key, ctrlKey: true }), WIN)).toBe(false);
    }
  });

  it("ignores Ctrl+Alt, which is AltGr on European layouts", () => {
    expect(isTerminalOwnedChord(press({ key: "q", ctrlKey: true, altKey: true }), WIN)).toBe(false);
  });

  it("never claims anything on macOS", () => {
    expect(isTerminalOwnedChord(press({ key: "k", ctrlKey: true }), MAC)).toBe(false);
    expect(isTerminalOwnedChord(press({ key: "k", metaKey: true }), MAC)).toBe(false);
  });
});

describe("isTextEditingOwnedChord", () => {
  it("keeps the Windows editing set in a text field", () => {
    for (const key of ["a", "c", "v", "x", "z", "y"]) {
      expect(isTextEditingOwnedChord(press({ key, ctrlKey: true }), WIN)).toBe(true);
    }
    expect(isTextEditingOwnedChord(press({ key: "Z", ctrlKey: true, shiftKey: true }), WIN)).toBe(true);
    expect(isTextEditingOwnedChord(press({ key: "V", ctrlKey: true, shiftKey: true }), WIN)).toBe(true);
    expect(isTextEditingOwnedChord(press({ key: "Backspace", ctrlKey: true }), WIN)).toBe(true);
  });

  it("leaves app chords such as Ctrl+K and Ctrl+B alone in a text field", () => {
    expect(isTextEditingOwnedChord(press({ key: "k", ctrlKey: true }), WIN)).toBe(false);
    expect(isTextEditingOwnedChord(press({ key: "b", ctrlKey: true }), WIN)).toBe(false);
  });

  it("never claims anything on macOS", () => {
    expect(isTextEditingOwnedChord(press({ key: "v", ctrlKey: true }), MAC)).toBe(false);
  });
});

describe("surfaceOwnsChord", () => {
  it("asks the rule that belongs to the surface", () => {
    const ctrlK = press({ key: "k", ctrlKey: true });
    expect(surfaceOwnsChord(ctrlK, "terminal", WIN)).toBe(true);
    expect(surfaceOwnsChord(ctrlK, "text", WIN)).toBe(false);
    expect(surfaceOwnsChord(ctrlK, "none", WIN)).toBe(false);
  });
});

describe("isRedoAliasChord", () => {
  it("is Ctrl+Y on Windows and nothing on macOS", () => {
    expect(isRedoAliasChord(press({ key: "y", ctrlKey: true }), WIN)).toBe(true);
    expect(isRedoAliasChord(press({ key: "y", ctrlKey: true, shiftKey: true }), WIN)).toBe(false);
    expect(isRedoAliasChord(press({ key: "y", metaKey: true }), MAC)).toBe(false);
    expect(isRedoAliasChord(press({ key: "y", ctrlKey: true }), MAC)).toBe(false);
  });
});

describe("keyboardSurfaceOf", () => {
  it("reads xterm's own textarea as a terminal, not a text field", () => {
    const xterm = document.createElement("div");
    xterm.className = "xterm";
    const helper = document.createElement("textarea");
    helper.className = "xterm-helper-textarea";
    xterm.appendChild(helper);
    expect(keyboardSurfaceOf(helper)).toBe("terminal");
  });

  it("reads inputs and textareas as text, and anything else as none", () => {
    expect(keyboardSurfaceOf(document.createElement("input"))).toBe("text");
    expect(keyboardSurfaceOf(document.createElement("textarea"))).toBe("text");
    expect(keyboardSurfaceOf(document.createElement("button"))).toBe("none");
    expect(keyboardSurfaceOf(null)).toBe("none");
  });
});
