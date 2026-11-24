import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createS2sToolResultBatcher,
  S2S_TOOL_RESULT_FALLBACK_MS,
} from "../s2s-tool-result-batcher";

describe("S2S tool result batcher", () => {
  afterEach(() => vi.useRealTimers());

  it("waits for every call from a completed provider response and continues once", async () => {
    const send = vi.fn(async () => undefined);
    const batcher = createS2sToolResultBatcher({ send });

    batcher.begin("call-1");
    batcher.begin("call-2");
    await batcher.complete("call-1", '{"ok":true,"summary":"first"}');
    await batcher.markResponseDone();
    expect(send).not.toHaveBeenCalled();

    await batcher.complete("call-2", '{"ok":true,"summary":"second"}');

    expect(send.mock.calls).toEqual([
      [{ callId: "call-1", output: '{"ok":true,"summary":"first"}' }, false],
      [{ callId: "call-2", output: '{"ok":true,"summary":"second"}' }, true],
    ]);
  });

  it("flushes immediately when response.done arrives after all local tools settle", async () => {
    const send = vi.fn(async () => undefined);
    const batcher = createS2sToolResultBatcher({ send });

    batcher.begin("call-1");
    await batcher.complete("call-1", '{"ok":true}');
    expect(send).not.toHaveBeenCalled();

    await batcher.markResponseDone();

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(
      { callId: "call-1", output: '{"ok":true}' },
      true,
    );
  });

  it("uses a bounded fallback for compatible providers that omit response.done", async () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => undefined);
    const batcher = createS2sToolResultBatcher({ send });

    batcher.begin("call-1");
    await batcher.complete("call-1", '{"ok":true}');
    await vi.advanceTimersByTimeAsync(S2S_TOOL_RESULT_FALLBACK_MS - 1);
    expect(send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledWith(
      { callId: "call-1", output: '{"ok":true}' },
      true,
    );
  });

  it("reset prevents the remainder of an in-flight batch from reaching a closed session", async () => {
    let releaseFirst: () => void = () => {};
    const send = vi.fn((_result: unknown, continueResponse: boolean) =>
      continueResponse
        ? Promise.resolve()
        : new Promise<void>((resolve) => { releaseFirst = resolve; }),
    );
    const batcher = createS2sToolResultBatcher({ send });
    batcher.begin("call-1");
    batcher.begin("call-2");
    await batcher.complete("call-1", '{"ok":true}');
    await batcher.complete("call-2", '{"ok":true}');
    void batcher.markResponseDone();
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);

    batcher.reset();
    releaseFirst();
    await Promise.resolve();
    await Promise.resolve();

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("reset drops private call state and cancels fallback continuation", async () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => undefined);
    const batcher = createS2sToolResultBatcher({ send });

    batcher.begin("private-call-id");
    await batcher.complete("private-call-id", '{"ok":true}');
    batcher.reset();
    await vi.advanceTimersByTimeAsync(S2S_TOOL_RESULT_FALLBACK_MS);

    expect(send).not.toHaveBeenCalled();
  });
});
