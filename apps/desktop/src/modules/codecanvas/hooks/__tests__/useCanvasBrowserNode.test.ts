import { act, render, renderHook, waitFor } from "@testing-library/react";
import { createElement, StrictMode } from "react";
import type { MutableRefObject, ReactNode, RefObject } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/tauri/canvas-browser", () => ({
  openCanvasBrowser: vi.fn().mockResolvedValue({ ok: true, nodeId: "test-node", url: "http://localhost:3000/", reused: false }),
  closeCanvasBrowser: vi.fn().mockResolvedValue(undefined),
  navigateCanvasBrowser: vi.fn().mockResolvedValue(undefined),
  syncCanvasBrowserBounds: vi.fn().mockResolvedValue(undefined),
  reloadCanvasBrowser: vi.fn().mockResolvedValue(undefined),
  historyCanvasBrowser: vi.fn().mockResolvedValue(undefined),
  isCanvasBrowserOpen: vi.fn().mockResolvedValue(true),
  getCanvasBrowserStatus: vi.fn().mockResolvedValue({ open: true, viewportParked: false }),
}));

import * as canvasBrowserApi from "@/lib/tauri/canvas-browser";
import { useCanvasBrowserNode } from "../useCanvasBrowserNode";
import { setActiveProjectRootDir } from "../../services/canvas-active-project";

function mockBoundingRect(x = 100, y = 200, width = 640, height = 480) {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    x, y, width, height, top: y, left: x, bottom: y + height, right: x + width, toJSON: () => ({}),
  } as DOMRect);
}

function attachContainer(ref: RefObject<HTMLDivElement | null>) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  (ref as MutableRefObject<HTMLDivElement | null>).current = el;
  return el;
}

function BrowserHookProbe() {
  const browser = useCanvasBrowserNode({
    nodeId: "node-1",
    initialUrl: "http://localhost:3000",
    initialState: "active",
  });

  return createElement(
    "div",
    { className: "canvas-center" },
    createElement(
      "div",
      { className: "react-flow" },
      createElement(
        "div",
        { className: "react-flow__viewport" },
        createElement(
          "div",
          { className: "react-flow__node", "data-testid": "flow-node" },
          createElement("div", { ref: browser.containerRef, "data-testid": "browser-host" }),
        ),
      ),
    ),
  );
}

function StrictModeWrapper({ children }: { children: ReactNode }) {
  return createElement(StrictMode, null, children);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  mockBoundingRect();
  setActiveProjectRootDir("");
});

