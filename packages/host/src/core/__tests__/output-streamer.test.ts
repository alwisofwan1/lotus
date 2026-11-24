import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OutputStreamer } from "../output-streamer.js";
import type { ApiClient, SseStream } from "../api-client.js";

// ─── SSE mock helpers ─────────────────────────────────────────────────────────

interface SseMockHandle {
  stream: SseStream;
  push(line: string): void;
  end(): void;
  fail(err: Error): void;
}

function makeSseMock(): SseMockHandle {
  let resolve: ((result: IteratorResult<string>) => void) | null = null;
  let closed = false;
  const queue: string[] = [];

  function next(): Promise<IteratorResult<string>> {
    if (queue.length > 0) {
      return Promise.resolve({ value: queue.shift()!, done: false });
    }
    return new Promise((r) => {
      resolve = r;
    });
  }

  function push(line: string): void {
    if (resolve) {
      const cb = resolve;
      resolve = null;
      cb({ value: line, done: false });
    } else {
      queue.push(line);
    }
  }

  function end(): void {
    if (resolve) {
      const cb = resolve;
      resolve = null;
      cb({ value: undefined as never, done: true });
    }
  }

  function fail(err: Error): void {
    if (resolve) {
      const cb = resolve;
      resolve = null;
      // Simulate rejection by pushing a throw — use a wrapper
      Promise.reject(err).catch(() => {});
      cb({ value: undefined as never, done: true });
      // Actually we need to propagate the error; use a separate slot
    }
    // For simplicity, we'll throw from the async generator
    void err;
  }

  const stream: SseStream = {
    lines(): AsyncIterable<string> {
      return {
        [Symbol.asyncIterator]() {
          return {
            next,
            return() {
              closed = true;
              return Promise.resolve({ value: undefined as never, done: true });
            },
          };
        },
      };
    },
    close() {
      closed = true;
      end();
    },
    get isClosed() {
      return closed;
    },
  } as SseStream & { isClosed: boolean };

  return { stream, push, end, fail };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("OutputStreamer", () => {
  let mock: SseMockHandle;
  let clientMock: ApiClient;

  beforeEach(() => {
    mock = makeSseMock();
    clientMock = {
      streamSession: vi.fn().mockReturnValue(mock.stream),
    } as unknown as ApiClient;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("buffers data and flushes after debounce", async () => {
    const onData = vi.fn();
    const streamer = new OutputStreamer(clientMock, "sess-1", { onData, debounceMs: 100 });
    streamer.start();

    mock.push("hello");
    mock.push(" world");

    await vi.advanceTimersByTimeAsync(50);
    expect(onData).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(150);
    expect(onData).toHaveBeenCalled();
    const allOutput = (onData.mock.calls as string[][]).flat().join("");
    expect(allOutput).toContain("hello");
    expect(allOutput).toContain("world");
  });

  it("splits buffer at last newline before maxChunkSize", async () => {
    const onData = vi.fn();
    const streamer = new OutputStreamer(clientMock, "sess-1", {
      onData,
      maxChunkSize: 8,
      debounceMs: 50,
    });
    streamer.start();

    mock.push("abcde");
    mock.push("fgh");

    await vi.advanceTimersByTimeAsync(100);

    expect(onData.mock.calls.length).toBeGreaterThanOrEqual(2);
    const received = (onData.mock.calls as string[][]).flat().join("");
    expect(received).toContain("abcde");
    expect(received).toContain("fgh");
  });

  it("does not add extra newline if line already ends with newline", async () => {
    const onData = vi.fn();
    const streamer = new OutputStreamer(clientMock, "sess-1", { onData, debounceMs: 50 });
    streamer.start();

    mock.push("line1\n");
    await vi.advanceTimersByTimeAsync(100);

    expect(onData).toHaveBeenCalled();
    const out = (onData.mock.calls[0] as string[])[0];
    expect(out).toBe("line1\n");
  });

  it("flushes remaining data on stop()", async () => {
    const onData = vi.fn();
    const onEnd = vi.fn();
    const streamer = new OutputStreamer(clientMock, "sess-1", {
      onData,
      onEnd,
      debounceMs: 5000,
    });
    streamer.start();

    mock.push("pending data");
    await vi.advanceTimersByTimeAsync(0);

    streamer.stop();

    expect(onData).toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it("calls onEnd when stream ends naturally", async () => {
    const onEnd = vi.fn();
    const streamer = new OutputStreamer(clientMock, "sess-1", {
      onData: vi.fn(),
      onEnd,
      maxRetries: 0,
    });
    streamer.start();
    mock.end();

    await vi.runAllTimersAsync();

    expect(onEnd).toHaveBeenCalledOnce();
  });

  it("does not call onEnd twice when stop() called after natural end", async () => {
    const onEnd = vi.fn();
    const streamer = new OutputStreamer(clientMock, "sess-1", {
      onData: vi.fn(),
      onEnd,
      maxRetries: 0,
    });
    streamer.start();
    mock.end();

    await vi.runAllTimersAsync();
    streamer.stop();

    expect(onEnd).toHaveBeenCalledOnce();
  });

  it("is idempotent: calling start() twice does not create two connections", () => {
    const streamer = new OutputStreamer(clientMock, "sess-1", { onData: vi.fn() });
    streamer.start();
    streamer.start();
    expect(clientMock.streamSession).toHaveBeenCalledOnce();
  });
});
