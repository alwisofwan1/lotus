import { describe, expect, it } from "vitest";
import { CanvasHandoffStore, type HandoffArtifact } from "../canvas-handoff-store";

const artifact = (summary: string, name = "Architect"): HandoffArtifact => ({
  name,
  summary,
  sessionId: "sess_1",
});

describe("CanvasHandoffStore", () => {
  it("stores the latest artifact per node and reads it back", () => {
    const store = new CanvasHandoffStore();
    store.set("a", artifact("plan v1"));
    store.set("a", artifact("plan v2"));
    expect(store.get("a")?.summary).toBe("plan v2");
    expect(store.get("missing")).toBeUndefined();
  });

  it("clears a single node's artifact", () => {
    const store = new CanvasHandoffStore();
    store.set("a", artifact("x"));
    store.clear("a");
    expect(store.get("a")).toBeUndefined();
  });

  it("prunes artifacts for nodes not in the keep set", () => {
    const store = new CanvasHandoffStore();
    store.set("a", artifact("x"));
    store.set("b", artifact("y"));
    store.prune(["b"]);
    expect(store.get("a")).toBeUndefined();
    expect(store.get("b")?.summary).toBe("y");
  });
});
