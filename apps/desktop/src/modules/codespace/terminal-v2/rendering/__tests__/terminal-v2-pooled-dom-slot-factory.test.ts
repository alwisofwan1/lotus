import { describe, expect, it, vi } from "vitest";
import type { TerminalTheme } from "@/lib/design-system";
import { createTerminalV2PooledDomSlotFactory } from "../terminal-v2-pooled-dom-slot-factory";

function createRenderer() {
  return {
    terminal: { reset: vi.fn(), write: vi.fn(), refresh: vi.fn(), rows: 24 },
    fitAddon: { fit: vi.fn() },
    dispose: vi.fn(),
  };
}

describe("createTerminalV2PooledDomSlotFactory", () => {
  it("returns the same pooled slot for the same slot id when explicitly enabled", () => {
    const parkingContainer = document.createElement("div");
    const createRendererSpy = vi.fn(() => createRenderer());
    const factory = createTerminalV2PooledDomSlotFactory({
      parkingContainer,
      resolvePaneContainer: () => document.createElement("div"),
      createRenderer: createRendererSpy,
      policyInput: { environment: "development", storageValue: "1" },
    });

    const first = factory.getSlot("renderer-1");
    const second = factory.getSlot("renderer-1");

    expect(first).toBe(second);
    expect(createRendererSpy).toHaveBeenCalledTimes(1);
  });

  it("creates independent slot elements for different slot ids", () => {
    const parkingContainer = document.createElement("div");
    const factory = createTerminalV2PooledDomSlotFactory({
      parkingContainer,
      resolvePaneContainer: () => document.createElement("div"),
      createRenderer,
      policyInput: { environment: "development", storageValue: "1" },
    });

    const first = factory.getSlot("renderer-1");
    const second = factory.getSlot("renderer-2");

    expect(first?.slotElement).not.toBe(second?.slotElement);
    expect(first?.slotElement.dataset.terminalV2SlotId).toBe("renderer-1");
    expect(second?.slotElement.dataset.terminalV2SlotId).toBe("renderer-2");
    expect(parkingContainer.children).toHaveLength(2);
  });

  it("can dispose one slot without affecting other slots", () => {
    const parkingContainer = document.createElement("div");
    const factory = createTerminalV2PooledDomSlotFactory({
      parkingContainer,
      resolvePaneContainer: () => document.createElement("div"),
      createRenderer,
      policyInput: { environment: "development", storageValue: "1" },
    });

    const first = factory.getSlot("renderer-1");
    const second = factory.getSlot("renderer-2");

    factory.disposeSlot("renderer-1");

    expect(first ? parkingContainer.contains(first.slotElement) : false).toBe(false);
    expect(second ? parkingContainer.contains(second.slotElement) : false).toBe(true);
    expect(factory.getSlot("renderer-2")).toBe(second);
  });

  it("can dispose all pooled slots", () => {
    const parkingContainer = document.createElement("div");
    const dispose = vi.fn();
    const factory = createTerminalV2PooledDomSlotFactory({
      parkingContainer,
      resolvePaneContainer: () => document.createElement("div"),
      createRenderer: () => ({ ...createRenderer(), dispose }),
      policyInput: { environment: "development", storageValue: "1" },
    });

    factory.getSlot("renderer-1");
    factory.getSlot("renderer-2");
    factory.disposeAll();

    expect(parkingContainer.children).toHaveLength(0);
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it("stays disabled by default behind the pooled DOM renderer policy", () => {
    const parkingContainer = document.createElement("div");
    const createRendererSpy = vi.fn(() => createRenderer());
    const factory = createTerminalV2PooledDomSlotFactory({
      parkingContainer,
      resolvePaneContainer: () => document.createElement("div"),
      createRenderer: createRendererSpy,
    });

    expect(factory.policy).toEqual({ enabled: false, reason: "not-enabled" });
    expect(factory.getSlot("renderer-1")).toBeNull();
    expect(createRendererSpy).not.toHaveBeenCalled();
    expect(parkingContainer.children).toHaveLength(0);
  });

  it("applies a new look to live slots and to slots created later, without rebuilding them", () => {
    const renderers: Array<ReturnType<typeof createRenderer> & { setAppearance: ReturnType<typeof vi.fn> }> = [];
    const factory = createTerminalV2PooledDomSlotFactory({
      parkingContainer: document.createElement("div"),
      resolvePaneContainer: () => document.createElement("div"),
      createRenderer: () => {
        const renderer = { ...createRenderer(), setAppearance: vi.fn() };
        renderers.push(renderer);
        return renderer;
      },
      policyInput: { environment: "development", storageValue: "1" },
    });
    const theme = { background: "#fbfaf7", foreground: "#1c1b19", cursor: "#1c1b19" } as TerminalTheme;

    factory.getSlot("renderer-1");
    factory.setAppearance({ theme });
    factory.setAppearance({ fontSize: 15 });
    factory.getSlot("renderer-2");

    expect(renderers[0].setAppearance).toHaveBeenCalledWith({ theme });
    expect(renderers[0].setAppearance).toHaveBeenCalledWith({ fontSize: 15 });
    expect(renderers[0].dispose).not.toHaveBeenCalled();
    expect(renderers[1].setAppearance).toHaveBeenCalledWith({ theme, fontSize: 15 });
  });
});
