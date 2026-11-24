import { describe, expect, it, vi } from "vitest";
import {
  createAgentSessionControlRegistry,
  type AgentSessionControlHandle,
} from "../session-control-registry";

function handle(overrides: Partial<AgentSessionControlHandle> = {}): AgentSessionControlHandle {
  return {
    sessions: () => [],
    activeSessionId: () => null,
    isDormant: () => false,
    wake: vi.fn(),
    judge: vi.fn(() => ({ allowed: true as const, intent: { kind: "new" as const } })),
    commit: vi.fn(),
    request: vi.fn(() => ({ allowed: true as const, intent: { kind: "new" as const } })),
    resume: vi.fn(() => ({ allowed: true as const, intent: { kind: "new" as const } })),
    startNew: vi.fn(() => ({ allowed: true as const, intent: { kind: "new" as const } })),
    ...overrides,
  };
}

describe("agent session control registry", () => {
  it("hands a node's controls to whoever asks for them by id", () => {
    const registry = createAgentSessionControlRegistry();
    const node = handle({ isDormant: () => true });
    registry.register("agent-1", node);

    expect(registry.get("agent-1")?.isDormant()).toBe(true);
    expect(registry.get("agent-2")).toBeUndefined();
  });

  it("stops answering once a node unregisters", () => {
    const registry = createAgentSessionControlRegistry();
    const dispose = registry.register("agent-1", handle());
    dispose();
    expect(registry.get("agent-1")).toBeUndefined();
  });

  // React mounts the replacement before cleaning up the old one. Deleting unconditionally on the
  // stale cleanup would leave a live node unreachable from the popover, ⌘K, and the hotkeys.
  it("survives a remount, where the new handle registers before the old one is disposed", () => {
    const registry = createAgentSessionControlRegistry();
    const first = handle({ isDormant: () => true });
    const disposeFirst = registry.register("agent-1", first);

    const second = handle({ isDormant: () => false });
    registry.register("agent-1", second);
    disposeFirst();

    expect(registry.get("agent-1")).toBe(second);
  });

  // What makes "make a node, then run its session" one gesture instead of two clicks: the caller
  // creates the node and waits for its controls to appear, rather than guessing at a delay
  // (`plans/codecanvas-session-refactor/issues/03`).
  it("hands over a node's controls as soon as it mounts", async () => {
    const registry = createAgentSessionControlRegistry();
    const node = handle();

    const waiting = registry.waitFor("agent-1", 1000);
    registry.register("agent-1", node);

    await expect(waiting).resolves.toBe(node);
  });

  it("answers immediately for a node that is already here", async () => {
    const registry = createAgentSessionControlRegistry();
    const node = handle();
    registry.register("agent-1", node);

    await expect(registry.waitFor("agent-1", 1000)).resolves.toBe(node);
  });

  // A node that never mounts must become a sentence, not a promise that hangs forever.
  it("gives up on a node that never arrives", async () => {
    const registry = createAgentSessionControlRegistry();
    await expect(registry.waitFor("agent-1", 10)).resolves.toBeNull();
  });

  it("keeps nodes apart", () => {
    const registry = createAgentSessionControlRegistry();
    const one = handle();
    const two = handle();
    registry.register("agent-1", one);
    registry.register("agent-2", two);

    expect(registry.get("agent-1")).toBe(one);
    expect(registry.get("agent-2")).toBe(two);
  });
});
