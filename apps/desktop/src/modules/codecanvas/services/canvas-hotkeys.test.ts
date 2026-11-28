import { afterEach, describe, expect, it } from "vitest";
import {
  CANVAS_HOTKEY_COMMANDS,
  effectiveBindings,
  findChordConflict,
  findToolShortcutConflict,
  formatChord,
  isChordTerminalSafe,
  isCommandChordTerminalSafe,
  normalizeChord,
  resolveHotkeyCommand,
  shouldDispatchCanvasHotkey,
  shouldDispatchCanvasHotkeyCommand,
  UNBOUND_CHORD,
} from "./canvas-hotkeys";
import {
  getCanvasHotkeyOverrides,
  resetCanvasHotkeyStoreForTests,
  setCanvasHotkeyOverride,
} from "../hooks/useCanvasHotkeySettings";

const evt = (over: Partial<Parameters<typeof normalizeChord>[0]> & { key: string }) => ({
  metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over,
});

describe("normalizeChord", () => {
  it("canonicalizes a modifier chord into a stable string", () => {
    expect(normalizeChord({ key: "k", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }))
      .toBe("mod+k");
  });

  it("treats ctrl as mod and orders modifiers mod→alt→shift regardless of key case", () => {
    expect(normalizeChord({ key: "ArrowRight", metaKey: false, ctrlKey: true, altKey: true, shiftKey: false }))
      .toBe("mod+alt+arrowright");
    expect(normalizeChord({ key: "F", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }))
      .toBe("f");
    expect(normalizeChord({ key: "`", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true }))
      .toBe("mod+shift+`");
  });

  it("reads ⌥Space as alt+space although macOS reports a non-breaking space as the key", () => {
    expect(normalizeChord(evt({ key: "\u00a0", code: "Space", altKey: true }))).toBe("alt+space");
    expect(normalizeChord(evt({ key: "\u00a0", code: "Space", altKey: true, shiftKey: true }))).toBe("alt+shift+space");
  });
});

describe("resolveHotkeyCommand", () => {
  it("resolves a default binding to its command id", () => {
    expect(resolveHotkeyCommand(evt({ key: "k", metaKey: true }), {})).toBe("palette");
    expect(resolveHotkeyCommand(evt({ key: "ArrowRight", metaKey: true, altKey: true }), {}))
      .toBe("focus-dir-right");
    expect(resolveHotkeyCommand(evt({ key: "f" }), {})).toBe("jump-labels");
    expect(resolveHotkeyCommand(evt({ key: "a", metaKey: true, shiftKey: true }), {})).toBe("arrange");
  });

  it("resolves configurable one-turn Command and Dictate voice overrides", () => {
    expect(resolveHotkeyCommand(evt({ key: "v", metaKey: true, shiftKey: true }), {})).toBe("voice-command");
    expect(resolveHotkeyCommand(evt({ key: "d", metaKey: true, shiftKey: true }), {})).toBe("voice-dictate");
  });

  it("returns null for an unbound chord", () => {
    expect(resolveHotkeyCommand(evt({ key: "q", metaKey: true, shiftKey: true }), {})).toBeNull();
  });

  it("honors an override over the default and frees the default chord", () => {
    const overrides = { "jump-labels": "mod+j" } as const;
    expect(resolveHotkeyCommand(evt({ key: "j", metaKey: true }), overrides)).toBe("jump-labels");
    expect(resolveHotkeyCommand(evt({ key: "f" }), overrides)).toBeNull();
  });

  it("treats an unbound override as disabled — no event ever triggers it", () => {
    const overrides = { "jump-labels": UNBOUND_CHORD };
    expect(resolveHotkeyCommand(evt({ key: "f" }), overrides)).toBeNull();
    expect(resolveHotkeyCommand(evt({ key: UNBOUND_CHORD }), overrides)).toBeNull();
  });
});

describe("isChordTerminalSafe", () => {
  it("is true only when the chord carries mod, or is a structural cross-layer key", () => {
    expect(isChordTerminalSafe("mod+k")).toBe(true);
    expect(isChordTerminalSafe("mod+alt+arrowright")).toBe(true);
    expect(isChordTerminalSafe("escape")).toBe(true);
    expect(isChordTerminalSafe("enter")).toBe(true);
    expect(isChordTerminalSafe("f")).toBe(false);
    expect(isChordTerminalSafe("shift+a")).toBe(false);
  });
});

