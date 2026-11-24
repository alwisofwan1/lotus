import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCanvasBrowserNavigationBlocked } from "../useCanvasBrowserNavigationBlocked";

type EventCallback = (event: { payload: { terminalId?: string; url?: string } }) => void;

const tauriMocks = vi.hoisted(() => {
  const listeners = new Map<string, EventCallback[]>();
  return {
    listeners,
    isTauri: vi.fn(() => true),
    listen: vi.fn((event: string, cb: EventCallback) => {
      const entries = listeners.get(event) ?? [];
      listeners.set(event, [...entries, cb]);
      return Promise.resolve(() => {
        listeners.set(event, (listeners.get(event) ?? []).filter((entry) => entry !== cb));
      });
    }),
  };
});

vi.mock("@/lib/tauri/runtime", () => ({
  isTauri: tauriMocks.isTauri,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: tauriMocks.listen,
}));

async function flushAsync() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function emitBlocked(payload: { terminalId?: string; url?: string }) {
  for (const cb of tauriMocks.listeners.get("canvas://browser-navigation-blocked") ?? []) {
    cb({ payload });
  }
}

beforeEach(() => {
  tauriMocks.listeners.clear();
  vi.clearAllMocks();
  tauriMocks.isTauri.mockReturnValue(true);
});

describe("useCanvasBrowserNavigationBlocked", () => {
  it("reports blocked navigations for its own browser only", async () => {
    const onBlocked = vi.fn();
    renderHook(() =>
      useCanvasBrowserNavigationBlocked({ nativeBrowserId: "term-1", onBlocked }),
    );
    await flushAsync();

    act(() => {
      emitBlocked({ terminalId: "term-other", url: "https://evil.example/" });
      emitBlocked({ terminalId: "term-1", url: "https://blocked.example/path" });
    });

    expect(onBlocked).toHaveBeenCalledTimes(1);
    expect(onBlocked).toHaveBeenCalledWith("https://blocked.example/path");
  });

  it("ignores malformed payloads without a URL", async () => {
    const onBlocked = vi.fn();
    renderHook(() =>
      useCanvasBrowserNavigationBlocked({ nativeBrowserId: "term-1", onBlocked }),
    );
    await flushAsync();

    act(() => {
      emitBlocked({ terminalId: "term-1" });
    });

    expect(onBlocked).not.toHaveBeenCalled();
  });

  it("keeps a single subscription while the browser identity changes", async () => {
    const onBlocked = vi.fn();
    const { rerender } = renderHook(
      ({ id }: { id: string }) =>
        useCanvasBrowserNavigationBlocked({ nativeBrowserId: id, onBlocked }),
      { initialProps: { id: "term-1" } },
    );
    await flushAsync();

    rerender({ id: "term-2" });
    act(() => {
      emitBlocked({ terminalId: "term-2", url: "https://blocked.example/" });
    });

    expect(tauriMocks.listen).toHaveBeenCalledTimes(1);
    expect(onBlocked).toHaveBeenCalledWith("https://blocked.example/");
  });

  it("unsubscribes on unmount", async () => {
    const onBlocked = vi.fn();
    const { unmount } = renderHook(() =>
      useCanvasBrowserNavigationBlocked({ nativeBrowserId: "term-1", onBlocked }),
    );
    await flushAsync();

    unmount();
    await flushAsync();
    act(() => {
      emitBlocked({ terminalId: "term-1", url: "https://blocked.example/" });
    });

    expect(onBlocked).not.toHaveBeenCalled();
  });
});
