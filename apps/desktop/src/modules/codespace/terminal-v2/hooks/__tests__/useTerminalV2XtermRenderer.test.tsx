import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useTerminalV2XtermRenderer } from "../useTerminalV2XtermRenderer";
import type { TerminalV2OwnedXtermRenderer } from "../../rendering/terminal-v2-owned-xterm-renderer";

describe("useTerminalV2XtermRenderer", () => {
  it("returns a stable V2-owned renderer factory", async () => {
    const renderer = {
      terminal: { open: vi.fn(), dispose: vi.fn() },
      addons: { dispose: vi.fn() },
      helperTextarea: null,
      dispose: vi.fn(),
    } as unknown as TerminalV2OwnedXtermRenderer;
    const createRenderer = vi.fn(async () => renderer);
    const { result, rerender } = renderHook(() => useTerminalV2XtermRenderer({ createRenderer }));
    const initialFactory = result.current;

    const request = {
      container: document.createElement("div"),
      cwd: "/repo",
      fontSize: 12,
    };
    const created = await result.current(request);
    rerender();

    expect(created).toBe(renderer);
    expect(createRenderer).toHaveBeenCalledWith(request);
    expect(result.current).toBe(initialFactory);
  });
});