describe("isCommandChordTerminalSafe", () => {
  it("marks close-node as canvas-layer only even when its chord carries mod", () => {
    expect(isCommandChordTerminalSafe("close-node", "mod+backspace")).toBe(false);
    expect(isCommandChordTerminalSafe("focus-dir-right", "mod+alt+arrowright")).toBe(true);
  });

  it("treats user-chosen voice chords as global even without Cmd or Shift", () => {
    expect(isCommandChordTerminalSafe("voice-command", "f8")).toBe(true);
    expect(isCommandChordTerminalSafe("voice-dictate", "x")).toBe(true);
  });
});

describe("findChordConflict", () => {
  it("names the command already bound to a chord, ignoring the command itself", () => {
    expect(findChordConflict("mod+k", "jump-labels", {})).toBe("palette");
    expect(findChordConflict("mod+k", "palette", {})).toBeNull();
    // Was `mod+j` until that became `jump-needs-you` — the example needed a chord that is still
    // genuinely unowned, not a weaker assertion.
    expect(findChordConflict("mod+alt+z", "jump-labels", {})).toBeNull();
  });

  it("treats a generic modifier binding as conflicting with either physical side", () => {
    const overrides = { "voice-command": "meta" } as const;
    expect(findChordConflict("meta-right", "voice-dictate", overrides)).toBe("voice-command");
    expect(findChordConflict("meta-left", "voice-dictate", overrides)).toBe("voice-command");
  });

  it("allows left and right modifier bindings to coexist", () => {
    const overrides = { "voice-command": "meta-left" } as const;
    expect(findChordConflict("meta-right", "voice-dictate", overrides)).toBeNull();
  });
});

describe("formatChord", () => {
  it("renders platform-aware keycap tokens", () => {
    expect(formatChord("mod+alt+arrowright", "mac")).toEqual(["⌘", "⌥", "→"]);
    expect(formatChord("mod+alt+arrowright", "other")).toEqual(["Ctrl", "Alt", "→"]);
    expect(formatChord("mod+backspace", "mac")).toEqual(["⌘", "⌫"]);
    expect(formatChord("escape", "mac")).toEqual(["Esc"]);
    expect(formatChord("f", "mac")).toEqual(["F"]);
    expect(formatChord("f8", "mac")).toEqual(["F8"]);
    expect(formatChord("meta", "mac")).toEqual(["Any ⌘"]);
    expect(formatChord("meta-left", "mac")).toEqual(["Left ⌘"]);
    expect(formatChord("meta-right", "mac")).toEqual(["Right ⌘"]);
    expect(formatChord("ctrl", "mac")).toEqual(["Any ⌃"]);
    expect(formatChord("ctrl-right", "other")).toEqual(["Right Ctrl"]);
  });
});

describe("shouldDispatchCanvasHotkey", () => {
  it("fires mod chords everywhere but keeps bare keys off editable targets", () => {
    // a focused terminal must still receive nav chords…
    expect(shouldDispatchCanvasHotkey("mod+alt+arrowright", { editable: true, terminal: true })).toBe(true);
    expect(shouldDispatchCanvasHotkey("mod+alt+arrowright", { editable: false, terminal: false })).toBe(true);
    // …but bare keys (incl. Enter) belong to the focused control while typing.
    expect(shouldDispatchCanvasHotkey("f", { editable: true, terminal: false })).toBe(false);
    expect(shouldDispatchCanvasHotkey("f", { editable: false, terminal: false })).toBe(true);
    expect(shouldDispatchCanvasHotkey("enter", { editable: true, terminal: false })).toBe(false);
  });

  it("lets Escape leave any non-terminal control, but never steals it from a terminal", () => {
    expect(shouldDispatchCanvasHotkey("escape", { editable: false, terminal: false })).toBe(true); // canvas
    expect(shouldDispatchCanvasHotkey("escape", { editable: true, terminal: false })).toBe(true); // note editor
    expect(shouldDispatchCanvasHotkey("escape", { editable: true, terminal: true })).toBe(false); // terminal keeps Esc
  });
});

