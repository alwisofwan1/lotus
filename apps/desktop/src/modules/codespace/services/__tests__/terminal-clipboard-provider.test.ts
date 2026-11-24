import { describe, expect, it, vi } from "vitest";
import { createTerminalClipboardProvider } from "@/modules/codespace/services/terminal-clipboard-provider";

describe("terminal clipboard provider (OSC 52)", () => {
  it("writes through the native plugin, which needs no user gesture", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const browserWrite = vi.fn();
    const provider = createTerminalClipboardProvider({
      invoke: invoke as never,
      inTauri: () => true,
      browserWrite,
    });

    await provider.writeText("c", "halo");

    expect(invoke).toHaveBeenCalledWith("plugin:clipboard-manager|write_text", { text: "halo" });
    expect(browserWrite).not.toHaveBeenCalled();
  });

  it("never throws when the clipboard refuses", async () => {
    /**
     * The whole reason this file exists: `navigator.clipboard.writeText` rejects with
     * NotAllowedError when there is no user gesture, and the OSC handler runs inside
     * `terminal.write(data)` — so the rejection escaped through the write pump and took down the
     * app while someone was merely selecting text (2026-09-20).
     */
    const refused = new Error("NotAllowedError");
    const onRefused = vi.fn();
    const provider = createTerminalClipboardProvider({
      invoke: vi.fn().mockRejectedValue(refused) as never,
      inTauri: () => true,
      browserWrite: vi.fn().mockRejectedValue(refused),
      onRefused,
    });

    await expect(provider.writeText("c", "halo")).resolves.toBeUndefined();
    expect(onRefused).toHaveBeenCalledTimes(2);
  });

  it("falls back to the browser API outside the desktop app", async () => {
    const browserWrite = vi.fn().mockResolvedValue(undefined);
    const invoke = vi.fn();
    const provider = createTerminalClipboardProvider({
      invoke: invoke as never,
      inTauri: () => false,
      browserWrite,
    });

    await provider.writeText("c", "halo");

    expect(invoke).not.toHaveBeenCalled();
    expect(browserWrite).toHaveBeenCalledWith("halo");
  });

  it("refuses to report the clipboard back to the program", () => {
    // OSC 52 can ask the terminal to READ the clipboard. Anything reaching a PTY could then take
    // whatever was last copied — including a program running over SSH.
    const provider = createTerminalClipboardProvider({ inTauri: () => true });
    expect(provider.readText()).toBe("");
  });
});
