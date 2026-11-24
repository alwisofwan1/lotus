import { describe, it, expect, vi } from "vitest";
import { createCellBus } from "../cell-event-bus";

describe("cell-event-bus", () => {
  it("delivers emitted events to subscribers", () => {
    const bus = createCellBus();
    const listener = vi.fn();
    bus.on("terminal:spawned", listener);

    bus.emit("terminal:spawned", { paneId: "p1", workspaceId: "w1", cwd: "/tmp" });

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({ paneId: "p1", workspaceId: "w1", cwd: "/tmp" });
  });

  it("only delivers to listeners of matching event name", () => {
    const bus = createCellBus();
    const spawned = vi.fn();
    const exited = vi.fn();
    bus.on("terminal:spawned", spawned);
    bus.on("terminal:exited", exited);

    bus.emit("terminal:spawned", { paneId: "p1", workspaceId: "w1", cwd: "/tmp" });

    expect(spawned).toHaveBeenCalledOnce();
    expect(exited).not.toHaveBeenCalled();
  });

  it("off() unsubscribes a specific listener", () => {
    const bus = createCellBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.on("terminal:status", a);
    bus.on("terminal:status", b);

    bus.off("terminal:status", a);
    bus.emit("terminal:status", { paneId: "p1", status: "live" });

    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledOnce();
  });

  it("on() returns an unsubscribe function", () => {
    const bus = createCellBus();
    const listener = vi.fn();
    const unsub = bus.on("terminal:output", listener);

    unsub();
    bus.emit("terminal:output", { paneId: "p1", workspaceId: "w1", data: "hi" });

    expect(listener).not.toHaveBeenCalled();
  });

  it("clear() removes all listeners", () => {
    const bus = createCellBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.on("terminal:spawned", a);
    bus.on("terminal:exited", b);

    bus.clear();
    bus.emit("terminal:spawned", { paneId: "p", workspaceId: "w", cwd: "/" });
    bus.emit("terminal:exited", { paneId: "p", workspaceId: "w" });

    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });

  it("listenerCount reports subscriber count", () => {
    const bus = createCellBus();
    expect(bus.listenerCount("terminal:spawned")).toBe(0);

    const unsub1 = bus.on("terminal:spawned", () => {});
    const unsub2 = bus.on("terminal:spawned", () => {});
    expect(bus.listenerCount("terminal:spawned")).toBe(2);

    unsub1();
    expect(bus.listenerCount("terminal:spawned")).toBe(1);
    unsub2();
    expect(bus.listenerCount("terminal:spawned")).toBe(0);
  });

  it("does not break when emitting an event with no subscribers", () => {
    const bus = createCellBus();
    expect(() => {
      bus.emit("terminal:output", { paneId: "p", workspaceId: "w", data: "x" });
    }).not.toThrow();
  });

  it("listener errors are isolated — other listeners still run", () => {
    const bus = createCellBus();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const bad = vi.fn(() => {
      throw new Error("boom");
    });
    const good = vi.fn();
    bus.on("terminal:status", bad);
    bus.on("terminal:status", good);

    bus.emit("terminal:status", { paneId: "p", status: "live" });

    expect(bad).toHaveBeenCalled();
    expect(good).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