describe("shouldDispatchCanvasHotkeyCommand", () => {
  it("yields every command, global ones included, to a surface that owns the chord", () => {
    // Off macOS a terminal owns Ctrl+K (kill-line) and Ctrl+Shift+V (paste); the caller reports it.
    const terminal = { editable: true, terminal: true, surfaceOwnsChord: true };
    expect(shouldDispatchCanvasHotkeyCommand("palette", "mod+k", terminal)).toBe(false);
    expect(shouldDispatchCanvasHotkeyCommand("toggle-dock", "mod+b", terminal)).toBe(false);
    expect(shouldDispatchCanvasHotkeyCommand("voice-command", "mod+shift+v", terminal)).toBe(false);
    // Unchanged where the surface does not own it — always the case on macOS.
    expect(shouldDispatchCanvasHotkeyCommand("palette", "mod+k", { ...terminal, surfaceOwnsChord: false })).toBe(true);
    expect(shouldDispatchCanvasHotkeyCommand("voice-command", "mod+shift+v", { ...terminal, surfaceOwnsChord: false })).toBe(true);
  });

  it("keeps destructive close-node shortcuts out of terminal and editable text contexts", () => {
    expect(shouldDispatchCanvasHotkeyCommand("close-node", "mod+backspace", { editable: true, terminal: true })).toBe(false);
    expect(shouldDispatchCanvasHotkeyCommand("close-node", "mod+delete", { editable: true, terminal: true })).toBe(false);
    expect(shouldDispatchCanvasHotkeyCommand("close-node", "mod+backspace", { editable: true, terminal: false })).toBe(false);
    expect(shouldDispatchCanvasHotkeyCommand("close-node", "mod+backspace", { editable: false, terminal: false })).toBe(true);
    // ⌘B is Bold in a Note editor, so the Dock leaves it there; a terminal does not type with it.
    expect(shouldDispatchCanvasHotkeyCommand("toggle-dock", "mod+b", { editable: true, terminal: false })).toBe(false);
    expect(shouldDispatchCanvasHotkeyCommand("toggle-dock", "mod+b", { editable: true, terminal: true })).toBe(true);
    expect(shouldDispatchCanvasHotkeyCommand("toggle-dock", "mod+b", { editable: false, terminal: false })).toBe(true);
  });

  it("still allows non-destructive modifier navigation from a focused terminal", () => {
    expect(shouldDispatchCanvasHotkeyCommand("focus-dir-right", "mod+alt+arrowright", { editable: true, terminal: true })).toBe(true);
  });

  describe("code editor target (Monaco in the Dock's Code app)", () => {
    const monaco = { editable: true, terminal: false, codeEditor: true };
    const monacoWithWidget = { ...monaco, editorWidgetOpen: true };

    it("keeps Escape for Monaco: multi-cursor, selection and widgets, with or without one open", () => {
      expect(shouldDispatchCanvasHotkeyCommand("exit-layer", "escape", monacoWithWidget)).toBe(false);
      expect(shouldDispatchCanvasHotkeyCommand("exit-layer", "escape", monaco)).toBe(false);
      expect(shouldDispatchCanvasHotkeyCommand("exit-layer", "escape", { editable: false, terminal: false })).toBe(true);
    });

    it("hands every other canvas chord to Monaco (board focus moves, group, palette)", () => {
      expect(shouldDispatchCanvasHotkeyCommand("focus-dir-up", "mod+alt+arrowup", monaco)).toBe(false);
      expect(shouldDispatchCanvasHotkeyCommand("focus-dir-down", "mod+alt+arrowdown", monaco)).toBe(false);
      expect(shouldDispatchCanvasHotkeyCommand("group", "mod+g", monaco)).toBe(false);
      expect(shouldDispatchCanvasHotkeyCommand("palette", "mod+k", monaco)).toBe(false);
      expect(shouldDispatchCanvasHotkeyCommand("focus-dir-up", "mod+alt+arrowup", { editable: false, terminal: false })).toBe(true);
    });

    it("hands the editor chord for focus mode (quick fix) to Monaco", () => {
      expect(shouldDispatchCanvasHotkeyCommand("toggle-focus-mode", "mod+.", monaco)).toBe(false);
      expect(shouldDispatchCanvasHotkeyCommand("toggle-focus-mode", "mod+.", { editable: false, terminal: false })).toBe(true);
    });

    it("keeps the Dock chord global: Monaco has no Bold", () => {
      expect(shouldDispatchCanvasHotkeyCommand("toggle-dock", "mod+b", monaco)).toBe(true);
      expect(shouldDispatchCanvasHotkeyCommand("widen-dock", "mod+\\", monaco)).toBe(true);
    });
  });

  it("dispatches fully custom voice chords from editable and terminal targets", () => {
    const focusedTerminal = { editable: true, terminal: true };
    expect(shouldDispatchCanvasHotkeyCommand("voice-command", "alt+c", focusedTerminal)).toBe(true);
    expect(shouldDispatchCanvasHotkeyCommand("voice-dictate", "f8", focusedTerminal)).toBe(true);
    expect(shouldDispatchCanvasHotkeyCommand("voice-dictate", "x", focusedTerminal)).toBe(true);
  });
});

