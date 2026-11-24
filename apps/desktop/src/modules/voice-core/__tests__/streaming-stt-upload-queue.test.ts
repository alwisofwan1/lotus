import { describe, expect, it, vi } from "vitest";
import { createStreamingSttUploadQueue } from "../streaming-stt-upload-queue";

function deferred() {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), resolve };
}

describe("StreamingSttUploadQueue", () => {
  it("serializes uploads and fails closed when active plus pending chunks reach the cap", async () => {
    const first = deferred();
    const sent: string[] = [];
    const onFailure = vi.fn();
    const queue = createStreamingSttUploadQueue({
      maxPending: 2,
      send: async (chunk) => {
        sent.push(chunk);
        if (chunk === "first") await first.promise;
      },
      onFailure,
    });

    expect(queue.enqueue("first")).toBe(true);
    expect(queue.enqueue("second")).toBe(true);
    expect(queue.enqueue("overflow")).toBe(false);
    expect(sent).toEqual(["first"]);
    await expect(queue.flush()).rejects.toThrow(/queue.*full/i);
    expect(onFailure).toHaveBeenCalledTimes(1);

    first.resolve();
    await Promise.resolve();
    expect(sent).toEqual(["first"]);
  });

  it("surfaces a send failure through flush and stops later chunks", async () => {
    const send = vi.fn(async (chunk: string) => {
      if (chunk === "broken") throw new Error("IPC unavailable");
    });
    const queue = createStreamingSttUploadQueue({ maxPending: 3, send });

    queue.enqueue("broken");
    queue.enqueue("later");

    await expect(queue.flush()).rejects.toThrow(/audio upload failed/i);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
