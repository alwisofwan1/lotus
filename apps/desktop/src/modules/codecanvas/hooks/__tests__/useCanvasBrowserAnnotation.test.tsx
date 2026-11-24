import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCanvasBrowserAnnotation } from "../useCanvasBrowserAnnotation";

type EventCallback = (event: { payload: { terminalId: string; payload: string } }) => void;

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

vi.mock("@/lib/tauri/canvas-browser", () => ({
  startCanvasBrowserAnnotationMode: vi.fn().mockResolvedValue(undefined),
  stopCanvasBrowserAnnotationMode: vi.fn().mockResolvedValue(undefined),
  logCanvasBrowserAnnotationTrace: vi.fn().mockResolvedValue(undefined),
}));

async function flushAsync() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function emitAnnotation(terminalId: string, payload: string) {
  const callbacks = [...(tauriMocks.listeners.get("canvas://browser-annotation") ?? [])];
  await act(async () => {
    callbacks.forEach((callback) => callback({ payload: { terminalId, payload } }));
  });
}

describe("useCanvasBrowserAnnotation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tauriMocks.listeners.clear();
    tauriMocks.isTauri.mockReturnValue(true);
  });

  it("captures native annotation events for the matching browser and calls the delivery callback", async () => {
    const onAnnotationCaptured = vi.fn();
    const { result } = renderHook(() => useCanvasBrowserAnnotation({
      nativeBrowserId: "term-1",
      onAnnotationCaptured,
    }));

    await flushAsync();
    await emitAnnotation("other-term", "ignored");
    await emitAnnotation("term-1", "{\"action\":\"selected\"}");

    await waitFor(() => expect(onAnnotationCaptured).toHaveBeenCalledOnce());
    expect(onAnnotationCaptured).toHaveBeenCalledWith({
      terminalId: "term-1",
      payload: "{\"action\":\"selected\"}",
      capturedAt: expect.any(Number),
      source: "navigation",
      delivery: undefined,
    });
    expect(result.current.latestAnnotation).toMatchObject({ terminalId: "term-1" });
    expect(result.current.annotationActive).toBe(false);
  });

  // Verify-first instrumentation (Slice 0): the terminalId filter at the top of
  // the event listener silently drops events meant for a different Browser Node
  // with zero diagnostics — the exact blind spot that hides why an agent never
  // saw an annotation someone else's node captured. This traces both outcomes.
  it("traces a dropped event when the incoming terminalId does not match this hook's nativeBrowserId", async () => {
    const log = vi.fn();
    renderHook(() => useCanvasBrowserAnnotation({ nativeBrowserId: "term-1", log }));

    await flushAsync();
    await emitAnnotation("other-term", '{"action":"selected","id":"annotation-1"}');

    expect(log).toHaveBeenCalledWith(
      "[canvas][annotation-trace] path=frontend-hook terminal=other-term id=annotation-1 detail=dropped:terminal-mismatch(node=term-1)",
    );
  });

  it("traces an accepted event when the incoming terminalId matches this hook's nativeBrowserId", async () => {
    const log = vi.fn();
    renderHook(() => useCanvasBrowserAnnotation({ nativeBrowserId: "term-1", log }));

    await flushAsync();
    await emitAnnotation("term-1", '{"action":"selected","id":"annotation-1"}');

    expect(log).toHaveBeenCalledWith(
      "[canvas][annotation-trace] path=frontend-hook terminal=term-1 id=annotation-1 detail=accepted",
    );
  });
});