// "/" is the dedicated trigger for the NL command bar (plans/nl-type-to-focus/PLAN.md §2) —
// registered as a remappable command, not hard-coded, so it shows up in Settings → Hotkeys and can be
// rebound like anything else.
describe("focus-command-bar", () => {
  afterEach(() => {
    resetCanvasHotkeyStoreForTests();
    try { localStorage.clear(); } catch {}
  });

  it("resolves through the real resolveHotkeyCommand from its default chord", () => {
    expect(resolveHotkeyCommand(evt({ key: "/" }), {})).toBe("focus-command-bar");
  });

  it("is refused for editable and terminal targets — never steals a keystroke from a note editor or a terminal", () => {
    expect(shouldDispatchCanvasHotkey("/", { editable: true, terminal: false })).toBe(false);
    // terminal (editable is always true alongside terminal, per isEditableCanvasKeyTarget)
    expect(shouldDispatchCanvasHotkey("/", { editable: true, terminal: true })).toBe(false);
    expect(shouldDispatchCanvasHotkeyCommand("focus-command-bar", "/", { editable: true, terminal: false })).toBe(false);
    // free on the bare canvas
    expect(shouldDispatchCanvasHotkey("/", { editable: false, terminal: false })).toBe(true);
    expect(shouldDispatchCanvasHotkeyCommand("focus-command-bar", "/", { editable: false, terminal: false })).toBe(true);
  });

  it("survives a localStorage override round trip", () => {
    setCanvasHotkeyOverride("focus-command-bar", "mod+/");
    // force a fresh hydrate, as if the page had reloaded and the module re-read localStorage
    resetCanvasHotkeyStoreForTests();
    const rehydrated = getCanvasHotkeyOverrides();
    expect(rehydrated["focus-command-bar"]).toBe("mod+/");
    expect(resolveHotkeyCommand(evt({ key: "/", metaKey: true }), rehydrated)).toBe("focus-command-bar");
  });
});

/**
 * Space belongs to ReactFlow, and this registry must never claim it.
 *
 * `panActivationKeyCode` defaults to `'Space'` in @xyflow/react, and the renderer computes
 * `panOnDrag = panActivationKeyPressed || _panOnDrag` — so holding Space is what lets a LEFT drag pan
 * the canvas whatever tool is active. CanvasPage otherwise restricts panning to `[1, 2]`
 * (middle/right button) while the select tool is active, which makes Space the only left-button pan
 * gesture there is, and effectively the only one on a trackpad.
 *
 * A `focus-command-bar-alt` command shipped bound to `space` and quietly took it: both window
 * listeners fired, the NL bar stole focus, and once focus sat in that input ReactFlow's `useKeyPress`
 * bailed out via `isInputDOMNode` so Space stopped arming pan at all. `/` already focuses the bar, so
 * the alternate was removed rather than rebound.
 *
 * plans/nl-type-to-focus §2 chose Space after asserting it was unclaimed — a check that searched this
 * repo but not ReactFlow's own defaults. This is the check that was missing.
 */
