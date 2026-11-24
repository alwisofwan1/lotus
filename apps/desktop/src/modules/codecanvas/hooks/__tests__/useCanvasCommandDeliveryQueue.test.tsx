import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CANVAS_COMMAND_DELIVERY_DURATION_MS, useCanvasCommandDeliveryQueue } from "../useCanvasCommandDeliveryQueue";
import type { CanvasCommandDeliveryEvent } from "../../services/canvas-command-delivery";

const event: CanvasCommandDeliveryEvent = {
  id: "delivery-1",
  source: "nl-command",
  targetNodeId: "agent-1",
  outcome: "delivered",
  commandPreview: "fix lint errors",
  createdAt: 1,
};

afterEach(() => {
  vi.useRealTimers();
});

describe("useCanvasCommandDeliveryQueue", () => {
  it("keeps production delivery cues readable long enough for the static fallback", () => {
    expect(CANVAS_COMMAND_DELIVERY_DURATION_MS).toBeGreaterThanOrEqual(1200);
  });

  it("removes a delivery as soon as the overlay reports animation completion", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useCanvasCommandDeliveryQueue({ durationMs: 5_000 }));

    act(() => result.current.enqueue(event));
    expect(result.current.deliveries).toEqual([event]);

    act(() => result.current.complete(event.id));
    expect(result.current.deliveries).toEqual([]);
  });

  it("keeps delivery cues transient", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useCanvasCommandDeliveryQueue({ durationMs: 900 }));

    act(() => result.current.enqueue(event));
    expect(result.current.deliveries).toEqual([event]);

    act(() => vi.advanceTimersByTime(899));
    expect(result.current.deliveries).toEqual([event]);

    act(() => vi.advanceTimersByTime(1));
    expect(result.current.deliveries).toEqual([]);
  });
});
