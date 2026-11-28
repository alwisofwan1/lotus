import { describe, expect, it, vi } from "vitest";

import {
  getTerminalShortcutSequence,
  handleTerminalCustomKeyEvent,
  isShiftEnterNewlineEvent,
  KITTY_SHIFT_ENTER_SEQUENCE,
  META_ENTER_SEQUENCE,
} from "../terminal-keybindings";

describe("getTerminalShortcutSequence", () => {
  it("maps Cmd+Backspace and Cmd+Delete to shell kill-line controls on macOS", () => {
    expect(
      getTerminalShortcutSequence({
        key: "Backspace",
        metaKey: true,
      }),
    ).toBe("\u0015");

    expect(
      getTerminalShortcutSequence({
        key: "Delete",
        metaKey: true,
      }),
    ).toBe("\u000b");
  });

  it("maps Option+Backspace and Option+Delete to word deletion controls", () => {
    expect(
      getTerminalShortcutSequence({
        key: "Backspace",
        altKey: true,
      }),
    ).toBe("\u0017");

    expect(
      getTerminalShortcutSequence({
        key: "Delete",
        altKey: true,
      }),
    ).toBe("\u001bd");
  });

  it("maps Option and Cmd arrow navigation to word and line movement controls", () => {
    expect(
      getTerminalShortcutSequence({
        key: "ArrowLeft",
        altKey: true,
      }),
    ).toBe("\u001bb");

    expect(
      getTerminalShortcutSequence({
        key: "ArrowRight",
        altKey: true,
      }),
    ).toBe("\u001bf");

    expect(
      getTerminalShortcutSequence({
        key: "ArrowLeft",
        metaKey: true,
      }),
    ).toBe("\u0001");

    expect(
      getTerminalShortcutSequence({
        key: "ArrowRight",
        metaKey: true,
      }),
    ).toBe("\u0005");
  });

  it("leaves unrelated shortcuts alone", () => {
    expect(
      getTerminalShortcutSequence({
        key: "f",
        metaKey: true,
      }),
    ).toBeNull();

    expect(
      getTerminalShortcutSequence({
        key: "Backspace",
      }),
    ).toBeNull();
  });

  it("deletes a word on Ctrl+Backspace and Ctrl+Delete off macOS, as every Windows field does", () => {
    expect(getTerminalShortcutSequence({ key: "Backspace", ctrlKey: true }, "Win32")).toBe("\u0017");
    expect(getTerminalShortcutSequence({ key: "Delete", ctrlKey: true }, "Win32")).toBe("\u001bd");
    expect(getTerminalShortcutSequence({ key: "Backspace", ctrlKey: true, shiftKey: true }, "Win32")).toBeNull();
  });

  it("leaves Ctrl+Backspace to xterm on macOS", () => {
    expect(getTerminalShortcutSequence({ key: "Backspace", ctrlKey: true }, "MacIntel")).toBeNull();
    expect(getTerminalShortcutSequence({ key: "Delete", ctrlKey: true }, "MacIntel")).toBeNull();
  });
});

describe("handleTerminalCustomKeyEvent", () => {
  it("writes mapped sequences on keydown and blocks xterm default handling", () => {
    const writes: string[] = [];

    const handled = handleTerminalCustomKeyEvent(
      {
        type: "keydown",
        key: "Backspace",
        metaKey: true,
      },
      (data) => writes.push(data),
    );

    expect(handled).toBe(false);
    expect(writes).toEqual(["\u0015"]);
  });

  it("gives custom handlers priority before terminal word-navigation shortcuts", () => {
    const writes: string[] = [];
    const customHandler = vi.fn(() => false);

    const handled = handleTerminalCustomKeyEvent(
      {
        type: "keydown",
        key: "ArrowRight",
        altKey: true,
        metaKey: true,
      },
      (data) => writes.push(data),
      customHandler,
    );

    expect(handled).toBe(false);
    expect(customHandler).toHaveBeenCalledOnce();
    expect(writes).toEqual([]);
  });

  it("ignores keyup and unmapped shortcuts", () => {
    const writes: string[] = [];

    expect(
      handleTerminalCustomKeyEvent(
        {
          type: "keyup",
          key: "Backspace",
          metaKey: true,
        },
        (data) => writes.push(data),
      ),
    ).toBe(true);

    expect(
      handleTerminalCustomKeyEvent(
        {
          type: "keydown",
          key: "f",
          metaKey: true,
        },
        (data) => writes.push(data),
      ),
    ).toBe(true);

    expect(writes).toEqual([]);
  });
});

