import { describe, expect, it, vi } from "vitest";
import {
  quietSettler,
  writePromptToPty,
} from "@/modules/codespace/services/task-execution/writePrompt";

describe("waiting for the pane to go quiet", () => {
  it("holds the return until the pane stops drawing", async () => {
    // A fresh `claude` is still printing its banner when the prompt lands. A return sent into that
    // is a return nobody hears — which is how the prompt ended up sitting in the composer, unsent.
    const readings = [{ idleMs: 0 }, { idleMs: 40 }, { idleMs: 400 }];
    let index = 0;
    const getMetrics = vi.fn(async () => readings[Math.min(index++, readings.length - 1)]);

    await quietSettler(getMetrics, { quietMs: 350, pollMs: 1 })("s1");

    expect(getMetrics).toHaveBeenCalledTimes(3);
  });

  it("lets the return go rather than holding it forever", async () => {
    // An agent that never stops printing must not hold the prompt hostage.
    const getMetrics = vi.fn(async () => ({ idleMs: 0 }));

    await quietSettler(getMetrics, { quietMs: 350, timeoutMs: 20, pollMs: 5 })("s1");

    expect(getMetrics).toHaveBeenCalled();
  });

  it("does not wait on a pane that cannot be measured", async () => {
    const getMetrics = vi.fn(async () => null);

    await quietSettler(getMetrics, { quietMs: 350, timeoutMs: 15, pollMs: 5 })("s1");

    expect(getMetrics).toHaveBeenCalled();
  });
});

describe("handing a prompt to a TUI", () => {
  it("presses return only after the settler says the pane is ready", async () => {
    const order: string[] = [];
    const write = vi.fn(async (_sessionId: string, data: string) => {
      order.push(data === "\r" ? "return" : "text");
    });

    await writePromptToPty("s1", "do the thing", write, async () => {
      order.push("settled");
    });

    expect(order).toEqual(["text", "settled", "return"]);
  });

  /*
    The whole reason this function exists. `prompt + "\r"` in one write is read as a paste: the
    text lands in the agent's input box and stays there, and the pane looks like it is thinking
    when nothing was ever submitted.
  */
  it("sends the text and the return as two separate writes", async () => {
    const write = vi.fn(async (_sessionId: string, _data: string) => {});

    await writePromptToPty("s1", "Fix the flaky login test", write);

    expect(write.mock.calls).toEqual([
      ["s1", "Fix the flaky login test"],
      ["s1", "\r"],
    ]);
  });

  it("never lets a newline ride along with the text", async () => {
    const write = vi.fn(async (_sessionId: string, _data: string) => {});

    await writePromptToPty("s1", "line one\nline two\n", write);

    const text = write.mock.calls[0][1];
    expect(text.endsWith("\n")).toBe(false);
    expect(text.endsWith("\r")).toBe(false);
  });

  it("does not press return when there was nothing to send", async () => {
    const write = vi.fn(async (_sessionId: string, _data: string) => {});

    await writePromptToPty("s1", "   ", write);

    expect(write).not.toHaveBeenCalled();
  });
});
