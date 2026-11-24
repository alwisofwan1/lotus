import { describe, expect, it, vi } from "vitest";
import {
  closeCanvasBrowserSession,
  getCanvasBrowserSessionStatus,
  historyCanvasBrowserSession,
  isBlankCanvasBrowserUrl,
  isCanvasBrowserSessionOpen,
  navigateCanvasBrowserSession,
  normalizeCanvasBrowserInitialState,
  openCanvasBrowserSession,
  reloadCanvasBrowserSession,
  type CanvasBrowserLifecycleIpc,
} from "./canvas-browser-lifecycle-adapter";

function fakeIpc(overrides: Partial<CanvasBrowserLifecycleIpc> = {}): CanvasBrowserLifecycleIpc {
  return {
    open: vi.fn().mockResolvedValue({ ok: true, nodeId: "browser-1", url: "https://example.com/", reused: false }),
    close: vi.fn().mockResolvedValue(undefined),
    navigate: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn().mockResolvedValue(undefined),
    history: vi.fn().mockResolvedValue(undefined),
    isOpen: vi.fn().mockResolvedValue(true),
    status: vi.fn().mockResolvedValue({ open: true, viewportParked: false }),
    ...overrides,
  };
}

describe("canvas browser lifecycle adapter", () => {
  it("recognizes blank browser URLs", () => {
    expect(isBlankCanvasBrowserUrl("")).toBe(true);
    expect(isBlankCanvasBrowserUrl(" about:blank ")).toBe(true);
    expect(isBlankCanvasBrowserUrl("https://example.com")).toBe(false);
  });

  it("normalizes loading blank browsers to disconnected", () => {
    expect(normalizeCanvasBrowserInitialState("about:blank", "loading")).toBe("disconnected");
    expect(normalizeCanvasBrowserInitialState("https://example.com", "loading")).toBe("loading");
  });

  it("normalizes a blank active claim to disconnected — there is no page to be live on", () => {
    expect(normalizeCanvasBrowserInitialState("about:blank", "active")).toBe("disconnected");
    expect(normalizeCanvasBrowserInitialState("", "active")).toBe("disconnected");
    expect(normalizeCanvasBrowserInitialState("https://example.com", "active")).toBe("active");
  });

  it("opens through injected IPC and returns the resolved URL", async () => {
    const ipc = fakeIpc();
    const url = await openCanvasBrowserSession({
      nativeBrowserId: "term-1",
      targetUrl: "example.com",
      bounds: { x: 1, y: 2, width: 300, height: 200 },
      ipc,
    });

    expect(url).toBe("https://example.com/");
    expect(ipc.open).toHaveBeenCalledWith("term-1", "example.com", { x: 1, y: 2, width: 300, height: 200 }, undefined);
  });

  it("forwards the allowed root when opening a local file", async () => {
    const ipc = fakeIpc();
    await openCanvasBrowserSession({
      nativeBrowserId: "term-1",
      targetUrl: "file:///Users/alwi/proj/index.html",
      bounds: { x: 1, y: 2, width: 300, height: 200 },
      allowedRoot: "/Users/alwi/proj",
      ipc,
    });
    expect(ipc.open).toHaveBeenCalledWith(
      "term-1",
      "file:///Users/alwi/proj/index.html",
      { x: 1, y: 2, width: 300, height: 200 },
      "/Users/alwi/proj",
    );
  });

  it("forwards the allowed root when navigating to a local file", async () => {
    const ipc = fakeIpc();
    await navigateCanvasBrowserSession(
      "term-1",
      "file:///Users/alwi/proj/page.html",
      "/Users/alwi/proj",
      ipc,
    );
    expect(ipc.navigate).toHaveBeenCalledWith(
      "term-1",
      "file:///Users/alwi/proj/page.html",
      "/Users/alwi/proj",
    );
  });

  it("falls back to target URL when native open returns an empty URL", async () => {
    const ipc = fakeIpc({ open: vi.fn().mockResolvedValue({ ok: true, nodeId: "browser-1", url: "", reused: false }) });
    await expect(openCanvasBrowserSession({
      nativeBrowserId: "term-1",
      targetUrl: "example.com",
      bounds: { x: 1, y: 2, width: 300, height: 200 },
      ipc,
    })).resolves.toBe("example.com");
  });

  it("routes close, navigate, reload, and history through injected IPC", async () => {
    const ipc = fakeIpc();

    await closeCanvasBrowserSession("term-1", ipc);
    await navigateCanvasBrowserSession("term-1", "https://next.local", undefined, ipc);
    await reloadCanvasBrowserSession("term-1", ipc);
    await historyCanvasBrowserSession("term-1", -1, ipc);
    await historyCanvasBrowserSession("term-1", 1, ipc);

    expect(ipc.close).toHaveBeenCalledWith("term-1");
    expect(ipc.navigate).toHaveBeenCalledWith("term-1", "https://next.local", undefined);
    expect(ipc.reload).toHaveBeenCalledWith("term-1");
    expect(ipc.history).toHaveBeenNthCalledWith(1, "term-1", -1);
    expect(ipc.history).toHaveBeenNthCalledWith(2, "term-1", 1);
  });

  it("probes native WebView existence through injected IPC", async () => {
    const ipc = fakeIpc({ isOpen: vi.fn().mockResolvedValue(false) });
    await expect(isCanvasBrowserSessionOpen("term-1", ipc)).resolves.toBe(false);
    expect(ipc.isOpen).toHaveBeenCalledWith("term-1");
  });

  it("probes native WebView status (existence + parked) through injected IPC", async () => {
    const ipc = fakeIpc({ status: vi.fn().mockResolvedValue({ open: true, viewportParked: true }) });
    await expect(getCanvasBrowserSessionStatus("term-1", ipc)).resolves.toEqual({ open: true, viewportParked: true });
    expect(ipc.status).toHaveBeenCalledWith("term-1");
  });
});
