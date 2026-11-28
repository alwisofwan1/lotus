import { describe, expect, it, vi } from "vitest";
import {
  resolveTerminalClipboardKeyIntent,
  withTerminalClipboardKeys,
  type TerminalClipboardKeyEvent,
} from "@/modules/codespace/services/terminal-clipboard-keys";

const MAC = "MacIntel";
const WIN = "Win32";

function key(overrides: Partial<TerminalClipboardKeyEvent>): TerminalClipboardKeyEvent {
  return { type: "keydown", key: "c", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...overrides };
}

describe("resolveTerminalClipboardKeyIntent", () => {
  it("copies on Ctrl+C only when something is selected; otherwise it stays SIGINT", () => {
    expect(resolveTerminalClipboardKeyIntent(key({ ctrlKey: true }), true, WIN)).toBe("copy");
    expect(resolveTerminalClipboardKeyIntent(key({ ctrlKey: true }), false, WIN)).toBeNull();
  });

  it("copies on Ctrl+Shift+C, and swallows it with nothing selected", () => {
    expect(resolveTerminalClipboardKeyIntent(key({ key: "C", ctrlKey: true, shiftKey: true }), true, WIN)).toBe("copy");
    expect(resolveTerminalClipboardKeyIntent(key({ key: "C", ctrlKey: true, shiftKey: true }), false, WIN)).toBe("swallow");
  });

  it("pastes on Ctrl+V and Ctrl+Shift+V", () => {
    expect(resolveTerminalClipboardKeyIntent(key({ key: "v", ctrlKey: true }), false, WIN)).toBe("paste");
    expect(resolveTerminalClipboardKeyIntent(key({ key: "V", ctrlKey: true, shiftKey: true }), false, WIN)).toBe("paste");
  });

  it("recognises the keys on a non-Latin layout by their physical position", () => {
    expect(resolveTerminalClipboardKeyIntent(key({ key: "м", code: "KeyV", ctrlKey: true }), false, WIN)).toBe("paste");
  });

  it("leaves every other Ctrl key, Alt+V and keyup to the terminal", () => {
    expect(resolveTerminalClipboardKeyIntent(key({ key: "k", ctrlKey: true }), true, WIN)).toBeNull();
    expect(resolveTerminalClipboardKeyIntent(key({ key: "v", altKey: true }), false, WIN)).toBeNull();
    expect(resolveTerminalClipboardKeyIntent(key({ key: "v", ctrlKey: true, type: "keyup" }), false, WIN)).toBeNull();
  });

  it("does nothing on macOS, where ⌘C/⌘V never reach xterm as control characters", () => {
    expect(resolveTerminalClipboardKeyIntent(key({ ctrlKey: true }), true, MAC)).toBeNull();
    expect(resolveTerminalClipboardKeyIntent(key({ key: "v", ctrlKey: true }), false, MAC)).toBeNull();
    expect(resolveTerminalClipboardKeyIntent(key({ key: "v", metaKey: true }), false, MAC)).toBeNull();
  });
});

function keyboardEvent(init: Partial<TerminalClipboardKeyEvent>): KeyboardEvent {
  const { type = "keydown", ...rest } = init;
  return new KeyboardEvent(type, { cancelable: true, ...rest });
}

describe("withTerminalClipboardKeys", () => {
  function setup(selection: string) {
    const terminal = {
      hasSelection: () => selection.length > 0,
      getSelection: () => selection,
      clearSelection: vi.fn(),
    };
    const next = vi.fn(() => true);
    const writeText = vi.fn();
    const handler = withTerminalClipboardKeys(terminal, next, { platform: WIN, writeText });
    return { terminal, next, writeText, handler };
  }

  it("copies the selection, clears it, and keeps the key from xterm", () => {
    const { terminal, next, writeText, handler } = setup("npm run build");
    const event = keyboardEvent({ key: "c", ctrlKey: true });
    expect(handler(event)).toBe(false);
    expect(writeText).toHaveBeenCalledWith("npm run build");
    expect(terminal.clearSelection).toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    expect(next).not.toHaveBeenCalled();
  });

  it("hands Ctrl+C with nothing selected to the next handler, so it is still SIGINT", () => {
    const { next, writeText, handler } = setup("");
    expect(handler(keyboardEvent({ key: "c", ctrlKey: true }))).toBe(true);
    expect(next).toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("skips xterm on Ctrl+V WITHOUT preventing the default, so the browser's paste runs", () => {
    const { next, handler } = setup("");
    const event = keyboardEvent({ key: "v", ctrlKey: true });
    expect(handler(event)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(next).not.toHaveBeenCalled();
  });

  it("passes every other key straight through", () => {
    const { next, handler } = setup("text");
    handler(keyboardEvent({ key: "Enter", shiftKey: true }));
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("is a pure pass-through on macOS", () => {
    const next = vi.fn(() => true);
    const writeText = vi.fn();
    const handler = withTerminalClipboardKeys({ hasSelection: () => true, getSelection: () => "x" }, next, { platform: MAC, writeText });
    expect(handler(keyboardEvent({ key: "c", ctrlKey: true }))).toBe(true);
    expect(handler(keyboardEvent({ key: "v", ctrlKey: true }))).toBe(true);
    expect(next).toHaveBeenCalledTimes(2);
    expect(writeText).not.toHaveBeenCalled();
  });
});
