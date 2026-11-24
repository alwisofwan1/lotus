import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPtySubmitQueue } from "../pty-submit-queue";

describe("createPtySubmitQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves a submission only after Enter is written", async () => {
    const writes: string[] = [];
    const queue = createPtySubmitQueue({ write: (data) => { writes.push(data); }, enterDelayMs: 300 });

    const completion = Promise.resolve(queue.submit("hello agent"));
    let settled = false;
    void completion.then(() => { settled = true; });
    await Promise.resolve();
    expect(writes).toEqual(["hello agent"]);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(299);
    expect(writes).toEqual(["hello agent"]);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(writes).toEqual(["hello agent", "\r"]);
    await expect(completion).resolves.toBeUndefined();
  });

  it("waits for asynchronous paste and Enter write acknowledgements", async () => {
    const writes: string[] = [];
    const acknowledgements: Array<() => void> = [];
    const queue = createPtySubmitQueue({
      write: (data) => {
        writes.push(data);
        return new Promise<void>((resolve) => { acknowledgements.push(resolve); });
      },
      enterDelayMs: 300,
    });

    const completion = queue.submit("confirmed task");
    await vi.advanceTimersByTimeAsync(300);
    expect(writes).toEqual(["confirmed task"]);

    acknowledgements.shift()?.();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(300);
    expect(writes).toEqual(["confirmed task", "\r"]);

    let settled = false;
    void completion.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    acknowledgements.shift()?.();
    await expect(completion).resolves.toBeUndefined();
  });

  it("serializes two rapid submits so each message gets its own Enter, in order", () => {
    const writes: string[] = [];
    const queue = createPtySubmitQueue({ write: (data) => { writes.push(data); }, enterDelayMs: 300 });

    queue.submit("first task");
    queue.submit("second task");
    // Second paste must NOT land in the prompt while the first Enter is still pending.
    expect(writes).toEqual(["first task"]);

    vi.advanceTimersByTime(300);
    expect(writes).toEqual(["first task", "\r", "second task"]);

    vi.advanceTimersByTime(300);
    expect(writes).toEqual(["first task", "\r", "second task", "\r"]);
  });

  it("rejects a failed PTY write without wedging later submissions", async () => {
    const writes: string[] = [];
    let failNextWrite = true;
    const queue = createPtySubmitQueue({
      write: (data) => {
        if (failNextWrite) {
          failNextWrite = false;
          throw new Error("PTY closed");
        }
        writes.push(data);
      },
      enterDelayMs: 300,
    });

    await expect(queue.submit("first")).rejects.toThrow("PTY closed");
    const second = queue.submit("second");
    expect(writes).toEqual(["second"]);
    await vi.advanceTimersByTimeAsync(300);
    await expect(second).resolves.toBeUndefined();
  });

  it("dispose cancels writes and rejects in-flight plus queued receipts", async () => {
    const writes: string[] = [];
    const queue = createPtySubmitQueue({ write: (data) => { writes.push(data); }, enterDelayMs: 300 });

    const active = queue.submit("in flight");
    const queued = queue.submit("queued");
    const outcomes: string[] = [];
    void active.catch(() => { outcomes.push("active-rejected"); });
    void queued.catch(() => { outcomes.push("queued-rejected"); });
    queue.dispose();
    await Promise.resolve();
    await expect(queue.submit("after dispose")).rejects.toThrow(/cancelled|disposed/i);

    await vi.advanceTimersByTimeAsync(1000);
    expect(writes).toEqual(["in flight"]);
    expect(outcomes).toEqual(["active-rejected", "queued-rejected"]);
  });
});
