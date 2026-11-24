import { describe, expect, it } from "vitest";
import {
  enqueueLiveAgentStartupDispatch,
  flushLiveAgentDispatchBuffer,
} from "../live-agent-dispatch-buffer";

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("flushLiveAgentDispatchBuffer", () => {
  it("rejects the newest turn at the startup cap instead of silently evicting an accepted turn", () => {
    const pending: string[] = [];

    expect(enqueueLiveAgentStartupDispatch(pending, "first", 2)).toBeUndefined();
    expect(enqueueLiveAgentStartupDispatch(pending, "second", 2)).toBeUndefined();
    expect(enqueueLiveAgentStartupDispatch(pending, "third", 2)).toBe("third");
    expect(pending).toEqual(["first", "second"]);
  });

  it("preserves queued messages as separate FIFO turns and waits for each receipt", async () => {
    const first = deferred();
    const second = deferred();
    const submitted: string[] = [];
    const receipts = [first.promise, second.promise];
    const flushing = flushLiveAgentDispatchBuffer(
      ["first voice turn", "second voice turn"],
      (text) => {
        submitted.push(text);
        return receipts[submitted.length - 1];
      },
    );

    expect(submitted).toEqual(["first voice turn"]);
    first.resolve();
    await Promise.resolve();
    expect(submitted).toEqual(["first voice turn", "second voice turn"]);

    second.resolve();
    await expect(flushing).resolves.toEqual({
      written: ["first voice turn", "second voice turn"],
      failed: [],
    });
  });

  it("continues flushing accepted turns after one native submission fails", async () => {
    const submitted: string[] = [];
    const result = await flushLiveAgentDispatchBuffer(
      ["broken turn", "recoverable turn"],
      async (text) => {
        submitted.push(text);
        if (text === "broken turn") throw new Error("native write failed");
      },
    );

    expect(submitted).toEqual(["broken turn", "recoverable turn"]);
    expect(result).toEqual({
      written: ["recoverable turn"],
      failed: ["broken turn"],
    });
  });
});
