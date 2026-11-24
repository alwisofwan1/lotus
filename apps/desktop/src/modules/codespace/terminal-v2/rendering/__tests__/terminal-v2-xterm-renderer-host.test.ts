import { describe, expect, it, vi } from "vitest";
import {
  TerminalV2XtermRendererHost,
  type TerminalV2XtermRendererSlot,
} from "../terminal-v2-xterm-renderer-host";

function createTestSlot(): TerminalV2XtermRendererSlot {
  return {
    attachPane: vi.fn(),
    releasePane: vi.fn(),
    terminal: {
      reset: vi.fn(),
      write: vi.fn(),
      refresh: vi.fn(),
      rows: 24,
    },
    fitAddon: {
      fit: vi.fn(),
    },
  };
}

describe("TerminalV2XtermRendererHost", () => {
  it("uses a registered slot before falling back to lazy slot creation", () => {
    const registered = createTestSlot();
    const fallback = createTestSlot();
    const createSlot = vi.fn(() => fallback);
    const host = new TerminalV2XtermRendererHost({
      createSlot,
      drainPaneOutput: vi.fn(),
    });

    const unregister = host.registerSlot("renderer-1", registered);
    host.writeToSlot("renderer-1", "registered");
    unregister();
    host.writeToSlot("renderer-1", "fallback");

    expect(registered.terminal.write).toHaveBeenCalledWith("registered");
    expect(fallback.terminal.write).toHaveBeenCalledWith("fallback");
    expect(createSlot).toHaveBeenCalledOnce();
  });

  it("reuses created slots by slot id", () => {
    const slot = createTestSlot();
    const createSlot = vi.fn(() => slot);
    const host = new TerminalV2XtermRendererHost({
      createSlot,
      drainPaneOutput: vi.fn(),
    });

    host.attachSlot("renderer-1", "pane-1");
    host.writeToSlot("renderer-1", "first");
    host.writeToSlot("renderer-1", "second");

    expect(createSlot).toHaveBeenCalledOnce();
    expect(slot.terminal.write).toHaveBeenCalledWith("first");
    expect(slot.terminal.write).toHaveBeenCalledWith("second");
  });

  it("skips repaint when the terminal has no rows", () => {
    const slot = createTestSlot();
    slot.terminal.rows = 0;
    const host = new TerminalV2XtermRendererHost({
      createSlot: vi.fn(() => slot),
      drainPaneOutput: vi.fn(),
    });

    host.repaintSlot("renderer-1", "pane-1");

    expect(slot.terminal.refresh).not.toHaveBeenCalled();
  });

  it("creates slots lazily and forwards renderer operations to injected xterm handles", () => {
    const slot = createTestSlot();
    const drainPaneOutput = vi.fn((_paneId: string, write: (chunk: string) => void) => {
      write("pending-output");
    });
    const host = new TerminalV2XtermRendererHost({
      createSlot: vi.fn(() => slot),
      drainPaneOutput,
    });

    host.attachSlot("renderer-1", "pane-1");
    host.resetSlot("renderer-1");
    host.writeToSlot("renderer-1", "snapshot");
    host.drainPaneOutput("pane-1", (chunk) => host.writeToSlot("renderer-1", chunk));
    host.fitSlot("renderer-1", "pane-1");
    host.repaintSlot("renderer-1", "pane-1");
    host.releaseSlot("renderer-1", "pane-1", "snapshot:pane-1");

    expect(slot.attachPane).toHaveBeenCalledWith("pane-1");
    expect(slot.terminal.reset).toHaveBeenCalledOnce();
    expect(slot.terminal.write).toHaveBeenNthCalledWith(1, "snapshot");
    expect(slot.terminal.write).toHaveBeenNthCalledWith(2, "pending-output");
    expect(slot.fitAddon.fit).toHaveBeenCalledOnce();
    expect(slot.terminal.refresh).toHaveBeenCalledWith(0, 23);
    expect(slot.releasePane).toHaveBeenCalledWith("pane-1", "snapshot:pane-1");
  });

  it("blurs renderer slots that expose blur", () => {
    const blur = vi.fn();
    const slot = createTestSlot();
    slot.blur = vi.fn(() => {
      blur();
      return true;
    });
    const host = new TerminalV2XtermRendererHost({
      createSlot: vi.fn(() => slot),
      drainPaneOutput: vi.fn(),
    });

    expect(host.blurSlot("renderer-1", "pane-1")).toBe(true);
    expect(slot.blur).toHaveBeenCalledOnce();
    expect(blur).toHaveBeenCalledOnce();
  });

  it("captures snapshots from slots that provide a serializer", () => {
    const slot = { ...createTestSlot(), captureSnapshot: vi.fn(() => "serialized-buffer") };
    const host = new TerminalV2XtermRendererHost({
      createSlot: vi.fn(() => slot),
      drainPaneOutput: vi.fn(),
    });

    expect(host.captureSlotSnapshot("renderer-1", "pane-1")).toBe("serialized-buffer");
    expect(slot.captureSnapshot).toHaveBeenCalledOnce();
  });
});

describe("TerminalV2XtermRendererHost — snapshot during teardown", () => {
  function hostWithSlot(slot: TerminalV2XtermRendererSlot) {
    return new TerminalV2XtermRendererHost({
      createSlot: vi.fn(() => slot),
      drainPaneOutput: vi.fn(),
    });
  }

  it("returns the snapshot when the terminal can still be read", () => {
    const slot = { ...createTestSlot(), captureSnapshot: vi.fn(() => "scrollback") };
    expect(hostWithSlot(slot).captureSlotSnapshot("slot-1", "pane-1")).toBe("scrollback");
  });

  it("returns null instead of throwing when the buffer is already disposed", () => {
    // What the serialize addon does on a disposed xterm: it reads `buffer` and throws. Releasing
    // a pane must survive that — the snapshot is scrollback we would like, not a precondition.
    const slot = {
      ...createTestSlot(),
      captureSnapshot: vi.fn(() => {
        throw new TypeError("undefined is not an object (evaluating 'this._buffer.lines')");
      }),
    };

    expect(() => hostWithSlot(slot).captureSlotSnapshot("slot-1", "pane-1")).not.toThrow();
    expect(hostWithSlot(slot).captureSlotSnapshot("slot-1", "pane-1")).toBeNull();
  });

  it("returns null for a slot that cannot snapshot at all", () => {
    expect(hostWithSlot(createTestSlot()).captureSlotSnapshot("slot-1", "pane-1")).toBeNull();
  });
});