describe("isShiftEnterNewlineEvent", () => {
  it("matches a plain Shift+Enter keydown", () => {
    expect(isShiftEnterNewlineEvent({ type: "keydown", key: "Enter", shiftKey: true })).toBe(true);
  });

  it("rejects chords carrying other modifiers", () => {
    expect(isShiftEnterNewlineEvent({ type: "keydown", key: "Enter", shiftKey: true, ctrlKey: true })).toBe(false);
    expect(isShiftEnterNewlineEvent({ type: "keydown", key: "Enter", shiftKey: true, metaKey: true })).toBe(false);
    expect(isShiftEnterNewlineEvent({ type: "keydown", key: "Enter", shiftKey: true, altKey: true })).toBe(false);
  });

  it("rejects plain Enter and IME composition events", () => {
    expect(isShiftEnterNewlineEvent({ type: "keydown", key: "Enter" })).toBe(false);
    expect(isShiftEnterNewlineEvent({ type: "keydown", key: "Enter", shiftKey: true, isComposing: true })).toBe(false);
    expect(isShiftEnterNewlineEvent({ type: "keydown", key: "Enter", shiftKey: true, keyCode: 229 })).toBe(false);
  });
});

describe("handleTerminalCustomKeyEvent Shift+Enter newline", () => {
  it("writes the configured sequence, prevents default, and blocks xterm handling", () => {
    const writes: string[] = [];
    const preventDefault = vi.fn();

    const handled = handleTerminalCustomKeyEvent(
      { type: "keydown", key: "Enter", shiftKey: true, preventDefault },
      (data) => writes.push(data),
      undefined,
      { shiftEnterSequence: () => KITTY_SHIFT_ENTER_SEQUENCE },
    );

    expect(handled).toBe(false);
    expect(writes).toEqual(["\u001b[13;2u"]);
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it("supports the meta-enter shell sequence", () => {
    const writes: string[] = [];

    handleTerminalCustomKeyEvent(
      { type: "keydown", key: "Enter", shiftKey: true },
      (data) => writes.push(data),
      undefined,
      { shiftEnterSequence: () => META_ENTER_SEQUENCE },
    );

    expect(writes).toEqual(["\u001b\r"]);
  });

  it("passes through when no newline options are set (legacy behavior)", () => {
    const writes: string[] = [];

    expect(
      handleTerminalCustomKeyEvent(
        { type: "keydown", key: "Enter", shiftKey: true },
        (data) => writes.push(data),
      ),
    ).toBe(true);
    expect(writes).toEqual([]);
  });

  it("passes through when the sequence resolver returns null (setting off)", () => {
    const writes: string[] = [];

    expect(
      handleTerminalCustomKeyEvent(
        { type: "keydown", key: "Enter", shiftKey: true },
        (data) => writes.push(data),
        undefined,
        { shiftEnterSequence: () => null },
      ),
    ).toBe(true);
    expect(writes).toEqual([]);
  });

  it("passes through when the kitty keyboard protocol is active so xterm encodes it", () => {
    const writes: string[] = [];

    expect(
      handleTerminalCustomKeyEvent(
        { type: "keydown", key: "Enter", shiftKey: true },
        (data) => writes.push(data),
        undefined,
        {
          shiftEnterSequence: () => KITTY_SHIFT_ENTER_SEQUENCE,
          isKittyKeyboardActive: () => true,
        },
      ),
    ).toBe(true);
    expect(writes).toEqual([]);
  });

  it("ignores keyup, modified chords, and IME composition", () => {
    const writes: string[] = [];
    const options = { shiftEnterSequence: () => META_ENTER_SEQUENCE };

    expect(
      handleTerminalCustomKeyEvent(
        { type: "keyup", key: "Enter", shiftKey: true },
        (data) => writes.push(data),
        undefined,
        options,
      ),
    ).toBe(true);

    expect(
      handleTerminalCustomKeyEvent(
        { type: "keydown", key: "Enter", shiftKey: true, ctrlKey: true },
        (data) => writes.push(data),
        undefined,
        options,
      ),
    ).toBe(true);

    expect(
      handleTerminalCustomKeyEvent(
        { type: "keydown", key: "Enter", shiftKey: true, isComposing: true },
        (data) => writes.push(data),
        undefined,
        options,
      ),
    ).toBe(true);

    expect(writes).toEqual([]);
  });

  it("lets custom handlers keep priority over the Shift+Enter newline rule", () => {
    const writes: string[] = [];
    const customHandler = vi.fn(() => true);

    const handled = handleTerminalCustomKeyEvent(
      { type: "keydown", key: "Enter", shiftKey: true },
      (data) => writes.push(data),
      customHandler,
      { shiftEnterSequence: () => META_ENTER_SEQUENCE },
    );

    expect(handled).toBe(true);
    expect(customHandler).toHaveBeenCalledOnce();
    expect(writes).toEqual([]);
  });
});