describe("reserved keys the canvas must not claim", () => {
  const REACTFLOW_RESERVED: Record<string, string> = {
    space: "ReactFlow panActivationKeyCode — hold-to-pan with the left button",
  };

  it("binds no command to a key ReactFlow reserves for its own gestures", () => {
    for (const command of CANVAS_HOTKEY_COMMANDS) {
      const reason = REACTFLOW_RESERVED[command.defaultChord];
      expect(reason, `"${command.id}" claims "${command.defaultChord}" — ${reason}`).toBeUndefined();
    }
  });

  it("no longer registers any command bound to space", () => {
    expect(CANVAS_HOTKEY_COMMANDS.some((c) => c.defaultChord === "space")).toBe(false);
    expect(resolveHotkeyCommand(evt({ key: " " }), {})).toBeNull();
  });

  it("drops a stale focus-command-bar-alt override left behind by an older build", () => {
    // sanitize() filters against the live registry, so removing the command cleans up on next load
    // instead of needing a migration.
    localStorage.setItem("canvas-hotkeys-v1", JSON.stringify({ "focus-command-bar-alt": "space" }));
    resetCanvasHotkeyStoreForTests();
    const rehydrated = getCanvasHotkeyOverrides();
    expect(rehydrated).not.toHaveProperty("focus-command-bar-alt");
    expect(resolveHotkeyCommand(evt({ key: " " }), rehydrated)).toBeNull();
  });
});

// The tool-shortcut listener (canvas-tool.ts) lives entirely outside this registry, so
// findChordConflict can never see it. findToolShortcutConflict reads the collision straight out of
// the real toolForShortcut map — never a copied letter list — so the two cannot drift apart the way
// the original ten-letter collision was missed (plans/nl-type-to-focus/PLAN.md §0/§1).
describe("findToolShortcutConflict", () => {
  it("names the tool a bare letter would switch to", () => {
    expect(findToolShortcutConflict("r")).toBe("rectangle");
    expect(findToolShortcutConflict("v")).toBe("select");
  });

  it("collides on shift+letter too — the tool map lowercases before matching", () => {
    expect(findToolShortcutConflict("shift+r")).toBe("rectangle");
  });

  it("covers capital R via chord canonicalization — normalizeChord already collapses it to the bare chord", () => {
    const chord = normalizeChord(evt({ key: "R" }));
    expect(chord).toBe("r");
    expect(findToolShortcutConflict(chord)).toBe("rectangle");
  });

  it("does not flag mod (or alt) chords — the tool listener is never reached with those held", () => {
    expect(findToolShortcutConflict("mod+r")).toBeNull();
    expect(findToolShortcutConflict("alt+r")).toBeNull();
  });

  it("returns null for chords the tool map doesn't claim", () => {
    expect(findToolShortcutConflict("/")).toBeNull();
    expect(findToolShortcutConflict("space")).toBeNull();
    expect(findToolShortcutConflict("z")).toBeNull();
  });
});

describe("jump to the agent that needs you", () => {
  it("is a remappable navigation command, unbound by default: ⌘J is the window's Jump palette", () => {
    const cmd = CANVAS_HOTKEY_COMMANDS.find((c) => c.id === "jump-needs-you");

    expect(cmd).toBeDefined();
    expect(cmd!.defaultChord).toBe("unbound");
    expect(cmd!.group).toBe("navigation");
    // Not `fixed`: the chord is not load-bearing for the canvas the way escape or mod+K are, and the
    // lane advertises whatever the operator has bound.
    expect(cmd!.fixed).toBeFalsy();
  });

  it("does not take a chord another command already owns", () => {
    const chords = CANVAS_HOTKEY_COMMANDS.map((c) => c.defaultChord);
    const duplicated = chords.filter((chord, i) => chords.indexOf(chord) !== i);

    expect(duplicated).toEqual([]);
  });

  it("fires on a chord the user binds, mod+J included, and nothing else", () => {
    const bindings = effectiveBindings({ "jump-needs-you": "mod+j" });

    expect(normalizeChord({ key: "j", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }))
      .toBe(bindings["jump-needs-you"]);
    expect(normalizeChord({ key: "j", metaKey: false, ctrlKey: true, altKey: false, shiftKey: false }))
      .toBe(bindings["jump-needs-you"]);
    expect(normalizeChord({ key: "j", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }))
      .not.toBe(bindings["jump-needs-you"]);
  });

});

