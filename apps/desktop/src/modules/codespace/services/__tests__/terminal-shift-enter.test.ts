import { describe, expect, it } from "vitest";
import {
  KITTY_SHIFT_ENTER_SEQUENCE,
  META_ENTER_SEQUENCE,
} from "@/modules/codespace/services/terminal-keybindings";
import { resolveTerminalShiftEnterSequence } from "../terminal-shift-enter";

describe("resolveTerminalShiftEnterSequence", () => {
  it("sends the kitty encoding to Claude-family agent panes", () => {
    expect(resolveTerminalShiftEnterSequence("claude")).toBe(KITTY_SHIFT_ENTER_SEQUENCE);
    expect(resolveTerminalShiftEnterSequence("claude --resume abc123")).toBe(KITTY_SHIFT_ENTER_SEQUENCE);
    expect(resolveTerminalShiftEnterSequence("ccs")).toBe(KITTY_SHIFT_ENTER_SEQUENCE);
    expect(resolveTerminalShiftEnterSequence("ccs hss")).toBe(KITTY_SHIFT_ENTER_SEQUENCE);
    expect(resolveTerminalShiftEnterSequence("csp")).toBe(KITTY_SHIFT_ENTER_SEQUENCE);
  });

  it("sends Meta+Enter to a plain shell pane", () => {
    expect(resolveTerminalShiftEnterSequence(undefined)).toBe(META_ENTER_SEQUENCE);
    expect(resolveTerminalShiftEnterSequence("")).toBe(META_ENTER_SEQUENCE);
    expect(resolveTerminalShiftEnterSequence("   ")).toBe(META_ENTER_SEQUENCE);
  });

  it("sends Meta+Enter to non-Claude agent CLIs", () => {
    expect(resolveTerminalShiftEnterSequence("codex")).toBe(META_ENTER_SEQUENCE);
    expect(resolveTerminalShiftEnterSequence("gemini")).toBe(META_ENTER_SEQUENCE);
    expect(resolveTerminalShiftEnterSequence("cursor-agent")).toBe(META_ENTER_SEQUENCE);
  });

  it("ignores casing and padding around the command", () => {
    expect(resolveTerminalShiftEnterSequence("  Claude  ")).toBe(KITTY_SHIFT_ENTER_SEQUENCE);
  });
});
