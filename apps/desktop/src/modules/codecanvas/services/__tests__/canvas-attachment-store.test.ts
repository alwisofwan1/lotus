import { describe, expect, it, vi } from "vitest";
import { CanvasAttachmentStore } from "../canvas-attachment-store";
import type { CanvasImageRef } from "../canvas-intake";

const a: CanvasImageRef = { kind: "path", path: "/a.png" };
const b: CanvasImageRef = { kind: "bytes", name: "b.png", mime: "image/png", base64: "AA" };

describe("CanvasAttachmentStore", () => {
  it("accumulates refs per node and lists them", () => {
    const store = new CanvasAttachmentStore();
    store.add("n1", [a]);
    store.add("n1", [b]);
    store.add("n2", [a]);
    expect(store.list("n1")).toEqual([a, b]);
    expect(store.list("n2")).toEqual([a]);
    expect(store.list("missing")).toEqual([]);
  });

  it("ignores empty adds and out-of-range removes", () => {
    const store = new CanvasAttachmentStore();
    store.add("n1", []);
    expect(store.list("n1")).toEqual([]);
    store.add("n1", [a, b]);
    store.removeAt("n1", 5);
    expect(store.list("n1")).toEqual([a, b]);
    store.removeAt("n1", 0);
    expect(store.list("n1")).toEqual([b]);
  });

  it("clears a node and prunes nodes not in the keep set", () => {
    const store = new CanvasAttachmentStore();
    store.add("n1", [a]);
    store.add("n2", [b]);
    store.clear("n1");
    expect(store.list("n1")).toEqual([]);
    store.add("n3", [a]);
    store.prune(["n2"]);
    expect(store.list("n2")).toEqual([b]);
    expect(store.list("n3")).toEqual([]);
  });

  it("notifies subscribers of a node on change and stops after unsubscribe", () => {
    const store = new CanvasAttachmentStore();
    const seen: CanvasImageRef[][] = [];
    const off = store.subscribe("n1", (refs) => seen.push(refs));
    store.add("n1", [a]);
    store.add("n2", [b]); // different node — no notification
    off();
    store.add("n1", [b]);
    expect(seen).toEqual([[a]]);
  });

  it("does not fire a node's listener for unrelated nodes", () => {
    const store = new CanvasAttachmentStore();
    const listener = vi.fn();
    store.subscribe("n1", listener);
    store.add("n2", [a]);
    expect(listener).not.toHaveBeenCalled();
  });
});
