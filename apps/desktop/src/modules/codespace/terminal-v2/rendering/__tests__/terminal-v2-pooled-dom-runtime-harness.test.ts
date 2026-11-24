import { describe, expect, it, vi } from "vitest";
import { createTerminalV2PooledDomRuntimeHarness } from "../terminal-v2-pooled-dom-runtime-harness";

function createRenderer() {
  return {
    terminal: { reset: vi.fn(), write: vi.fn(), refresh: vi.fn(), rows: 24 },
    fitAddon: { fit: vi.fn() },
    dispose: vi.fn(),
  };
}

describe("createTerminalV2PooledDomRuntimeHarness", () => {
  it("returns no harness when pooled DOM rendering is disabled by default", () => {
    const hostContainer = document.createElement("div");
    const harness = createTerminalV2PooledDomRuntimeHarness({
      hostContainer,
      resolvePaneContainer: () => document.createElement("div"),
      createRenderer,
    });

    expect(harness).toBeNull();
    expect(hostContainer.children).toHaveLength(0);
  });

  it("returns no harness in production even when storage opts in", () => {
    const hostContainer = document.createElement("div");
    const harness = createTerminalV2PooledDomRuntimeHarness({
      hostContainer,
      resolvePaneContainer: () => document.createElement("div"),
      createRenderer,
      policyInput: { environment: "production", storageValue: "1" },
    });

    expect(harness).toBeNull();
    expect(hostContainer.children).toHaveLength(0);
  });

  it("creates a hidden parking container and slot factory when explicitly enabled", () => {
    const hostContainer = document.createElement("div");
    const harness = createTerminalV2PooledDomRuntimeHarness({
      hostContainer,
      resolvePaneContainer: () => document.createElement("div"),
      createRenderer,
      policyInput: { environment: "development", storageValue: "1" },
    });

    expect(harness?.parkingContainer.hidden).toBe(true);
    expect(harness?.parkingContainer.dataset.terminalV2PooledRendererParking).toBe("true");
    expect(hostContainer.contains(harness?.parkingContainer ?? null)).toBe(true);
    expect(harness?.slotFactory.policy).toEqual({ enabled: true, reason: "enabled" });
  });

  it("disposes pooled slots and removes the parking container", () => {
    const hostContainer = document.createElement("div");
    const rendererDisposers = [vi.fn(), vi.fn()];
    const createdDisposers: Array<ReturnType<typeof vi.fn>> = [];
    const harness = createTerminalV2PooledDomRuntimeHarness({
      hostContainer,
      resolvePaneContainer: () => document.createElement("div"),
      createRenderer: vi.fn(() => {
        const dispose = rendererDisposers.shift() ?? vi.fn();
        createdDisposers.push(dispose);
        return {
          terminal: { reset: vi.fn(), write: vi.fn(), refresh: vi.fn(), rows: 24 },
          fitAddon: { fit: vi.fn() },
          dispose,
        };
      }),
      policyInput: { environment: "development", storageValue: "1" },
    });

    harness?.slotFactory.getSlot("renderer-1");
    harness?.slotFactory.getSlot("renderer-2");

    harness?.dispose();

    expect(hostContainer.children).toHaveLength(0);
    expect(createdDisposers).toHaveLength(2);
    expect(createdDisposers[0]).toHaveBeenCalledTimes(1);
    expect(createdDisposers[1]).toHaveBeenCalledTimes(1);
  });
});