describe("the fleet briefing", () => {
  it("is registered as a remappable navigation command on shift+F", () => {
    const cmd = CANVAS_HOTKEY_COMMANDS.find((c) => c.id === "fleet-briefing");

    expect(cmd).toBeDefined();
    expect(cmd!.defaultChord).toBe("shift+f");
    expect(cmd!.fixed).toBeFalsy();
  });

  it("does not take plain F, which type-to-focus already owns", () => {
    // CNVS binds this to F. Here that key is `jump-labels`, and stealing it would break a gesture
    // the canvas has had far longer than this one.
    const jumpLabels = CANVAS_HOTKEY_COMMANDS.find((c) => c.id === "jump-labels");

    expect(jumpLabels!.defaultChord).toBe("f");
    expect(findChordConflict("f", "fleet-briefing", {})).toBe("jump-labels");
  });

  it("never fires while the caret is in a text field or a terminal", () => {
    // `shift+f` carries no `mod`, so it is a plain keystroke: typing a capital F in an agent's
    // terminal or in the NL bar must not toggle a board-wide reveal. Safe because
    // `isEditableCanvasKeyTarget` counts `.xterm-helper-textarea`, which is where xterm puts
    // keyboard focus — verified rather than assumed, and pinned here because a refactor of that
    // predicate would silently expose every modifier-less chord.
    expect(shouldDispatchCanvasHotkey("shift+f", { editable: true, terminal: false })).toBe(false);
    expect(shouldDispatchCanvasHotkey("shift+f", { editable: true, terminal: true })).toBe(false);
    expect(shouldDispatchCanvasHotkey("shift+f", { editable: false, terminal: false })).toBe(true);
  });

  it("keeps every default chord unique", () => {
    const chords = CANVAS_HOTKEY_COMMANDS.map((c) => c.defaultChord);
    expect(chords.filter((c, i) => chords.indexOf(c) !== i)).toEqual([]);
  });
});

// Frame Switcher (LOT2-124): alt+N flies to a Frame, alt+shift+N sends the selection into it.
describe("frame switcher hotkeys", () => {
  const key = (over: { key: string; code: string; altKey: boolean; shiftKey: boolean }) => ({
    metaKey: false, ctrlKey: false, ...over,
  });

  it("registers go and move commands for 1-9 on alt+N and alt+shift+N", () => {
    const bindings = effectiveBindings({}) as Record<string, string>;
    for (const n of [1, 5, 9]) {
      expect(bindings[`frame-go-${n}`]).toBe(`alt+${n}`);
      expect(bindings[`frame-move-${n}`]).toBe(`alt+shift+${n}`);
    }
  });

  it("reads the digit from the physical key, since macOS Option+1 reports key '¡'", () => {
    expect(normalizeChord(key({ key: "¡", code: "Digit1", altKey: true, shiftKey: false }))).toBe("alt+1");
    expect(normalizeChord(key({ key: "⁄", code: "Digit1", altKey: true, shiftKey: true }))).toBe("alt+shift+1");
    expect(resolveHotkeyCommand(key({ key: "™", code: "Digit2", altKey: true, shiftKey: false }), {})).toBe("frame-go-2");
  });

  it("stays out of editable and terminal targets", () => {
    expect(shouldDispatchCanvasHotkeyCommand("frame-go-1" as never, "alt+1", { editable: true, terminal: false })).toBe(false);
    expect(shouldDispatchCanvasHotkeyCommand("frame-go-1" as never, "alt+1", { editable: true, terminal: true })).toBe(false);
    expect(shouldDispatchCanvasHotkeyCommand("frame-move-1" as never, "alt+shift+1", { editable: false, terminal: false })).toBe(true);
  });
});
