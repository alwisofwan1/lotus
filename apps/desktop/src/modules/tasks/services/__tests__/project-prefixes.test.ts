import { describe, expect, it } from "vitest";
import { assignProjectPrefixes } from "@/modules/tasks/services/project-prefixes";

describe("assigning project prefixes", () => {
  it("derives one for a project it has never seen", () => {
    const { prefixes, changed } = assignProjectPrefixes([{ id: "w1", name: "Test" }], {});
    expect(prefixes).toEqual({ w1: "TES" });
    expect(changed).toBe(true);
  });

  it("never re-derives one it already gave out", () => {
    // The folder was renamed. `IH-2` is written in a commit message somewhere; it must still
    // point at the same task.
    const { prefixes, changed } = assignProjectPrefixes(
      [{ id: "w1", name: "interviews" }],
      { w1: "IH" },
    );
    expect(prefixes).toEqual({ w1: "IH" });
    expect(changed).toBe(false);
  });

  it("avoids a prefix held by a project that is not open right now", () => {
    // A closed workspace can be reopened, and the keys it handed out are still written down.
    const { prefixes } = assignProjectPrefixes(
      [{ id: "w2", name: "lotus" }],
      { "w-closed": "LOT" },
    );
    expect(prefixes.w2).toBe("LOT2");
  });

  it("is order-stable, so two windows agree on what LOT2 means", () => {
    const projects = [
      { id: "a", name: "lotus" },
      { id: "b", name: "lotus-host" },
    ];
    const first = assignProjectPrefixes(projects, {}).prefixes;
    const again = assignProjectPrefixes(projects, {}).prefixes;
    expect(first).toEqual(again);
    expect(first.a).toBe("LOT");
    expect(first.b).toBe("LH");
  });

  it("leaves a project that cannot name itself without one", () => {
    const { prefixes, changed } = assignProjectPrefixes([{ id: "w1", name: "🙂" }], {});
    expect(prefixes).toEqual({});
    expect(changed).toBe(false);
  });
});
