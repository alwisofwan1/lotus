import { afterEach, describe, expect, it, vi } from "vitest";
import { TERMINAL_V2_POOLED_DOM_RENDERER_STORAGE_KEY } from "../../rendering/terminal-v2-pooled-dom-renderer-policy";
import type { TerminalV2PooledDomSlotFactory } from "../../rendering/terminal-v2-pooled-dom-slot-factory";
import {
  mountTerminalV2PooledRendererUiAdapter,
  resolveTerminalV2PooledRendererUiPolicyInput,
} from "../terminal-v2-pooled-renderer-ui-adapter";

function createRenderer() {
  return {
    terminal: { reset: vi.fn(), write: vi.fn(), refresh: vi.fn(), rows: 24 },
    fitAddon: { fit: vi.fn() },
    dispose: vi.fn(),
  };
}

describe("mountTerminalV2PooledRendererUiAdapter", () => {
  afterEach(() => {
    localStorage.removeItem(TERMINAL_V2_POOLED_DOM_RENDERER_STORAGE_KEY);
  });

  it("keeps pooled renderer UI disabled by default without touching the runtime", () => {
    const hostContainer = document.createElement("div");
    const runtime = { installPooledDomSlotFactory: vi.fn(() => vi.fn()) };

    const result = mountTerminalV2PooledRendererUiAdapter({
      runtime,
      hostContainer,
      resolvePaneContainer: () => document.createElement("div"),
      createRenderer,
    });

    expect(result).toEqual({ kind: "disabled", reason: "not-enabled" });
    expect(runtime.installPooledDomSlotFactory).not.toHaveBeenCalled();
    expect(hostContainer.children).toHaveLength(0);
  });

  it("resolves localStorage opt-in for non-production adapter experiments", () => {
    localStorage.setItem(TERMINAL_V2_POOLED_DOM_RENDERER_STORAGE_KEY, "1");

    expect(resolveTerminalV2PooledRendererUiPolicyInput({ environment: "development" })).toEqual({
      environment: "development",
      storageValue: "1",
    });
  });

  it("resolves feature-enabled rollout policy input", () => {
    expect(resolveTerminalV2PooledRendererUiPolicyInput({
      environment: "development",
      featureEnabled: true,
      storage: null,
    })).toEqual({
      environment: "development",
      storageValue: null,
      featureEnabled: true,
    });
  });

  it("keeps pooled renderer UI disabled in production from storage opt-in alone", () => {
    const hostContainer = document.createElement("div");
    const runtime = { installPooledDomSlotFactory: vi.fn(() => vi.fn()) };

    const result = mountTerminalV2PooledRendererUiAdapter({
      runtime,
      hostContainer,
      resolvePaneContainer: () => document.createElement("div"),
      createRenderer,
      policyInput: { environment: "production", storageValue: "1" },
    });

    expect(result).toEqual({ kind: "disabled", reason: "production" });
    expect(runtime.installPooledDomSlotFactory).not.toHaveBeenCalled();
    expect(hostContainer.children).toHaveLength(0);
  });

  it("installs pooled renderer UI in production when the rollout feature is enabled", () => {
    const hostContainer = document.createElement("div");
    const uninstall = vi.fn();
    const runtime = { installPooledDomSlotFactory: vi.fn(() => uninstall) };

    const result = mountTerminalV2PooledRendererUiAdapter({
      runtime,
      hostContainer,
      resolvePaneContainer: () => document.createElement("div"),
      createRenderer,
      policyInput: { environment: "production", featureEnabled: true },
    });

    expect(result.kind).toBe("enabled");
    expect(runtime.installPooledDomSlotFactory).toHaveBeenCalledTimes(1);
    if (result.kind === "enabled") result.dispose();
  });

  it("keeps pooled renderer UI disabled when the fallback switch is off", () => {
    const hostContainer = document.createElement("div");
    const runtime = { installPooledDomSlotFactory: vi.fn(() => vi.fn()) };

    const result = mountTerminalV2PooledRendererUiAdapter({
      runtime,
      hostContainer,
      resolvePaneContainer: () => document.createElement("div"),
      createRenderer,
      policyInput: { environment: "development", storageValue: "1", featureEnabled: false },
    });

    expect(result).toEqual({ kind: "disabled", reason: "disabled-by-flag" });
    expect(runtime.installPooledDomSlotFactory).not.toHaveBeenCalled();
    expect(hostContainer.children).toHaveLength(0);
  });

  it("installs an enabled pooled DOM factory without creating xterm in the component", () => {
    const hostContainer = document.createElement("div");
    const paneContainer = document.createElement("div");
    const uninstall = vi.fn();
    const installedFactories: TerminalV2PooledDomSlotFactory[] = [];
    const runtime = {
      installPooledDomSlotFactory: vi.fn((factory: TerminalV2PooledDomSlotFactory) => {
        installedFactories.push(factory);
        return uninstall;
      }),
    };
    const createRendererSpy = vi.fn(() => createRenderer());

    const result = mountTerminalV2PooledRendererUiAdapter({
      runtime,
      hostContainer,
      resolvePaneContainer: (paneId) => paneId === "pane-1" ? paneContainer : null,
      createRenderer: createRendererSpy,
      policyInput: { environment: "development", storageValue: "1" },
    });

    expect(result.kind).toBe("enabled");
    expect(runtime.installPooledDomSlotFactory).toHaveBeenCalledTimes(1);
    expect(createRendererSpy).not.toHaveBeenCalled();
    if (result.kind !== "enabled") return;

    const factory = installedFactories[0];
    if (!factory) throw new Error("expected installed factory");
    const slot = factory.getSlot("renderer-1");
    slot?.attachPane("pane-1");

    expect(createRendererSpy).toHaveBeenCalledTimes(1);
    expect(paneContainer.querySelector("[data-terminal-v2-slot-id='renderer-1']")).toBeTruthy();
  });

  it("uninstalls the runtime factory and disposes harness slots on dispose", () => {
    const hostContainer = document.createElement("div");
    const uninstall = vi.fn();
    const rendererDispose = vi.fn();
    const runtime = { installPooledDomSlotFactory: vi.fn(() => uninstall) };

    const result = mountTerminalV2PooledRendererUiAdapter({
      runtime,
      hostContainer,
      resolvePaneContainer: () => document.createElement("div"),
      createRenderer: () => ({ ...createRenderer(), dispose: rendererDispose }),
      policyInput: { environment: "development", storageValue: "1" },
    });
    if (result.kind !== "enabled") throw new Error("expected enabled adapter");

    result.harness.slotFactory.getSlot("renderer-1");
    result.dispose();

    expect(uninstall).toHaveBeenCalledTimes(1);
    expect(rendererDispose).toHaveBeenCalledTimes(1);
    expect(hostContainer.children).toHaveLength(0);
  });
});
