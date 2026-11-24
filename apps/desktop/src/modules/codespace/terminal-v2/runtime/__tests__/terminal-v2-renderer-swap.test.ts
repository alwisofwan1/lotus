import { describe, expect, it, vi } from "vitest";
import { TerminalV2Runtime } from "../terminal-v2-runtime";
import { createTerminalV2PooledDomSlotFactory } from "../../rendering/terminal-v2-pooled-dom-slot-factory";

function createFactory(runtime: TerminalV2Runtime, write: (data: string) => void) {
  return createTerminalV2PooledDomSlotFactory({
    parkingContainer: document.createElement("div"),
    resolvePaneContainer: (paneId) => runtime.getPooledRendererPaneContainer(paneId),
    createRenderer: () => ({
      terminal: { reset: vi.fn(), write, refresh: vi.fn(), rows: 24 },
      fitAddon: { fit: vi.fn() },
      dispose: vi.fn(),
    }),
    policyInput: { environment: "development", storageValue: "1" },
  });
}

describe("replacing the pooled renderer factory (flag toggled off and on)", () => {
  it("rebinds a visible pane to a live slot from the new factory", () => {
    const paneContainer = document.createElement("div");
    const frames: FrameRequestCallback[] = [];
    const runtime = new TerminalV2Runtime({
      requestFrame: (callback) => frames.push(callback),
      cancelFrame: vi.fn(),
    });
    runtime.registerPooledRendererPaneContainer("pane-1", paneContainer);

    const oldFactory = createFactory(runtime, vi.fn());
    const uninstallOld = runtime.installPooledDomSlotFactory(oldFactory);
    runtime.updateRendererPane({ paneId: "pane-1", visible: true });

    // The order TerminalV2RuntimeProvider tears the adapter down and mounts a new one.
    uninstallOld();
    oldFactory.disposeAll();
    const newWrite = vi.fn();
    runtime.installPooledDomSlotFactory(createFactory(runtime, newWrite));

    expect(paneContainer.querySelector("[data-terminal-v2-slot-id]")).toBeTruthy();
    runtime.writeRendererPaneOutput("pane-1", "after-swap");
    frames.splice(0).forEach((frame) => frame(0));
    expect(newWrite).toHaveBeenCalledWith("after-swap");
  });
});
