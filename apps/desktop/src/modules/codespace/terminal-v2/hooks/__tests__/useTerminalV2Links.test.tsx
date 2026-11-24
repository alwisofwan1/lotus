import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TerminalLinkContextMenuPayload } from "@/modules/codespace/services/terminal-addons";
import { useTerminalV2Links } from "../useTerminalV2Links";

function createPayload(): TerminalLinkContextMenuPayload {
  return {
    clientX: 150,
    clientY: 80,
    link: {
      kind: "external",
      text: "https://example.com",
      url: "https://example.com",
      start: 0,
      end: 19,
    },
  };
}

describe("useTerminalV2Links", () => {
  it("normalizes link context menu coordinates relative to the terminal container", () => {
    const onLinkContextMenu = vi.fn();
    const rect = { left: 50, top: 20 } as DOMRect;

    const { result } = renderHook(() => useTerminalV2Links({ onLinkContextMenu }));
    result.current.linkContextAdapter.openContextMenu(createPayload(), rect);

    expect(onLinkContextMenu).toHaveBeenCalledWith(expect.objectContaining({
      clientX: 100,
      clientY: 60,
    }));
  });

  it("preserves coordinates when no container rect is available", () => {
    const onLinkContextMenu = vi.fn();

    const { result } = renderHook(() => useTerminalV2Links({ onLinkContextMenu }));
    result.current.linkContextAdapter.openContextMenu(createPayload(), null);

    expect(onLinkContextMenu).toHaveBeenCalledWith(expect.objectContaining({
      clientX: 150,
      clientY: 80,
    }));
  });
});
