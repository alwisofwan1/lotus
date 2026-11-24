import { describe, it, expect, vi } from "vitest";
import { NotificationBus } from "../bus.js";
import type { NotificationEvent } from "../../../types/index.js";

const agentStop: NotificationEvent = {
  kind: "agent_stop",
  event: "stop",
  title: "Agent finished",
  body: "Exit 0",
  agent_type: "claude",
  status: "success",
  cwd: "/srv/api",
  timestamp: Date.now(),
};

describe("NotificationBus", () => {
  it("published event reaches a subscriber", () => {
    const bus = new NotificationBus();
    const handler = vi.fn();
    bus.subscribe(handler);
    bus.publish(agentStop);
    expect(handler).toHaveBeenCalledWith(agentStop);
  });

  it("reaches all subscribers when multiple are registered", () => {
    const bus = new NotificationBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe(a);
    bus.subscribe(b);
    bus.publish(agentStop);
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  it("unsubscribe() stops delivery to that handler", () => {
    const bus = new NotificationBus();
    const handler = vi.fn();
    const unsub = bus.subscribe(handler);
    unsub();
    bus.publish(agentStop);
    expect(handler).not.toHaveBeenCalled();
  });

  it("unsubscribing one handler does not affect others", () => {
    const bus = new NotificationBus();
    const keep = vi.fn();
    const remove = vi.fn();
    const unsub = bus.subscribe(remove);
    bus.subscribe(keep);
    unsub();
    bus.publish(agentStop);
    expect(keep).toHaveBeenCalledOnce();
    expect(remove).not.toHaveBeenCalled();
  });

  it("stop() removes all subscribers", () => {
    const bus = new NotificationBus();
    const handler = vi.fn();
    bus.subscribe(handler);
    bus.stop();
    bus.publish(agentStop);
    expect(handler).not.toHaveBeenCalled();
  });

  it("size reflects the current subscriber count", () => {
    const bus = new NotificationBus();
    expect(bus.size).toBe(0);
    const unsub = bus.subscribe(vi.fn());
    expect(bus.size).toBe(1);
    bus.subscribe(vi.fn());
    expect(bus.size).toBe(2);
    unsub();
    expect(bus.size).toBe(1);
  });

  it("calling unsubscribe twice is idempotent", () => {
    const bus = new NotificationBus();
    bus.subscribe(vi.fn());
    const unsub = bus.subscribe(vi.fn());
    unsub();
    unsub();
    expect(bus.size).toBe(1);
  });
});
