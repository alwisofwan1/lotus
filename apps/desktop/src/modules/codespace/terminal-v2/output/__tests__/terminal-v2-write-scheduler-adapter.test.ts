import { describe, expect, it, vi } from "vitest";
import { createTerminalV2WriteScheduler } from "../terminal-v2-write-scheduler-adapter";

describe("createTerminalV2WriteScheduler", () => {
  it("creates a production write scheduler with V2 defaults", () => {
    const scheduler = createTerminalV2WriteScheduler({
      paneId: "pane-1",
      write: vi.fn(),
      refresh: vi.fn(),
      requestFrame: vi.fn(() => 1),
      cancelFrame: vi.fn(),
    });

    expect(scheduler).toMatchObject({
      push: expect.any(Function),
      flush: expect.any(Function),
      dispose: expect.any(Function),
      hasPending: expect.any(Function),
    });
  });

  it("coalesces output and flushes through the injected terminal writer", () => {
    let frameCallback: FrameRequestCallback | undefined;
    const write = vi.fn((_data: string, callback: () => void) => callback());
    const refresh = vi.fn();
    const scheduler = createTerminalV2WriteScheduler({
      paneId: "pane-1",
      write,
      refresh,
      requestFrame: vi.fn((callback) => {
        frameCallback = callback;
        return 1;
      }),
      cancelFrame: vi.fn(),
    });

    scheduler.push("hello");
    expect(frameCallback).toEqual(expect.any(Function));
    (frameCallback as FrameRequestCallback)(0);

    expect(write).toHaveBeenCalledWith("hello", expect.any(Function));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("uses a bounded pending queue for production hardening", () => {
    const write = vi.fn((_data: string, callback: () => void) => callback());
    const scheduler = createTerminalV2WriteScheduler({
      paneId: "pane-1",
      write,
      refresh: vi.fn(),
      requestFrame: vi.fn(() => 1),
      cancelFrame: vi.fn(),
      maxPendingBytes: 4,
    });

    scheduler.push("12345678");
    scheduler.flush();

    expect(write.mock.calls[0]?.[0]).toContain("write queue full");
  });
});
