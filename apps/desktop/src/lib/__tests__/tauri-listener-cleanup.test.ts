import { describe, expect, it, vi } from "vitest";
import { listenWebviewDragDrop, safeTauriUnlisten } from "@/lib/tauri-listener-cleanup";

describe("safeTauriUnlisten", () => {
  it("absorbs Tauri user-script unregister throws", () => {
    const unlisten = vi.fn(() => {
      throw new TypeError("undefined is not an object (evaluating 'listeners[eventId].handlerId')");
    });

    expect(() => safeTauriUnlisten(unlisten)).not.toThrow();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("absorbs async Tauri unregister rejections", async () => {
    const unlisten = vi.fn(() => Promise.reject(new TypeError("undefined is not an object (evaluating 'listeners[eventId].handlerId')")));

    safeTauriUnlisten(unlisten);
    await Promise.resolve();

    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("calls each unlisten function at most once", () => {
    const unlisten = vi.fn();

    safeTauriUnlisten(unlisten);
    safeTauriUnlisten(unlisten);

    expect(unlisten).toHaveBeenCalledOnce();
  });
});

describe("listenWebviewDragDrop", () => {
  const STALE = () => Promise.reject(new TypeError("undefined is not an object (evaluating 'listeners[eventId].handlerId')"));

  // One handle per listen, as Tauri hands out: each closes over its own event id.
  function fakeWebview(onUnlisten: () => Promise<void> = async () => {}) {
    const handlers = new Map<string, (event: { event: string; id: number; payload: unknown }) => void>();
    const listen = vi.fn(async (event: string, handler: (event: { event: string; id: number; payload: unknown }) => void) => {
      handlers.set(event, handler);
      return () => onUnlisten();
    });
    return { webview: { listen } as never, listen, handlers };
  }

  it("listens to the four drag-drop events and maps their payloads like Tauri", async () => {
    const { webview, listen, handlers } = fakeWebview();
    const seen: unknown[] = [];
    await listenWebviewDragDrop(webview, (event) => { seen.push(event.payload); });

    expect(listen.mock.calls.map((call) => call[0])).toEqual([
      "tauri://drag-enter", "tauri://drag-over", "tauri://drag-drop", "tauri://drag-leave",
    ]);
    handlers.get("tauri://drag-drop")!({ event: "tauri://drag-drop", id: 1, payload: { paths: ["/a.png"], position: { x: 4, y: 8 } } });
    handlers.get("tauri://drag-leave")!({ event: "tauri://drag-leave", id: 2, payload: null });

    expect(seen[0]).toMatchObject({ type: "drop", paths: ["/a.png"], position: { x: 4, y: 8 } });
    expect(seen[1]).toEqual({ type: "leave" });
  });

  it("handles the stale-listener rejection Tauri's own onDragDropEvent leaves unhandled", async () => {
    // Tauri's async unlisten rejects; what matters is that SOMEONE attaches a handler to each
    // rejection. Spying on `.then` sees that directly, without relying on the test environment
    // reporting unhandled rejections (jsdom here does not).
    const rejections: Array<{ handled: boolean }> = [];
    const { webview } = fakeWebview(() => {
      const promise = STALE();
      const record = { handled: false };
      const then = promise.then.bind(promise);
      promise.then = ((onFulfilled, onRejected) => {
        if (onRejected) record.handled = true;
        return then(onFulfilled, onRejected);
      }) as typeof promise.then;
      rejections.push(record);
      return promise;
    });
    const release = await listenWebviewDragDrop(webview, () => {});

    expect(() => release()).not.toThrow();
    await Promise.resolve();

    expect(rejections).toHaveLength(4);
    expect(rejections.every((r) => r.handled)).toBe(true);
  });

  it("releases what it registered when a later listen fails", async () => {
    const unlisten = vi.fn(async () => {});
    const listen = vi.fn()
      .mockResolvedValueOnce(unlisten)
      .mockRejectedValueOnce(new Error("listen failed"));

    await expect(listenWebviewDragDrop({ listen } as never, () => {})).rejects.toThrow("listen failed");
    expect(unlisten).toHaveBeenCalledOnce();
  });
});
