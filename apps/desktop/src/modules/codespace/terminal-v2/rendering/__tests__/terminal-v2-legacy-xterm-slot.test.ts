import { describe, expect, it, vi } from "vitest";
import { createTerminalV2LegacyXtermSlot } from "../terminal-v2-legacy-xterm-slot";

describe("createTerminalV2LegacyXtermSlot", () => {
  it("wraps legacy xterm handles in a Terminal V2 renderer slot", () => {
    const terminal = {
      reset: vi.fn(),
      write: vi.fn(),
      refresh: vi.fn(),
      rows: 24,
    };
    const fitAddon = { fit: vi.fn() };
    const onAttach = vi.fn();
    const onRelease = vi.fn();

    const slot = createTerminalV2LegacyXtermSlot({
      paneId: "pane-1",
      terminal,
      fitAddon,
      onAttach,
      onRelease,
    });

    slot.attachPane("pane-1");
    slot.terminal.write("hello");
    slot.fitAddon.fit();
    slot.releasePane("pane-1", "snapshot");

    expect(slot.liveOutputMode).toBe("external");
    expect(onAttach).toHaveBeenCalledWith("pane-1");
    expect(terminal.write).toHaveBeenCalledWith("hello");
    expect(fitAddon.fit).toHaveBeenCalledOnce();
    expect(onRelease).toHaveBeenCalledWith("pane-1", "snapshot");
  });
});
