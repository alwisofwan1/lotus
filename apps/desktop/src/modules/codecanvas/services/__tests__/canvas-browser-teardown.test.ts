import { describe, expect, it, vi } from "vitest";
import { collectCanvasBrowserTeardownIds, teardownCanvasBrowsers } from "../canvas-browser-teardown";

describe("collectCanvasBrowserTeardownIds", () => {
  it("returns the native WebView id for every browser node (terminal-paired → parentTerminalId, else node id)", () => {
    const nodes = [
      { id: "term-1", type: "terminal", data: {} },
      { id: "browser-1", type: "browser", data: { parentTerminalId: "term-1" } },
      { id: "browser-2", type: "browser", data: {} }, // standalone → own id is the native id
      { id: "note-1", type: "note", data: {} },
    ];
    expect(collectCanvasBrowserTeardownIds(nodes).sort()).toEqual(["browser-2", "term-1"]);
  });

  it("is empty when there are no browser nodes", () => {
    expect(collectCanvasBrowserTeardownIds([{ id: "t", type: "terminal", data: {} }])).toEqual([]);
  });
});

describe("teardownCanvasBrowsers", () => {
  it("parks each WebView off-screen BEFORE closing it (hide instantly, then destroy)", async () => {
    const order: string[] = [];
    const park = vi.fn(async (id: string) => { order.push(`park:${id}`); });
    const close = vi.fn(async (id: string) => { order.push(`close:${id}`); });

    await teardownCanvasBrowsers(["a"], { park, close });

    expect(park).toHaveBeenCalledWith("a");
    expect(close).toHaveBeenCalledWith("a");
    expect(order).toEqual(["park:a", "close:a"]);
  });

  it("closes every id even if one park/close rejects (best-effort, no partial teardown)", async () => {
    const closed: string[] = [];
    const park = vi.fn(async (id: string) => { if (id === "a") throw new Error("park failed"); });
    const close = vi.fn(async (id: string) => { closed.push(id); });

    await expect(teardownCanvasBrowsers(["a", "b"], { park, close })).resolves.toBeUndefined();
    expect(closed.sort()).toEqual(["a", "b"]); // "a" still closed despite its park throwing
  });
});
