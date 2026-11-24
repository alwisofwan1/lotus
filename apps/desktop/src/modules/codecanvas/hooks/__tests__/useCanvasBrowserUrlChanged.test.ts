import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listeners = new Map<string, (event: { payload: unknown }) => void>();
// A FRESH unlisten per listen(), matching production: `listen()` hands back a new closure every
// time. A single shared mock is not just imprecise — `safeTauriUnlisten` dedupes by function
// identity for the whole process, so a reused instance is silently skipped after its first call.
const issued = vi.hoisted(() => ({ unlistens: [] as Array<ReturnType<typeof vi.fn>> }));

vi.mock("@/lib/tauri/runtime", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, cb: (event: { payload: unknown }) => void) => {
    listeners.set(name, cb);
    const unlisten = vi.fn();
    issued.unlistens.push(unlisten);
    return Promise.resolve(unlisten);
  }),
}));

import {
  useCanvasBrowserUrlChanged,
  CANVAS_BROWSER_URL_CHANGED_EVENT,
} from "../useCanvasBrowserUrlChanged";

function emit(payload: unknown) {
  listeners.get(CANVAS_BROWSER_URL_CHANGED_EVENT)?.({ payload });
}

// The hook registers its listener across a dynamic import + two microtask hops.
async function waitForListener() {
  for (let i = 0; i < 20 && !listeners.has(CANVAS_BROWSER_URL_CHANGED_EVENT); i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

beforeEach(() => {
  listeners.clear();
  issued.unlistens.length = 0;
});
afterEach(() => vi.clearAllMocks());

describe("useCanvasBrowserUrlChanged", () => {
  it("reports a url-changed event addressed to this node", async () => {
    const onUrlChanged = vi.fn();
    renderHook(() => useCanvasBrowserUrlChanged({ nativeBrowserId: "term-1", onUrlChanged }));
    await waitForListener();

    emit({ terminalId: "term-1", url: "https://www.instagram.com/" });
    expect(onUrlChanged).toHaveBeenCalledWith("https://www.instagram.com/");
  });

  it("ignores events for a different node", async () => {
    const onUrlChanged = vi.fn();
    renderHook(() => useCanvasBrowserUrlChanged({ nativeBrowserId: "term-1", onUrlChanged }));
    await waitForListener();

    emit({ terminalId: "other-node", url: "https://evil.example/" });
    expect(onUrlChanged).not.toHaveBeenCalled();
  });

  it("ignores blank or missing urls", async () => {
    const onUrlChanged = vi.fn();
    renderHook(() => useCanvasBrowserUrlChanged({ nativeBrowserId: "term-1", onUrlChanged }));
    await waitForListener();

    emit({ terminalId: "term-1", url: "   " });
    emit({ terminalId: "term-1" });
    expect(onUrlChanged).not.toHaveBeenCalled();
  });

  it("unsubscribes on unmount", async () => {
    const { unmount } = renderHook(() =>
      useCanvasBrowserUrlChanged({ nativeBrowserId: "term-1", onUrlChanged: vi.fn() }),
    );
    await waitForListener();
    unmount();
    expect(issued.unlistens.at(-1)).toHaveBeenCalledTimes(1);
  });
});
