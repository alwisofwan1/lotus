import { describe, expect, it, vi } from "vitest";
import { createThreadActivityRegistry } from "@/modules/codespace/state/thread-activity-registry";

describe("thread activity registry", () => {
  it("reports which conversation is generating", () => {
    const registry = createThreadActivityRegistry();
    registry.setStreaming("s1", true);

    expect(registry.isStreaming("s1")).toBe(true);
    expect(registry.isStreaming("s2")).toBe(false);
  });

  it("notifies nobody when nothing changed", () => {
    // `ChatView` reports from an effect that runs with its status, so this guard is what keeps a
    // long reply from repainting every rail row on every token.
    const registry = createThreadActivityRegistry();
    const listener = vi.fn();
    registry.subscribe(listener);

    registry.setStreaming("s1", true);
    registry.setStreaming("s1", true);
    registry.setStreaming("s2", false);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("advances its version in lockstep with its listeners", () => {
    const registry = createThreadActivityRegistry();
    const before = registry.version();

    registry.setStreaming("s1", true);
    const afterChange = registry.version();
    registry.setStreaming("s1", true);

    expect(afterChange).toBeGreaterThan(before);
    // `useSyncExternalStore` compares this snapshot; a version that moved without a change would
    // re-render the shell for nothing.
    expect(registry.version()).toBe(afterChange);
  });

  it("forgets a conversation whose view is gone", () => {
    // An unmount mid-reply must not leave the badge lit for the rest of the session.
    const registry = createThreadActivityRegistry();
    const listener = vi.fn();
    registry.setStreaming("s1", true);
    registry.subscribe(listener);

    registry.clear("s1");

    expect(registry.isStreaming("s1")).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("stays silent when clearing something it never knew", () => {
    const registry = createThreadActivityRegistry();
    const listener = vi.fn();
    registry.subscribe(listener);

    registry.clear("never-seen");

    expect(listener).not.toHaveBeenCalled();
  });

  it("ignores an empty session id rather than tracking one", () => {
    const registry = createThreadActivityRegistry();
    const listener = vi.fn();
    registry.subscribe(listener);

    registry.setStreaming("", true);

    expect(listener).not.toHaveBeenCalled();
    expect(registry.isStreaming("")).toBe(false);
  });
});
