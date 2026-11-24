import { describe, expect, it, vi } from "vitest";
import {
  TerminalV2RendererAdapter,
  type TerminalV2RendererHost,
} from "../terminal-v2-renderer-adapter";
import type { TerminalV2RendererBindPlan } from "../terminal-v2-renderer-pool";

function createHost(): TerminalV2RendererHost & { events: string[] } {
  const events: string[] = [];
  return {
    events,
    attachSlot: vi.fn((slotId, paneId) => events.push(`attach:${slotId}:${paneId}`)),
    resetSlot: vi.fn((slotId) => events.push(`reset:${slotId}`)),
    writeToSlot: vi.fn((slotId, data) => events.push(`write:${slotId}:${data}`)),
    drainPaneOutput: vi.fn((_paneId, write) => write("drained-output")),
    fitSlot: vi.fn((slotId, paneId) => events.push(`fit:${slotId}:${paneId}`)),
    repaintSlot: vi.fn((slotId, paneId) => events.push(`repaint:${slotId}:${paneId}`)),
    releaseSlot: vi.fn((slotId, paneId) => events.push(`release:${slotId}:${paneId}`)),
  };
}

function bindPlan(overrides: Partial<TerminalV2RendererBindPlan> = {}): TerminalV2RendererBindPlan {
  return {
    kind: "bound",
    paneId: "pane-1",
    slotId: "renderer-1",
    restore: {
      snapshot: "snapshot-data",
      drainOutput: true,
      fit: true,
      repaint: true,
    },
    ...overrides,
  };
}

describe("TerminalV2RendererAdapter", () => {
  it("releases evicted leases before binding the requested pane", () => {
    const host = createHost();
    const adapter = new TerminalV2RendererAdapter(host);

    adapter.applyBindPlan(bindPlan({
      evicted: {
        paneId: "old-pane",
        slotId: "renderer-1",
        snapshot: "old-snapshot",
      },
    }));

    expect(host.events[0]).toBe("release:renderer-1:old-pane");
    expect(host.releaseSlot).toHaveBeenCalledWith("renderer-1", "old-pane", "old-snapshot");
  });

  it("does not reset a reused slot but still fits before draining and repainting", () => {
    const host = createHost();
    const adapter = new TerminalV2RendererAdapter(host);

    adapter.applyBindPlan(bindPlan({ kind: "reused", restore: {
      snapshot: null,
      drainOutput: true,
      fit: true,
      repaint: true,
    } }));

    expect(host.resetSlot).not.toHaveBeenCalled();
    expect(host.events).toEqual([
      "attach:renderer-1:pane-1",
      "fit:renderer-1:pane-1",
      "write:renderer-1:drained-output",
      "repaint:renderer-1:pane-1",
    ]);
  });

  it("applies release plans through the host", () => {
    const host = createHost();
    const adapter = new TerminalV2RendererAdapter(host);

    adapter.applyReleasePlan({ paneId: "pane-1", slotId: "renderer-1", snapshot: "snapshot" });
    adapter.applyReleasePlan(null);

    expect(host.releaseSlot).toHaveBeenCalledOnce();
    expect(host.releaseSlot).toHaveBeenCalledWith("renderer-1", "pane-1", "snapshot");
  });

  it("fits the slot before restoring output so rehydrated prompt text wraps at the pane width", () => {
    const host = createHost();
    const adapter = new TerminalV2RendererAdapter(host);

    adapter.applyBindPlan(bindPlan());

    expect(host.events).toEqual([
      "attach:renderer-1:pane-1",
      "reset:renderer-1",
      "fit:renderer-1:pane-1",
      "write:renderer-1:snapshot-data",
      "write:renderer-1:drained-output",
      "repaint:renderer-1:pane-1",
    ]);
  });

  it("falls back to output drain when snapshot restore fails", () => {
    const host = createHost();
    const restoreError = new Error("snapshot failed");
    vi.mocked(host.writeToSlot).mockImplementation((slotId, data) => {
      if (data === "snapshot-data") throw restoreError;
      host.events.push(`write:${slotId}:${data}`);
    });
    const onRestoreError = vi.fn();
    const adapter = new TerminalV2RendererAdapter(host, { onRestoreError });

    adapter.applyBindPlan(bindPlan());

    expect(host.events).toEqual([
      "attach:renderer-1:pane-1",
      "reset:renderer-1",
      "fit:renderer-1:pane-1",
      "write:renderer-1:drained-output",
      "repaint:renderer-1:pane-1",
    ]);
    expect(onRestoreError).toHaveBeenCalledWith({
      paneId: "pane-1",
      slotId: "renderer-1",
      error: restoreError,
    });
  });
});