describe("useCanvasBrowserNode", () => {
  it("starts in disconnected state when initialState is disconnected", () => {
    const { result } = renderHook(() =>
      useCanvasBrowserNode({ nodeId: "node-1", initialUrl: "http://localhost:3000", initialState: "disconnected" }),
    );
    expect(result.current.browserState).toBe("disconnected");
    expect(result.current.currentUrl).toBe("http://localhost:3000");
  });

  it("openBrowser transitions state to active and calls Tauri IPC with bounds", async () => {
    const { result } = renderHook(() =>
      useCanvasBrowserNode({ nodeId: "node-1", initialUrl: "http://localhost:3000", initialState: "disconnected" }),
    );
    await act(async () => { await result.current.openBrowser(); });
    expect(result.current.browserState).toBe("active");
    expect(result.current.nativeErrorReason).toBeNull();
    expect(canvasBrowserApi.openCanvasBrowser).toHaveBeenCalledWith(
      "node-1",
      "http://localhost:3000",
      expect.objectContaining({ width: 640, height: 480 }),
      undefined,
    );
  });

  it("openBrowser passes the native browser zoom factor", async () => {
    const { result } = renderHook(() =>
      useCanvasBrowserNode({
        nodeId: "node-1",
        initialUrl: "http://localhost:3000",
        initialState: "disconnected",
        zoomFactor: 0.5,
      }),
    );
    await act(async () => { await result.current.openBrowser(); });
    expect(canvasBrowserApi.openCanvasBrowser).toHaveBeenCalledWith(
      "node-1",
      "http://localhost:3000",
      expect.objectContaining({ width: 640, height: 480, zoomFactor: 0.5 }),
      undefined,
    );
  });

  it("surfaces browser open failures as recoverable disconnected state", async () => {
    vi.mocked(canvasBrowserApi.openCanvasBrowser).mockRejectedValueOnce(new Error("native view missing"));
    const { result } = renderHook(() =>
      useCanvasBrowserNode({ nodeId: "node-1", initialUrl: "http://localhost:3000", initialState: "disconnected" }),
    );

    await act(async () => { await result.current.openBrowser(); });

    expect(result.current.browserState).toBe("disconnected");
    expect(result.current.nativeErrorReason).toBe("native view missing");
  });

  it("uses nativeBrowserId for Tauri IPC while keeping BrowserNode id for UI state", async () => {
    const { result } = renderHook(() =>
      useCanvasBrowserNode({
        nodeId: "browser-1",
        nativeBrowserId: "term-1",
        initialUrl: "http://localhost:3000",
        initialState: "disconnected",
      }),
    );
    await act(async () => { await result.current.openBrowser(); });
    expect(canvasBrowserApi.openCanvasBrowser).toHaveBeenCalledWith(
      "term-1",
      "http://localhost:3000",
      expect.objectContaining({ width: 640, height: 480 }),
      undefined,
    );

    await act(async () => { await result.current.navigateBrowser("http://localhost:4000"); });
    expect(canvasBrowserApi.navigateCanvasBrowser).toHaveBeenCalledWith("term-1", "http://localhost:4000", undefined);

    await act(async () => { await result.current.reloadBrowser(); });
    expect(canvasBrowserApi.reloadCanvasBrowser).toHaveBeenCalledWith("term-1");

    await act(async () => { await result.current.closeBrowser(); });
    expect(canvasBrowserApi.closeCanvasBrowser).toHaveBeenCalledWith("term-1");
  });

  it("auto-opens a node intentionally created in loading state with a real URL", async () => {
    const { result } = renderHook(() =>
      useCanvasBrowserNode({ nodeId: "node-1", initialUrl: "http://localhost:3000", initialState: "loading" }),
    );
    await waitFor(() => expect(result.current.browserState).toBe("active"));
    expect(canvasBrowserApi.openCanvasBrowser).toHaveBeenCalledWith(
      "node-1",
      "http://localhost:3000",
      expect.objectContaining({ width: 640, height: 480 }),
      undefined,
    );
  });

  it("auto-opens in React StrictMode after the first scheduled frame is cancelled", async () => {
    vi.mocked(canvasBrowserApi.openCanvasBrowser).mockResolvedValueOnce({
      ok: true,
      nodeId: "node-1",
      url: "https://google.com/",
      reused: false,
    });

    const { result } = renderHook(
      () => useCanvasBrowserNode({ nodeId: "node-1", initialUrl: "google.com", initialState: "loading" }),
      { wrapper: StrictModeWrapper },
    );

    await waitFor(() => expect(result.current.browserState).toBe("active"));
    expect(canvasBrowserApi.openCanvasBrowser).toHaveBeenCalledTimes(1);
    expect(canvasBrowserApi.openCanvasBrowser).toHaveBeenCalledWith(
      "node-1",
      "google.com",
      expect.objectContaining({ width: 640, height: 480 }),
      undefined,
    );
    expect(result.current.currentUrl).toBe("https://google.com/");
  });

  it("auto-opens when a disconnected node is patched to loading with a real URL", async () => {
    const { result, rerender } = renderHook(
      ({ initialUrl, initialState }: { initialUrl: string; initialState: "disconnected" | "loading" }) =>
        useCanvasBrowserNode({ nodeId: "node-1", initialUrl, initialState }),
      { initialProps: { initialUrl: "about:blank", initialState: "disconnected" } },
    );
    expect(result.current.browserState).toBe("disconnected");

    rerender({ initialUrl: "http://localhost:3000", initialState: "loading" });

    await waitFor(() => expect(result.current.browserState).toBe("active"));
    expect(canvasBrowserApi.openCanvasBrowser).toHaveBeenCalledWith(
      "node-1",
      "http://localhost:3000",
      expect.objectContaining({ width: 640, height: 480 }),
      undefined,
    );
  });

  it("does not leave blank browser nodes stuck in loading", async () => {
    const { result } = renderHook(() =>
      useCanvasBrowserNode({ nodeId: "node-1", initialUrl: "about:blank", initialState: "loading" }),
    );
    await waitFor(() => expect(result.current.browserState).toBe("disconnected"));
    expect(canvasBrowserApi.openCanvasBrowser).not.toHaveBeenCalled();
  });

  it("closeBrowser transitions state to disconnected and calls Tauri IPC", async () => {
    const { result } = renderHook(() =>
      useCanvasBrowserNode({ nodeId: "node-1", initialUrl: "http://localhost:3000", initialState: "active" }),
    );
    await act(async () => { await result.current.closeBrowser(); });
    expect(result.current.browserState).toBe("disconnected");
    expect(canvasBrowserApi.closeCanvasBrowser).toHaveBeenCalledWith("node-1");
  });

  it("mirrors an external URL change (agent/NL navigation) into the displayed URL", async () => {
    // Agent/NL navigation patches node.data.url and drives the native navigate
    // itself, without going through the hook's navigateBrowser. The address bar
    // (currentUrl) must still follow, or it shows a stale/blank URL over a page
    // that has already moved on.
    const { result, rerender } = renderHook(
      ({ initialUrl }: { initialUrl: string }) =>
        useCanvasBrowserNode({ nodeId: "node-1", initialUrl, initialState: "disconnected" }),
      { initialProps: { initialUrl: "https://www.youtube.com/" } },
    );
    expect(result.current.currentUrl).toBe("https://www.youtube.com/");

    rerender({ initialUrl: "https://www.instagram.com/" });
    expect(result.current.currentUrl).toBe("https://www.instagram.com/");
  });

  it("navigateBrowser calls Tauri IPC and updates currentUrl", async () => {
    const { result } = renderHook(() =>
      useCanvasBrowserNode({ nodeId: "node-1", initialUrl: "http://localhost:3000", initialState: "active" }),
    );
    await act(async () => { await result.current.navigateBrowser("http://localhost:4000"); });
    expect(canvasBrowserApi.navigateCanvasBrowser).toHaveBeenCalledWith("node-1", "http://localhost:4000", undefined);
    expect(result.current.currentUrl).toBe("http://localhost:4000");
  });

  it("self-heals a dead native navigate by re-opening at the requested URL", async () => {
    vi.mocked(canvasBrowserApi.navigateCanvasBrowser).mockRejectedValueOnce(new Error("Canvas browser is not open."));
    vi.mocked(canvasBrowserApi.openCanvasBrowser).mockResolvedValueOnce({
      ok: true, nodeId: "node-1", url: "http://localhost:4000/", reused: false,
    });
    const { result } = renderHook(() =>
      useCanvasBrowserNode({ nodeId: "node-1", initialUrl: "http://localhost:3000", initialState: "disconnected" }),
    );

    await act(async () => { await result.current.navigateBrowser("http://localhost:4000"); });

    expect(canvasBrowserApi.openCanvasBrowser).toHaveBeenCalledWith(
      "node-1",
      "http://localhost:4000",
      expect.anything(),
      undefined,
    );
    expect(result.current.browserState).toBe("active");
    expect(result.current.currentUrl).toBe("http://localhost:4000/");
    expect(result.current.nativeErrorReason).toBeNull();
  });

  it("surfaces a visible recovery state when both navigate and re-open fail", async () => {
    vi.mocked(canvasBrowserApi.navigateCanvasBrowser).mockRejectedValueOnce(new Error("Canvas browser is not open."));
    vi.mocked(canvasBrowserApi.openCanvasBrowser).mockRejectedValueOnce(new Error("native view missing"));
    const { result } = renderHook(() =>
      useCanvasBrowserNode({ nodeId: "node-1", initialUrl: "http://localhost:3000", initialState: "disconnected" }),
    );

    await act(async () => { await result.current.navigateBrowser("http://localhost:4000"); });

    expect(result.current.browserState).toBe("disconnected");
    expect(result.current.nativeErrorReason).toBe("native view missing");
  });

  it("re-opens the native WebView when mounted with a stale active claim", async () => {
    // A node can remount believing it is "active" (LOD collapse, focus mode,
    // project switch) while its native WebView was closed on unmount. The
    // claim must be re-earned by re-opening, or the pane renders black.
    const { result } = renderHook(() =>
      useCanvasBrowserNode({ nodeId: "node-1", initialUrl: "http://localhost:3000", initialState: "active" }),
    );

    await waitFor(() => expect(canvasBrowserApi.openCanvasBrowser).toHaveBeenCalledWith(
      "node-1",
      "http://localhost:3000",
      expect.anything(),
      undefined,
    ));
    await waitFor(() => expect(result.current.browserState).toBe("active"));
  });

  it("re-opens a stale active claim exactly once under StrictMode", async () => {
    renderHook(
      () => useCanvasBrowserNode({ nodeId: "node-1", initialUrl: "http://localhost:3000", initialState: "active" }),
      { wrapper: StrictModeWrapper },
    );

    await waitFor(() => expect(canvasBrowserApi.openCanvasBrowser).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(canvasBrowserApi.openCanvasBrowser).toHaveBeenCalledTimes(1);
  });

  it("treats a blank active claim as disconnected and does not re-open", async () => {
    const { result } = renderHook(() =>
      useCanvasBrowserNode({ nodeId: "node-1", initialUrl: "about:blank", initialState: "active" }),
    );

    expect(result.current.browserState).toBe("disconnected");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(canvasBrowserApi.openCanvasBrowser).not.toHaveBeenCalled();
  });

  it("self-heals a black pane: re-opens when a focus regain finds the WebView gone", async () => {
    // A mounted, active node whose native WebView was torn down mid-session
    // (crash, park-at-open, uncovered teardown) renders black under a live dot.
    // Returning to the window must detect the absent WebView and re-open it.
    const { result } = renderHook(() =>
      useCanvasBrowserNode({ nodeId: "node-1", initialUrl: "http://localhost:3000", initialState: "disconnected" }),
    );
    await act(async () => { await result.current.openBrowser(); });
    expect(canvasBrowserApi.openCanvasBrowser).toHaveBeenCalledTimes(1);

    vi.mocked(canvasBrowserApi.getCanvasBrowserStatus).mockResolvedValue({ open: false, viewportParked: false });
    await act(async () => { window.dispatchEvent(new Event("focus")); });

    await waitFor(() => expect(canvasBrowserApi.openCanvasBrowser).toHaveBeenCalledTimes(2));
    expect(canvasBrowserApi.openCanvasBrowser).toHaveBeenLastCalledWith(
      "node-1",
      "http://localhost:3000/",
      expect.anything(),
      undefined,
    );
  });

  it("does not re-open on focus when the native WebView is still alive", async () => {
    const { result } = renderHook(() =>
      useCanvasBrowserNode({ nodeId: "node-1", initialUrl: "http://localhost:3000", initialState: "disconnected" }),
    );
    await act(async () => { await result.current.openBrowser(); });
    expect(canvasBrowserApi.openCanvasBrowser).toHaveBeenCalledTimes(1);

    vi.mocked(canvasBrowserApi.getCanvasBrowserStatus).mockResolvedValue({ open: true, viewportParked: false });
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(canvasBrowserApi.openCanvasBrowser).toHaveBeenCalledTimes(1);
  });

  it("re-pushes live bounds shortly after open once the enter-animation settles", async () => {
    // Opening mid enter-animation (scaleY 0.58 → 1) measures a clipped container and
    // parks the WebView; CSS transforms fire no ResizeObserver, so nothing re-measures
    // when the animation ends. A one-shot settle re-push past the animation heals it
    // in well under the periodic-reconcile window (no multi-second black flash).
    vi.useFakeTimers();
    try {
      mockBoundingRect(100, 200, 12, 12); // clipped mid-animation → parks
      const { result } = renderHook(() =>
        useCanvasBrowserNode({ nodeId: "node-1", initialUrl: "http://localhost:3000", initialState: "disconnected" }),
      );
      attachContainer(result.current.containerRef);
      await act(async () => { await result.current.openBrowser(); });
      // Let the active-effect's single scheduled sync fire while still parked.
      await act(async () => { await vi.advanceTimersByTimeAsync(60); });
      vi.mocked(canvasBrowserApi.syncCanvasBrowserBounds).mockClear();

      // Animation ends: real bounds now. Only the settle re-push can re-measure —
      // there is no further scheduled sync and the dedupe cache still holds parked.
      mockBoundingRect(100, 200, 640, 480);
      await act(async () => { await vi.advanceTimersByTimeAsync(400); });

      expect(canvasBrowserApi.syncCanvasBrowserBounds).toHaveBeenCalledWith(
        "node-1",
        expect.objectContaining({ x: 108, y: 208, width: 624, height: 464 }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("actively self-heals a parked pane on its own, without any focus/visibility change", async () => {
    // The real black-pane scenario: the user stares at an already-focused window,
    // so the focus/visibilitychange listeners never fire. A periodic reconcile must
    // still detect the parked WebView and re-push bounds — no user interaction.
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() =>
        useCanvasBrowserNode({ nodeId: "node-1", initialUrl: "http://localhost:3000", initialState: "disconnected" }),
      );
      attachContainer(result.current.containerRef);
      await act(async () => { await result.current.openBrowser(); });

      vi.mocked(canvasBrowserApi.getCanvasBrowserStatus).mockResolvedValue({ open: true, viewportParked: true });
      vi.mocked(canvasBrowserApi.syncCanvasBrowserBounds).mockClear();

      // No focus event, no visibility change — only wall-clock time passes.
      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });

      expect(canvasBrowserApi.getCanvasBrowserStatus).toHaveBeenCalledWith("node-1");
      expect(canvasBrowserApi.syncCanvasBrowserBounds).toHaveBeenCalledWith(
        "node-1",
        expect.objectContaining({ x: 108, y: 208, width: 624, height: 464 }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("self-heals a black pane by re-pushing bounds when a focus regain finds the WebView open but parked", async () => {
    // The recurrence class: the native WebView exists (so it is never re-opened)
    // but sits parked off-screen behind a live green dot. The repair is to force
    // a fresh bounds push — NOT a re-open, which would reload the live page.
    const { result } = renderHook(() =>
      useCanvasBrowserNode({ nodeId: "node-1", initialUrl: "http://localhost:3000", initialState: "disconnected" }),
    );
    attachContainer(result.current.containerRef);
    await act(async () => { await result.current.openBrowser(); });
    expect(canvasBrowserApi.openCanvasBrowser).toHaveBeenCalledTimes(1);
    vi.mocked(canvasBrowserApi.syncCanvasBrowserBounds).mockClear();

    vi.mocked(canvasBrowserApi.getCanvasBrowserStatus).mockResolvedValue({ open: true, viewportParked: true });
    await act(async () => { window.dispatchEvent(new Event("focus")); });

    await waitFor(() => expect(canvasBrowserApi.syncCanvasBrowserBounds).toHaveBeenCalledWith(
      "node-1",
      expect.objectContaining({ x: 108, y: 208, width: 624, height: 464 }),
    ));
    // Re-push, never a second open.
    expect(canvasBrowserApi.openCanvasBrowser).toHaveBeenCalledTimes(1);
  });

  it("does not probe for recovery while the node is suspended", async () => {
    // A suspended WebView is parked off-screen on purpose; its absence is
    // expected and re-opening would fight the park logic.
    const { result } = renderHook(() =>
      useCanvasBrowserNode({
        nodeId: "node-1",
        initialUrl: "http://localhost:3000",
        initialState: "disconnected",
        suspendNativeView: true,
      }),
    );
    await act(async () => { await result.current.openBrowser(); });
    vi.mocked(canvasBrowserApi.getCanvasBrowserStatus).mockClear();

    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(canvasBrowserApi.getCanvasBrowserStatus).not.toHaveBeenCalled();
  });

  it("reloadBrowser calls Tauri IPC", async () => {
    const { result } = renderHook(() =>
      useCanvasBrowserNode({ nodeId: "node-1", initialUrl: "http://localhost:3000", initialState: "active" }),
    );
    await act(async () => { await result.current.reloadBrowser(); });
    expect(canvasBrowserApi.reloadCanvasBrowser).toHaveBeenCalledWith("node-1");
  });

  it("backBrowser and forwardBrowser step history through Tauri IPC", async () => {
    const { result } = renderHook(() =>
      useCanvasBrowserNode({ nodeId: "node-1", initialUrl: "http://localhost:3000", initialState: "active" }),
    );
    await act(async () => { await result.current.backBrowser(); });
    await act(async () => { await result.current.forwardBrowser(); });
    expect(canvasBrowserApi.historyCanvasBrowser).toHaveBeenNthCalledWith(1, "node-1", -1);
    expect(canvasBrowserApi.historyCanvasBrowser).toHaveBeenNthCalledWith(2, "node-1", 1);
  });

  it("syncBounds calls Tauri IPC with current container bounds", async () => {
    const { result } = renderHook(() =>
      useCanvasBrowserNode({ nodeId: "node-1", initialUrl: "http://localhost:3000", initialState: "active" }),
    );
    attachContainer(result.current.containerRef);
    act(() => { result.current.syncBounds(); });
    expect(canvasBrowserApi.syncCanvasBrowserBounds).toHaveBeenCalledWith(
      "node-1",
      expect.objectContaining({ x: 108, y: 208, width: 624, height: 464 }),
    );
  });

  it("syncBounds resends unchanged geometry when zoom changes", async () => {
    const { result, rerender } = renderHook(
      ({ zoomFactor }: { zoomFactor: number }) =>
        useCanvasBrowserNode({
          nodeId: "node-1",
          initialUrl: "http://localhost:3000",
          initialState: "active",
          zoomFactor,
        }),
      { initialProps: { zoomFactor: 0.5 } },
    );
    attachContainer(result.current.containerRef);

    act(() => { result.current.syncBounds(); });
    expect(canvasBrowserApi.syncCanvasBrowserBounds).toHaveBeenLastCalledWith(
      "node-1",
      expect.objectContaining({ width: 624, height: 464, zoomFactor: 0.5 }),
    );

    rerender({ zoomFactor: 0.6 });
    act(() => { result.current.syncBounds(); });
    expect(canvasBrowserApi.syncCanvasBrowserBounds).toHaveBeenLastCalledWith(
      "node-1",
      expect.objectContaining({ width: 624, height: 464, zoomFactor: 0.6 }),
    );
  });

  it("parks the native WebView offscreen when the DOM viewport is unavailable", async () => {
    const { result } = renderHook(() =>
      useCanvasBrowserNode({ nodeId: "node-1", initialUrl: "http://localhost:3000", initialState: "active" }),
    );
    act(() => { result.current.syncBounds(); });
    expect(canvasBrowserApi.syncCanvasBrowserBounds).toHaveBeenCalledWith(
      "node-1",
      { x: -10000, y: -10000, width: 1, height: 1, zoomFactor: 1 },
    );
  });

  it("parks the native WebView when the safe resize gutter leaves no usable area", async () => {
    mockBoundingRect(100, 200, 12, 12);
    const { result } = renderHook(() =>
      useCanvasBrowserNode({ nodeId: "node-1", initialUrl: "http://localhost:3000", initialState: "active" }),
    );
    attachContainer(result.current.containerRef);
    act(() => { result.current.syncBounds(); });
    expect(canvasBrowserApi.syncCanvasBrowserBounds).toHaveBeenCalledWith(
      "node-1",
      { x: -10000, y: -10000, width: 1, height: 1, zoomFactor: 1 },
    );
  });

  it("deduplicates subpixel bounds churn during canvas zoom", async () => {
    const { result } = renderHook(() =>
      useCanvasBrowserNode({ nodeId: "node-1", initialUrl: "http://localhost:3000", initialState: "active" }),
    );
    attachContainer(result.current.containerRef);
    act(() => { result.current.syncBounds(); });
    mockBoundingRect(100.1, 200.1, 640.1, 480.1);
    act(() => { result.current.syncBounds(); });
    expect(canvasBrowserApi.syncCanvasBrowserBounds).toHaveBeenCalledTimes(1);
  });

  it("syncs bounds when the ReactFlow node transform changes during drag", async () => {
    const { getByTestId } = render(createElement(BrowserHookProbe));
    await waitFor(() => expect(canvasBrowserApi.syncCanvasBrowserBounds).toHaveBeenCalled());
    vi.mocked(canvasBrowserApi.syncCanvasBrowserBounds).mockClear();

    mockBoundingRect(180, 240, 640, 480);
    act(() => {
      getByTestId("flow-node").setAttribute("style", "transform: translate(180px, 240px);");
    });

    await waitFor(() => expect(canvasBrowserApi.syncCanvasBrowserBounds).toHaveBeenCalledWith(
      "node-1",
      expect.objectContaining({ x: 188, y: 248, width: 624, height: 464 }),
    ));
  });

  it("parks the native WebView while suspended and restores visible bounds afterwards", async () => {
    const { result, rerender } = renderHook(
      ({ suspendNativeView }: { suspendNativeView: boolean }) => useCanvasBrowserNode({
        nodeId: "node-1",
        initialUrl: "http://localhost:3000",
        initialState: "active",
        suspendNativeView,
      }),
      { initialProps: { suspendNativeView: true } },
    );
    attachContainer(result.current.containerRef);

    act(() => { result.current.syncBounds(); });
    expect(result.current.nativeViewSuspended).toBe(true);
    expect(canvasBrowserApi.syncCanvasBrowserBounds).toHaveBeenCalledWith(
      "node-1",
      { x: -10000, y: -10000, width: 1, height: 1, zoomFactor: 1 },
    );

    rerender({ suspendNativeView: false });
    act(() => { result.current.syncBounds(); });
    expect(result.current.nativeViewSuspended).toBe(false);
    expect(canvasBrowserApi.syncCanvasBrowserBounds).toHaveBeenLastCalledWith(
      "node-1",
      expect.objectContaining({ x: 108, y: 208, width: 624, height: 464 }),
    );
  });

  it("retries unchanged bounds after a failed sync", async () => {
    vi.mocked(canvasBrowserApi.syncCanvasBrowserBounds).mockRejectedValueOnce(new Error("ipc unavailable"));
    const { result } = renderHook(() =>
      useCanvasBrowserNode({ nodeId: "node-1", initialUrl: "http://localhost:3000", initialState: "active" }),
    );
    attachContainer(result.current.containerRef);

    act(() => { result.current.syncBounds(); });
    await waitFor(() => expect(canvasBrowserApi.syncCanvasBrowserBounds).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    await Promise.resolve();

    act(() => { result.current.syncBounds(); });
    expect(canvasBrowserApi.syncCanvasBrowserBounds).toHaveBeenCalledTimes(2);
  });

  it("openBrowser with url override updates currentUrl", async () => {
    vi.mocked(canvasBrowserApi.openCanvasBrowser).mockResolvedValueOnce({
      ok: true,
      nodeId: "node-2",
      url: "http://new.com/",
      reused: false,
    });
    const { result } = renderHook(() =>
      useCanvasBrowserNode({ nodeId: "node-2", initialUrl: "http://old.com", initialState: "disconnected" }),
    );
    await act(async () => { await result.current.openBrowser("http://new.com"); });
    expect(canvasBrowserApi.openCanvasBrowser).toHaveBeenCalledWith(
      "node-2",
      "http://new.com",
      expect.objectContaining({ width: 640, height: 480 }),
      undefined,
    );
    expect(result.current.currentUrl).toBe("http://new.com/");
  });

  it("forwards the active project root as the confinement root when opening a local file", async () => {
    setActiveProjectRootDir("/Users/alwi/proj");
    const { result } = renderHook(() =>
      useCanvasBrowserNode({ nodeId: "node-1", initialUrl: "about:blank", initialState: "disconnected" }),
    );
    await act(async () => {
      await result.current.openBrowser("file:///Users/alwi/proj/index.html");
    });
    expect(canvasBrowserApi.openCanvasBrowser).toHaveBeenCalledWith(
      "node-1",
      "file:///Users/alwi/proj/index.html",
      expect.anything(),
      "/Users/alwi/proj",
    );
  });
});
