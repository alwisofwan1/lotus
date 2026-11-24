import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listeners = new Map<string, (event: { payload: unknown }) => void>();

vi.mock("@/lib/tauri/runtime", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, cb: (event: { payload: unknown }) => void) => {
    listeners.set(name, cb);
    return Promise.resolve(vi.fn());
  }),
}));

import {
  CANVAS_BROWSER_TITLE_CHANGED_EVENT,
  useCanvasBrowserTitleChanged,
} from "../useCanvasBrowserTitleChanged";

async function waitForListener() {
  for (let i = 0; i < 20 && !listeners.has(CANVAS_BROWSER_TITLE_CHANGED_EVENT); i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

beforeEach(() => {
  listeners.clear();
  vi.clearAllMocks();
});

describe("useCanvasBrowserTitleChanged", () => {
  it("reports a title-changed event addressed to this browser", async () => {
    const onTitleChanged = vi.fn();
    renderHook(() =>
      useCanvasBrowserTitleChanged({
        nativeBrowserId: "term-1",
        onTitleChanged,
      }),
    );
    await waitForListener();

    listeners.get(CANVAS_BROWSER_TITLE_CHANGED_EVENT)?.({
      payload: { terminalId: "term-1", title: "Ghibli Grove" },
    });

    expect(onTitleChanged).toHaveBeenCalledWith("Ghibli Grove");
  });

  it("ignores title events for other browsers or without a usable title", async () => {
    const onTitleChanged = vi.fn();
    renderHook(() =>
      useCanvasBrowserTitleChanged({
        nativeBrowserId: "term-1",
        onTitleChanged,
      }),
    );
    await waitForListener();

    const listener = listeners.get(CANVAS_BROWSER_TITLE_CHANGED_EVENT);
    listener?.({ payload: { terminalId: "term-2", title: "Other page" } });
    listener?.({ payload: { terminalId: "term-1", title: "   " } });
    listener?.({ payload: { terminalId: "term-1" } });

    expect(onTitleChanged).not.toHaveBeenCalled();
  });
});
