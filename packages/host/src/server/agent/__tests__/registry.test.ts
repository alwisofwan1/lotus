import { describe, it, expect, vi } from "vitest";
import { AgentRunnerRegistry } from "../registry.js";
import type { AgentRunner, AgentProviderId } from "../types.js";
import type { PtyManager } from "../../pty/manager.js";

function makeRunner(id: AgentProviderId): AgentRunner {
  return {
    providerId: id,
    chat: vi.fn(),
    spawnPty: vi.fn(),
  };
}

function makeMockPtyManager(): PtyManager {
  return { write: vi.fn() } as unknown as PtyManager;
}

describe("AgentRunnerRegistry", () => {
  it("get() returns undefined for an unregistered provider", () => {
    const reg = new AgentRunnerRegistry();
    expect(reg.get("codex")).toBeUndefined();
  });

  it("get() returns the runner after register()", () => {
    const reg = new AgentRunnerRegistry();
    const runner = makeRunner("claude");
    reg.register(runner);
    expect(reg.get("claude")).toBe(runner);
  });

  it("list() returns all registered provider IDs", () => {
    const reg = new AgentRunnerRegistry();
    reg.register(makeRunner("claude"));
    reg.register(makeRunner("codex"));
    expect(reg.list().sort()).toEqual(["claude", "codex"]);
  });

  it("list() returns empty array when no runners registered", () => {
    expect(new AgentRunnerRegistry().list()).toEqual([]);
  });

  it("registering a second runner with same providerId replaces the first", () => {
    const reg = new AgentRunnerRegistry();
    const first = makeRunner("claude");
    const second = makeRunner("claude");
    reg.register(first);
    reg.register(second);
    expect(reg.get("claude")).toBe(second);
    expect(reg.list()).toHaveLength(1);
  });
});

describe("AgentRunnerRegistry.build()", () => {
  it("registers the claude runner", () => {
    const reg = AgentRunnerRegistry.build(makeMockPtyManager());
    expect(reg.get("claude")).toBeDefined();
    expect(reg.get("claude")!.providerId).toBe("claude");
  });

  it("registers the codex runner", () => {
    const reg = AgentRunnerRegistry.build(makeMockPtyManager());
    expect(reg.get("codex")).toBeDefined();
    expect(reg.get("codex")!.providerId).toBe("codex");
  });

  it("list() includes at least 'claude' and 'codex' after build()", () => {
    const reg = AgentRunnerRegistry.build(makeMockPtyManager());
    expect(reg.list()).toContain("claude");
    expect(reg.list()).toContain("codex");
  });
});
