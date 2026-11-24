import { describe, expect, it, vi } from "vitest";
import {
  createTerminalWriteScheduler,
  SCHEDULER_OVERFLOW_NOTICE,
} from "../terminal-write-scheduler";

function createFrameHarness() {
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextId = 1;

  return {
    requestFrame: vi.fn((callback: FrameRequestCallback) => {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    }),
    cancelFrame: vi.fn((id: number) => {
      callbacks.delete(id);
    }),
    runNextFrame() {
      const entry = callbacks.entries().next().value as [number, FrameRequestCallback] | undefined;
      if (!entry) return false;
      const [id, callback] = entry;
      callbacks.delete(id);
      callback(performance.now());
      return true;
    },
    get pendingFrames() {
      return callbacks.size;
    },
  };
}

describe("terminal write scheduler", () => {
  it("queues writes while a terminal write is in flight", () => {
    const frame = createFrameHarness();
    const callbacks: Array<() => void> = [];
    const writes: string[] = [];
    const scheduler = createTerminalWriteScheduler({
      write: (data, callback) => {
        writes.push(data);
        callbacks.push(callback);
      },
      requestFrame: frame.requestFrame,
      cancelFrame: frame.cancelFrame,
    });

    scheduler.push("a");
    expect(frame.runNextFrame()).toBe(true);
    expect(writes).toEqual(["a"]);

    scheduler.push("b");
    scheduler.push("c");
    expect(writes).toEqual(["a"]);
    expect(frame.pendingFrames).toBe(0);

    callbacks.shift()?.();
    expect(frame.runNextFrame()).toBe(true);
    expect(writes).toEqual(["a", "bc"]);
  });

  it("refreshes only after xterm reports that a write has completed", () => {
    const frame = createFrameHarness();
    const refresh = vi.fn();
    let completeWrite: () => void = () => {};
    const scheduler = createTerminalWriteScheduler({
      write: (_data, callback) => {
        completeWrite = callback;
      },
      refresh,
      requestFrame: frame.requestFrame,
      cancelFrame: frame.cancelFrame,
    });

    scheduler.push("hello");
    frame.runNextFrame();

    expect(refresh).not.toHaveBeenCalled();
    completeWrite();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("preserves output order across burst writes", () => {
    const frame = createFrameHarness();
    const callbacks: Array<() => void> = [];
    const writes: string[] = [];
    const scheduler = createTerminalWriteScheduler({
      write: (data, callback) => {
        writes.push(data);
        callbacks.push(callback);
      },
      requestFrame: frame.requestFrame,
      cancelFrame: frame.cancelFrame,
    });

    scheduler.push("one");
    scheduler.push("-");
    scheduler.push("two");
    frame.runNextFrame();
    scheduler.push("-");
    scheduler.push("three");
    callbacks.shift()?.();
    frame.runNextFrame();

    expect(writes).toEqual(["one-two", "-three"]);
  });

  it("reports queue, write, completion, and refresh metrics", () => {
    const frame = createFrameHarness();
    const metrics = {
      queued: vi.fn(),
      writeStarted: vi.fn(),
      writeCompleted: vi.fn(),
      refreshed: vi.fn(),
    };
    let completeWrite: () => void = () => {};
    const scheduler = createTerminalWriteScheduler({
      write: (_data, callback) => {
        completeWrite = callback;
      },
      refresh: vi.fn(),
      requestFrame: frame.requestFrame,
      cancelFrame: frame.cancelFrame,
      metrics,
    });

    scheduler.push("abc");
    expect(metrics.queued).toHaveBeenCalledWith(3, 3);

    frame.runNextFrame();
    expect(metrics.writeStarted).toHaveBeenCalledWith(3, 0);

    completeWrite();
    expect(metrics.writeCompleted).toHaveBeenCalledOnce();
    expect(metrics.refreshed).toHaveBeenCalledOnce();
  });

  it("splits a large batch at maxBatchBytes and reschedules the remainder", () => {
    const frame = createFrameHarness();
    const callbacks: Array<() => void> = [];
    const writes: string[] = [];
    const scheduler = createTerminalWriteScheduler({
      write: (data, callback) => { writes.push(data); callbacks.push(callback); },
      requestFrame: frame.requestFrame,
      cancelFrame: frame.cancelFrame,
      maxBatchBytes: 4,
    });

    scheduler.push("abcdefgh"); // 8 bytes > maxBatchBytes=4
    frame.runNextFrame();
    expect(writes).toEqual(["abcd"]); // first 4 bytes only
    expect(frame.pendingFrames).toBe(0); // remainder waits for write callback

    callbacks.shift()?.();
    expect(frame.runNextFrame()).toBe(true);
    expect(writes).toEqual(["abcd", "efgh"]); // remainder in next frame
  });

  it("sends entire batch when it fits within maxBatchBytes", () => {
    const frame = createFrameHarness();
    const writes: string[] = [];
    const scheduler = createTerminalWriteScheduler({
      write: (data, cb) => { writes.push(data); cb(); },
      requestFrame: frame.requestFrame,
      cancelFrame: frame.cancelFrame,
      maxBatchBytes: 100,
    });

    scheduler.push("hi");
    frame.runNextFrame();
    expect(writes).toEqual(["hi"]);
  });

  it("hasPending returns true while remainder waits after a split", () => {
    const frame = createFrameHarness();
    const callbacks: Array<() => void> = [];
    const scheduler = createTerminalWriteScheduler({
      write: (_d, cb) => callbacks.push(cb),
      requestFrame: frame.requestFrame,
      cancelFrame: frame.cancelFrame,
      maxBatchBytes: 2,
    });

    scheduler.push("abcd"); // 4 bytes, split into two batches of 2
    frame.runNextFrame();
    expect(scheduler.hasPending()).toBe(true); // "cd" still in pending
    callbacks.shift()?.();
    frame.runNextFrame();
    callbacks.shift()?.();
    expect(scheduler.hasPending()).toBe(false);
  });

  it("overflow notice does NOT contain the terminal hard-reset sequence \\x1bc", () => {
    expect(SCHEDULER_OVERFLOW_NOTICE).not.toContain("\x1bc");
  });

  it("prepends the overflow notice when pending exceeds maxPendingBytes", () => {
    const frame = createFrameHarness();
    const writes: string[] = [];
    const scheduler = createTerminalWriteScheduler({
      // Auto-complete each write so the next frame is immediately schedulable.
      write: (data, cb) => { writes.push(data); cb(); },
      requestFrame: frame.requestFrame,
      cancelFrame: frame.cancelFrame,
      maxBatchBytes: 1024,
      maxPendingBytes: 8,
    });

    // Push 12 bytes — exceeds the 8-byte cap by 4.
    scheduler.push("abcdefghijkl");
    frame.runNextFrame(); // emits the overflow notice (auto-completed → queues next frame)
    frame.runNextFrame(); // emits the surviving data

    // First write must be the overflow notice.
    expect(writes[0]).toBe(SCHEDULER_OVERFLOW_NOTICE);
    // Data after the notice must be non-empty (last bytes kept).
    expect(writes.slice(1).join("")).toBeTruthy();
  });

  it("delivers data pushed after overflow without a second notice", () => {
    const frame = createFrameHarness();
    const writes: string[] = [];
    let completeWrite: () => void = () => {};
    const scheduler = createTerminalWriteScheduler({
      write: (data, cb) => { writes.push(data); completeWrite = cb; },
      requestFrame: frame.requestFrame,
      cancelFrame: frame.cancelFrame,
      maxPendingBytes: 4,
    });

    scheduler.push("OVERFLOW_DATA"); // exceeds 4-byte cap → overflow
    frame.runNextFrame();            // frame 1: emits overflow notice
    completeWrite();               // completes notice → schedules frame for surviving data
    frame.runNextFrame();            // frame 2: emits surviving data
    completeWrite();               // completes data write → scheduler idle

    scheduler.push("ok"); // fits — no overflow
    frame.runNextFrame();
    completeWrite();

    const noticeCount = writes.filter((w) => w === SCHEDULER_OVERFLOW_NOTICE).length;
    expect(noticeCount).toBe(1); // notice only on the first overflow batch
    expect(writes.at(-1)).toBe("ok");
  });

  it("does not emit overflow notice when maxPendingBytes is not set", () => {
    const frame = createFrameHarness();
    const writes: string[] = [];
    const scheduler = createTerminalWriteScheduler({
      write: (data, cb) => { writes.push(data); cb(); },
      requestFrame: frame.requestFrame,
      cancelFrame: frame.cancelFrame,
    });

    scheduler.push("x".repeat(500_000)); // large push, no cap configured
    frame.runNextFrame();

    expect(writes.every((w) => w !== SCHEDULER_OVERFLOW_NOTICE)).toBe(true);
  });

  it("cancels scheduled work and drops pending output when disposed", () => {
    const frame = createFrameHarness();
    const write = vi.fn();
    const scheduler = createTerminalWriteScheduler({
      write,
      requestFrame: frame.requestFrame,
      cancelFrame: frame.cancelFrame,
    });

    scheduler.push("dropped");
    scheduler.dispose();

    expect(frame.cancelFrame).toHaveBeenCalledTimes(1);
    expect(frame.runNextFrame()).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(scheduler.hasPending()).toBe(false);
  });
});
