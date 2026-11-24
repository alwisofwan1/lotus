import { describe, it, expect } from "vitest";
import { KeyedMutex } from "../keyed-mutex.js";

/** Resolves after a microtask turn so interleaving is observable. */
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe("KeyedMutex", () => {
  it("serializes operations sharing a key (no interleaving)", async () => {
    const mutex = new KeyedMutex();
    const log: string[] = [];

    const a = mutex.run("k", async () => {
      log.push("a:start");
      await tick();
      log.push("a:end");
    });
    const b = mutex.run("k", async () => {
      log.push("b:start");
      await tick();
      log.push("b:end");
    });

    await Promise.all([a, b]);
    expect(log).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("runs operations on different keys concurrently", async () => {
    const mutex = new KeyedMutex();
    const log: string[] = [];

    const a = mutex.run("k1", async () => { log.push("a:start"); await tick(); log.push("a:end"); });
    const b = mutex.run("k2", async () => { log.push("b:start"); await tick(); log.push("b:end"); });

    await Promise.all([a, b]);
    expect(log.slice(0, 2)).toEqual(["a:start", "b:start"]); // both started before either ended
  });

  it("returns the operation's resolved value to its caller", async () => {
    const mutex = new KeyedMutex();
    await expect(mutex.run("k", async () => 42)).resolves.toBe(42);
  });

  it("propagates a rejection without poisoning the lock for the next op", async () => {
    const mutex = new KeyedMutex();
    await expect(mutex.run("k", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(mutex.run("k", async () => "recovered")).resolves.toBe("recovered");
  });

  it("releases the key when idle so the internal map does not grow unbounded", async () => {
    const mutex = new KeyedMutex();
    await mutex.run("k", async () => undefined);
    await tick();
    expect(mutex.activeKeyCount()).toBe(0);
  });
});
