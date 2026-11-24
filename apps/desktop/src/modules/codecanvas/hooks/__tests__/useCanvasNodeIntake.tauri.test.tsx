import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCanvasNodeIntake } from "../useCanvasNodeIntake";

const webviewMock = vi.hoisted(() => ({
  onDragDropEvent: vi.fn(),
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => webviewMock,
}));

// The hooks register through listenWebviewDragDrop; these tests drive the webview's own drag-drop
// mock, so the helper is routed to it. The helper is tested in tauri-listener-cleanup.test.ts.
vi.mock("@/lib/tauri-listener-cleanup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri-listener-cleanup")>()),
  listenWebviewDragDrop: (webview: { onDragDropEvent: (handler: unknown) => unknown }, handler: unknown) => webview.onDragDropEvent(handler),
}));

function effects() {
  return {
    appendNoteText: vi.fn(),
    appendNoteImages: vi.fn(async (_nodeId: string, images: unknown[]) => images.length),
    writePty: vi.fn(),
    applySkill: vi.fn(),
    addAttachment: vi.fn(),
  };
}

type NativeDropHandler = (event: { payload: { type: string; position?: { x: number; y: number }; paths?: string[] } }) => Promise<void> | void;

describe("useCanvasNodeIntake Tauri file-drop hit testing", () => {
  beforeEach(() => {
    webviewMock.onDragDropEvent.mockReset();
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
    Object.defineProperty(window, "devicePixelRatio", { value: 2, configurable: true });
  });

  afterEach(() => {
    delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    vi.restoreAllMocks();
  });

  it("tries the native drop position before the DPR-scaled fallback so the intended agent wins", async () => {
    let dragDropHandler: NativeDropHandler | null = null;
    webviewMock.onDragDropEvent.mockImplementation((handler: NativeDropHandler) => {
      dragDropHandler = handler;
      return Promise.resolve(vi.fn());
    });
    const fx = effects();
    const getNodeAtPoint = vi.fn((point: { clientX: number; clientY: number }) => {
      if (point.clientX === 200 && point.clientY === 100) return { id: "agent-raw", kind: "agent" as const };
      if (point.clientX === 100 && point.clientY === 50) return { id: "agent-scaled", kind: "agent" as const };
      return null;
    });

    renderHook(() => useCanvasNodeIntake({
      getSelectedNode: () => null,
      getHoveredNode: () => ({ id: "agent-stale", kind: "agent" }),
      getNodeAtPoint,
      effects: fx,
    }));

    await waitFor(() => expect(dragDropHandler).toBeTruthy());
    await act(async () => {
      await dragDropHandler?.({ payload: { type: "drop", position: { x: 200, y: 100 }, paths: ["/tmp/shot.png"] } });
    });

    await waitFor(() => expect(fx.addAttachment).toHaveBeenCalledWith("agent-raw", [{ kind: "path", path: "/tmp/shot.png" }]));
    expect(fx.addAttachment).not.toHaveBeenCalledWith("agent-scaled", expect.anything());
    expect(fx.addAttachment).not.toHaveBeenCalledWith("agent-stale", expect.anything());
  });

  it("uses the DPR-scaled fallback when the native position is reported in physical pixels", async () => {
    let dragDropHandler: NativeDropHandler | null = null;
    webviewMock.onDragDropEvent.mockImplementation((handler: NativeDropHandler) => {
      dragDropHandler = handler;
      return Promise.resolve(vi.fn());
    });
    const fx = effects();

    renderHook(() => useCanvasNodeIntake({
      getSelectedNode: () => null,
      getNodeAtPoint: (point) => point.clientX === 100 && point.clientY === 50 ? { id: "agent-scaled", kind: "agent" } : null,
      effects: fx,
    }));

    await waitFor(() => expect(dragDropHandler).toBeTruthy());
    await act(async () => {
      await dragDropHandler?.({ payload: { type: "drop", position: { x: 200, y: 100 }, paths: ["/tmp/retina.png"] } });
    });

    await waitFor(() => expect(fx.addAttachment).toHaveBeenCalledWith("agent-scaled", [{ kind: "path", path: "/tmp/retina.png" }]));
  });

  it("absorbs async Tauri unregister races after unmount", async () => {
    let resolveListener: ((unlisten: () => void) => void) | undefined;
    const unregister = vi.fn(() => {
      throw new TypeError("undefined is not an object (evaluating 'listeners[eventId].handlerId')");
    });
    webviewMock.onDragDropEvent.mockReturnValue(new Promise((resolve) => {
      resolveListener = resolve;
    }));

    const { unmount } = renderHook(() => useCanvasNodeIntake({
      getSelectedNode: () => null,
      effects: effects(),
    }));

    unmount();

    await act(async () => {
      resolveListener?.(unregister);
      await Promise.resolve();
    });

    expect(unregister).toHaveBeenCalledOnce();
  });
});
