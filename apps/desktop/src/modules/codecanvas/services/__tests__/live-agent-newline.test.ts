import { describe, expect, it } from "vitest";

import {
  KITTY_SHIFT_ENTER_SEQUENCE,
  META_ENTER_SEQUENCE,
} from "@/modules/codespace/services/terminal-keybindings";
import { resolveLiveAgentShiftEnterSequence } from "../live-agent-newline";

describe("resolveLiveAgentShiftEnterSequence", () => {
  it("gives claude-family runners the kitty Shift+Enter encoding", () => {
    expect(resolveLiveAgentShiftEnterSequence("claude")).toBe(KITTY_SHIFT_ENTER_SEQUENCE);
    expect(resolveLiveAgentShiftEnterSequence("ccs")).toBe(KITTY_SHIFT_ENTER_SEQUENCE);
    expect(resolveLiveAgentShiftEnterSequence("csp")).toBe(KITTY_SHIFT_ENTER_SEQUENCE);
  });

  it("defaults an undefined runner to claude", () => {
    expect(resolveLiveAgentShiftEnterSequence(undefined)).toBe(KITTY_SHIFT_ENTER_SEQUENCE);
  });

  it("honors the registry claude_family override for custom runners", () => {
    expect(resolveLiveAgentShiftEnterSequence("custom", true)).toBe(KITTY_SHIFT_ENTER_SEQUENCE);
  });

  it("falls back to meta-enter for non-claude runners", () => {
    expect(resolveLiveAgentShiftEnterSequence("codex")).toBe(META_ENTER_SEQUENCE);
    expect(resolveLiveAgentShiftEnterSequence("cursor")).toBe(META_ENTER_SEQUENCE);
    expect(resolveLiveAgentShiftEnterSequence("custom")).toBe(META_ENTER_SEQUENCE);
    expect(resolveLiveAgentShiftEnterSequence("custom", false)).toBe(META_ENTER_SEQUENCE);
  });
});
