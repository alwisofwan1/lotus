import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCanvasHotkeys } from "../useCanvasHotkeys";
import { resetCanvasHotkeyStoreForTests, setCanvasHotkeyOverride } from "../useCanvasHotkeySettings";

afterEach(() => {
  resetCanvasHotkeyStoreForTests();
  try { localStorage.clear(); } catch {}
});

function keyEvent(type: "keydown" | "keyup", init: KeyboardEventInit, target: EventTarget = document.body) {
  const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function press(init: KeyboardEventInit, target: EventTarget = document.body) {
  return keyEvent("keydown", init, target);
}

function release(init: KeyboardEventInit, target: EventTarget = document.body) {
  return keyEvent("keyup", init, target);
}

describe("useCanvasHotkeys", () => {
  it("REPRO: fires fleet-briefing on a real shift+F keydown", () => {
    const onBriefing = vi.fn();
    renderHook(() => useCanvasHotkeys({ "fleet-briefing": onBriefing }));

    // Shift+F: the browser reports key "F" (uppercase) with shiftKey set.
    press({ key: "F", shiftKey: true });

    expect(onBriefing).toHaveBeenCalledTimes(1);
  });

  it("REPRO: fires jump-needs-you on a real cmd+J keydown once the user binds it", () => {
    const onJump = vi.fn();
    setCanvasHotkeyOverride("jump-needs-you", "mod+j");
    renderHook(() => useCanvasHotkeys({ "jump-needs-you": onJump }));

    press({ key: "j", metaKey: true });

    expect(onJump).toHaveBeenCalledTimes(1);
  });

  it("REPRO: still fires when a second consumer is mounted, as the voice controller is", () => {
    const onBriefing = vi.fn();
    renderHook(() => useCanvasHotkeys({ "voice-command": vi.fn() }));
    renderHook(() => useCanvasHotkeys({ "fleet-briefing": onBriefing }));

    press({ key: "F", shiftKey: true });

    expect(onBriefing).toHaveBeenCalledTimes(1);
  });

  it("invokes the handler for a resolved chord", () => {
    const onRight = vi.fn();
    renderHook(() => useCanvasHotkeys({ "focus-dir-right": onRight }));
    press({ key: "ArrowRight", ctrlKey: true, altKey: true });
    expect(onRight).toHaveBeenCalledTimes(1);
  });

  it("suppresses bare-key commands while an editable element is focused", () => {
    const onJump = vi.fn();
    renderHook(() => useCanvasHotkeys({ "jump-labels": onJump }));
    const input = document.createElement("input");
    document.body.appendChild(input);
    press({ key: "f" }, input);
    expect(onJump).not.toHaveBeenCalled();
    press({ key: "f" }); // on body — canvas layer
    expect(onJump).toHaveBeenCalledTimes(1);
    input.remove();
  });

  it("honors a live override", () => {
    const onCycle = vi.fn();
    renderHook(() => useCanvasHotkeys({ "cycle-forward": onCycle }));
    setCanvasHotkeyOverride("cycle-forward", "mod+m");
    press({ key: "m", metaKey: true });
    expect(onCycle).toHaveBeenCalledTimes(1);
  });

  it("moves Dictate off its default chord when the user remaps it", () => {
    const onDictate = vi.fn();
    renderHook(() => useCanvasHotkeys({ "voice-dictate": onDictate }));
    setCanvasHotkeyOverride("voice-dictate", "mod+shift+x");

    press({ key: "d", metaKey: true, shiftKey: true });
    expect(onDictate).not.toHaveBeenCalled();
    press({ key: "x", metaKey: true, shiftKey: true });
    expect(onDictate).toHaveBeenCalledTimes(1);
  });

  it("captures a user-chosen bare voice key before a focused editor can consume it", () => {
    const onDictate = vi.fn();
    setCanvasHotkeyOverride("voice-dictate", "x");
    renderHook(() => useCanvasHotkeys({ "voice-dictate": onDictate }));
    const input = document.createElement("input");
    const onInputKey = vi.fn();
    input.addEventListener("keydown", onInputKey);
    document.body.appendChild(input);

    const event = press({ key: "x" }, input);

    expect(onDictate).toHaveBeenCalledTimes(1);
    expect(onInputKey).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    input.remove();
  });

  it("fires a Command-only voice binding on keyup, not keydown", () => {
    const onCommand = vi.fn();
    setCanvasHotkeyOverride("voice-command", "meta");
    renderHook(() => useCanvasHotkeys({ "voice-command": onCommand }));

    press({ key: "Meta", metaKey: true });
    expect(onCommand).not.toHaveBeenCalled();
    const event = release({ key: "Meta" });

    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("does not fire Command-only when Command was used as part of another shortcut", () => {
    const onCommand = vi.fn();
    setCanvasHotkeyOverride("voice-command", "meta");
    renderHook(() => useCanvasHotkeys({ "voice-command": onCommand }));

    press({ key: "Meta", code: "MetaRight", location: 2, metaKey: true });
    press({ key: "c", code: "KeyC", metaKey: true });
    release({ key: "c", code: "KeyC", metaKey: true });
    release({ key: "Meta", code: "MetaRight", location: 2 });

    expect(onCommand).not.toHaveBeenCalled();
  });

  it("fires a Right Command binding only for the right physical key", () => {
    const onDictate = vi.fn();
    setCanvasHotkeyOverride("voice-dictate", "meta-right");
    renderHook(() => useCanvasHotkeys({ "voice-dictate": onDictate }));

    press({ key: "Meta", code: "MetaLeft", location: 1, metaKey: true });
    release({ key: "Meta", code: "MetaLeft", location: 1 });
    expect(onDictate).not.toHaveBeenCalled();

    press({ key: "Meta", code: "MetaRight", location: 2, metaKey: true });
    release({ key: "Meta", code: "MetaRight", location: 2 });
    expect(onDictate).toHaveBeenCalledTimes(1);
  });

  it("keeps a legacy generic Command binding active on either physical side", () => {
    const onCommand = vi.fn();
    setCanvasHotkeyOverride("voice-command", "meta");
    renderHook(() => useCanvasHotkeys({ "voice-command": onCommand }));

    press({ key: "Meta", code: "MetaLeft", location: 1, metaKey: true });
    release({ key: "Meta", code: "MetaLeft", location: 1 });
    press({ key: "Meta", code: "MetaRight", location: 2, metaKey: true });
    release({ key: "Meta", code: "MetaRight", location: 2 });

    expect(onCommand).toHaveBeenCalledTimes(2);
  });

  it("fails closed when keydown and keyup report different physical sides", () => {
    const onDictate = vi.fn();
    setCanvasHotkeyOverride("voice-dictate", "meta-right");
    renderHook(() => useCanvasHotkeys({ "voice-dictate": onDictate }));

    press({ key: "Meta", code: "MetaRight", location: 2, metaKey: true });
    release({ key: "Meta", code: "MetaLeft", location: 1 });

    expect(onDictate).not.toHaveBeenCalled();
  });

  it("lets Escape exit a non-terminal control but never steals it from a terminal", () => {
    const onExit = vi.fn();
    renderHook(() => useCanvasHotkeys({ "exit-layer": onExit }));

    const note = document.createElement("div");
    note.setAttribute("contenteditable", "true");
    document.body.appendChild(note);
    press({ key: "Escape" }, note);
    expect(onExit).toHaveBeenCalledTimes(1);

    const xterm = document.createElement("div");
    xterm.className = "xterm";
    const helper = document.createElement("textarea");
    helper.className = "xterm-helper-textarea";
    xterm.appendChild(helper);
    document.body.appendChild(xterm);
    press({ key: "Escape" }, helper);
    expect(onExit).toHaveBeenCalledTimes(1); // unchanged — terminal keeps Esc

    note.remove();
    xterm.remove();
  });

  it("does not close a node when Cmd/Ctrl+Backspace is used for terminal or editor text deletion", () => {
    const onClose = vi.fn();
    renderHook(() => useCanvasHotkeys({ "close-node": onClose }));

    const xterm = document.createElement("div");
    xterm.className = "xterm";
    const helper = document.createElement("textarea");
    helper.className = "xterm-helper-textarea";
    xterm.appendChild(helper);
    document.body.appendChild(xterm);
    const terminalBackspace = press({ key: "Backspace", metaKey: true }, helper);

    const input = document.createElement("input");
    document.body.appendChild(input);
    press({ key: "Backspace", metaKey: true }, input);

    expect(onClose).not.toHaveBeenCalled();
    expect(terminalBackspace.defaultPrevented).toBe(false);

    press({ key: "Backspace", metaKey: true });
    expect(onClose).toHaveBeenCalledTimes(1);

    xterm.remove();
    input.remove();
  });

  it("keeps remapped close-node delete chords out of focused terminals", () => {
    const onClose = vi.fn();
    setCanvasHotkeyOverride("close-node", "mod+delete");
    renderHook(() => useCanvasHotkeys({ "close-node": onClose }));

    const xterm = document.createElement("div");
    xterm.className = "xterm";
    const helper = document.createElement("textarea");
    helper.className = "xterm-helper-textarea";
    xterm.appendChild(helper);
    document.body.appendChild(xterm);
    const terminalDelete = press({ key: "Delete", metaKey: true }, helper);

    expect(onClose).not.toHaveBeenCalled();
    expect(terminalDelete.defaultPrevented).toBe(false);

    press({ key: "Delete", metaKey: true });
    expect(onClose).toHaveBeenCalledTimes(1);

    xterm.remove();
  });
});
