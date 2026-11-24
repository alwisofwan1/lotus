import { describe, expect, it } from "vitest";
import { reorderItemsByDropPosition } from "../workspace-order";

describe("reorderItemsByDropPosition", () => {
  const items = [
    { id: "a", label: "one" },
    { id: "b", label: "two" },
    { id: "c", label: "three" },
    { id: "d", label: "four" },
  ];

  it("moves an item before the target", () => {
    expect(reorderItemsByDropPosition(items, "d", "b", "before").map((item) => item.id)).toEqual(["a", "d", "b", "c"]);
  });

  it("moves an item after the target", () => {
    expect(reorderItemsByDropPosition(items, "a", "c", "after").map((item) => item.id)).toEqual(["b", "c", "a", "d"]);
  });

  it("returns a shallow copy when drag and target are the same", () => {
    const result = reorderItemsByDropPosition(items, "b", "b", "before");
    expect(result).toEqual(items);
    expect(result).not.toBe(items);
  });

  it("returns a shallow copy when ids are missing", () => {
    const result = reorderItemsByDropPosition(items, "x", "b", "before");
    expect(result).toEqual(items);
    expect(result).not.toBe(items);
  });
});
