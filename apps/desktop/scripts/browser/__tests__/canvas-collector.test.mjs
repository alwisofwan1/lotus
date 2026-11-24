// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "canvas-collector.js"), "utf8");

// A mutable fetch impl so tests can drive success/failure through the collector's wrap.
let fetchImpl = async () => ({ status: 200, ok: true });

function loadCollector() {
  // eslint-disable-next-line no-eval
  (0, eval)(source);
  return globalThis.__lotusCollector;
}

/** Drain only entries newer than `since` so each test asserts its own delta. */
function drainSince(since, opts = {}) {
  return globalThis.__lotusCollector.drain("req", { since, ...opts });
}

describe("canvas-collector", () => {
  beforeAll(() => {
    globalThis.fetch = (...args) => fetchImpl(...args);
    loadCollector();
  });

  it("captures console output with level and text", () => {
    const before = globalThis.__lotusCollector.drain("b").maxSeq;
    console.warn("heads up", 42);
    const { entries } = drainSince(before, { kinds: ["console"] });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "console", level: "warn", text: "heads up 42" });
  });

  it("redacts secrets in console text", () => {
    const before = globalThis.__lotusCollector.drain("b").maxSeq;
    console.log("token=abcdef123456 done");
    const { entries } = drainSince(before, { kinds: ["console"] });
    expect(entries[0].text).toContain("[REDACTED]");
    expect(entries[0].text).not.toContain("abcdef123456");
  });

  it("captures an uncaught window error", () => {
    const before = globalThis.__lotusCollector.drain("b").maxSeq;
    const event = new Event("error");
    event.message = "boom";
    event.error = new Error("boom");
    window.dispatchEvent(event);
    const { entries } = drainSince(before, { kinds: ["error"] });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "error", message: "boom" });
  });

  it("captures fetch success and failure with status/ok", async () => {
    const before = globalThis.__lotusCollector.drain("b").maxSeq;
    fetchImpl = async () => ({ status: 200, ok: true });
    await globalThis.fetch("/api/ok", { method: "GET" });
    fetchImpl = async () => {
      throw new Error("network down");
    };
    await globalThis.fetch("/api/bad", { method: "POST" }).catch(() => {});
    const { entries } = drainSince(before, { kinds: ["network"] });
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ method: "GET", url: "/api/ok", status: 200, ok: true });
    expect(entries[1]).toMatchObject({ method: "POST", url: "/api/bad", status: 0, ok: false });
    expect(entries[1].errorText).toContain("network down");
  });

  it("filters by kind and reports counts", () => {
    const before = globalThis.__lotusCollector.drain("b").maxSeq;
    console.error("bad thing");
    console.log("info thing");
    const errorsOnly = drainSince(before, { kinds: ["error", "console"] });
    // both console entries are kind:"console"; the error() is level:"error" not kind:"error"
    expect(errorsOnly.counts.console).toBe(2);
  });

  it("supports `since` paging (non-consuming)", () => {
    const first = globalThis.__lotusCollector.drain("a");
    console.log("newer line");
    const second = globalThis.__lotusCollector.drain("b", { since: first.maxSeq });
    expect(second.entries.every((e) => e.seq > first.maxSeq)).toBe(true);
    expect(second.entries.some((e) => e.text === "newer line")).toBe(true);
  });

  it("is idempotent — re-injecting does not double-wrap console", () => {
    loadCollector(); // second inject is a no-op
    const before = globalThis.__lotusCollector.drain("b").maxSeq;
    console.log("once");
    const { entries } = drainSince(before, { kinds: ["console"] });
    expect(entries).toHaveLength(1);
  });
});
