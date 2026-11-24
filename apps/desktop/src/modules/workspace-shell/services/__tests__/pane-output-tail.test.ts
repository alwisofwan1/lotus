import { describe, expect, it } from "vitest";
import { createPaneOutputTail } from "../pane-output-tail";

describe("pane output tail", () => {
  it("keeps the most recent output of each pane, up to its limit", () => {
    const tail = createPaneOutputTail(10);
    tail.append("p1", "hello ");
    tail.append("p1", "world, again");
    tail.append("p2", "other");
    expect(tail.read("p1")).toBe("rld, again");
    expect(tail.read("p2")).toBe("other");
    expect(tail.read("p3")).toBeNull();
  });

  it("forgets a pane that closed", () => {
    const tail = createPaneOutputTail();
    tail.append("p1", "x");
    tail.retain(new Set(["p2"]));
    expect(tail.read("p1")).toBeNull();
  });
});
