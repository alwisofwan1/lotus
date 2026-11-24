import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTerminalFileDrop } from "../useTerminalFileDrop";

const webviewMock = vi.hoisted(() => ({
  onDragDropEvent: vi.fn(),
}));

const fileDropMocks = vi.hoisted(() => ({
  inspectTerminalFileDropPaths: vi.fn(),
  writeTerminalSession: vi.fn(),
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

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ scaleFactor: vi.fn(() => Promise.resolve(1)) }),
}));

vi.mock("@/lib/tauri/terminal-file-drop", () => ({
  cancelTerminalFileDropUpload: vi.fn(),
  inspectTerminalFileDropPaths: fileDropMocks.inspectTerminalFileDropPaths,
  uploadTerminalFileDropSshBatch: vi.fn(),
}));

vi.mock("../services/terminal-session-registry", () => ({
  writeTerminalSession: fileDropMocks.writeTerminalSession,
}));

vi.mock("@/modules/codespace/services/terminal-session-registry", () => ({
  writeTerminalSession: fileDropMocks.writeTerminalSession,
}));

describe("useTerminalFileDrop", () => {
  beforeEach(() => {
    webviewMock.onDragDropEvent.mockReset();
    fileDropMocks.inspectTerminalFileDropPaths.mockReset();
    fileDropMocks.writeTerminalSession.mockReset();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {},
      configurable: true,
    });
  });

  afterEach(() => {
    delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    vi.restoreAllMocks();
  });

  it("does not surface Tauri unregister races after unmount-before-registration", async () => {
    let resolveListener: ((unlisten: () => void) => void) | undefined;
    const unregister = vi.fn(() => {
      throw new TypeError("undefined is not an object (evaluating 'listeners[eventId].handlerId')");
    });
    webviewMock.onDragDropEvent.mockReturnValue(new Promise((resolve) => {
      resolveListener = resolve;
    }));

    const { unmount } = renderHook(() => useTerminalFileDrop({
      active: true,
      cells: [],
      location: { kind: "local", cwd: "/repo" },
      onFocusCell: vi.fn(),
    }));

    unmount();

    await act(async () => {
      resolveListener?.(unregister);
      await Promise.resolve();
    });

    expect(unregister).toHaveBeenCalledOnce();
  });

  it("writes a local dropped file path once to the resolved terminal target", async () => {
    let dragDropHandler: ((event: { payload: { type: string; position: { x: number; y: number }; paths?: string[] } }) => Promise<void> | void) | null = null;
    webviewMock.onDragDropEvent.mockImplementation((handler) => {
      dragDropHandler = handler;
      return Promise.resolve(vi.fn());
    });
    fileDropMocks.inspectTerminalFileDropPaths.mockResolvedValue([
      { path: "/tmp/drop file.txt", isFile: true, isDirectory: false, size: 12 },
    ]);
    const onFocusCell = vi.fn();
    const target = document.createElement("div");
    target.dataset.terminalFileDropTarget = "true";
    target.dataset.terminalFileDropCellId = "pane-1";
    target.dataset.terminalFileDropCwd = "/repo";
    target.dataset.terminalFileDropStatus = "live";
    target.dataset.terminalFileDropLocation = "local";
    document.body.appendChild(target);
    Object.defineProperty(document, "elementFromPoint", {
      value: vi.fn(() => target),
      configurable: true,
    });

    try {
      renderHook(() => useTerminalFileDrop({
        active: true,
        cells: [{ id: "pane-1", type: "terminal", cwd: "/repo", runtimeStatus: "live" }],
        location: { kind: "local", cwd: "/repo" },
        onFocusCell,
      }));

      await waitFor(() => expect(dragDropHandler).toBeTruthy());
      await act(async () => {
        await dragDropHandler?.({ payload: { type: "drop", position: { x: 10, y: 20 }, paths: ["/tmp/drop file.txt"] } });
      });

      expect(onFocusCell).toHaveBeenCalledWith("pane-1");
      expect(fileDropMocks.writeTerminalSession).toHaveBeenCalledOnce();
      expect(fileDropMocks.writeTerminalSession).toHaveBeenCalledWith("pane-1", "/tmp/drop\\ file.txt ");
    } finally {
      target.remove();
    }
  });

  it("absorbs async Tauri unregister rejections after cleanup", async () => {
    let resolveListener: ((unlisten: () => Promise<void>) => void) | undefined;
    const unregister = vi.fn(() => Promise.reject(new TypeError("undefined is not an object (evaluating 'listeners[eventId].handlerId')")));
    webviewMock.onDragDropEvent.mockReturnValue(new Promise((resolve) => {
      resolveListener = resolve;
    }));

    const { unmount } = renderHook(() => useTerminalFileDrop({
      active: true,
      cells: [],
      location: { kind: "local", cwd: "/repo" },
      onFocusCell: vi.fn(),
    }));

    unmount();

    await act(async () => {
      resolveListener?.(unregister);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(unregister).toHaveBeenCalledOnce();
  });
});
