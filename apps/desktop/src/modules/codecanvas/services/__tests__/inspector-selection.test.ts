import { describe, expect, it } from "vitest";
import { sharedShapeStyle, selectionSections } from "../inspector-selection";

describe("sharedShapeStyle", () => {
  it("keeps fields shared by all shapes and marks differing ones as mixed", () => {
    const { shared, mixed } = sharedShapeStyle([
      { strokeColor: "#fff", opacity: 50 },
      { strokeColor: "#fff", opacity: 80 },
    ]);
    expect(shared).toEqual({ strokeColor: "#fff" });
    expect(mixed.has("opacity")).toBe(true);
    expect(mixed.has("strokeColor")).toBe(false);
  });

  it("treats a field present on some shapes but absent on others as mixed", () => {
    const { shared, mixed } = sharedShapeStyle([undefined, { strokeColor: "#fff" }]);
    expect(shared).toEqual({});
    expect(mixed.has("strokeColor")).toBe(true);
  });

  it("returns the lone style unchanged with no mixed fields for a single shape", () => {
    const { shared, mixed } = sharedShapeStyle([{ strokeColor: "#fff", opacity: 50 }]);
    expect(shared).toEqual({ strokeColor: "#fff", opacity: 50 });
    expect(mixed.size).toBe(0);
  });
});

describe("selectionSections", () => {
  it("drops the per-shape label section once more than one shape is selected", () => {
    expect(selectionSections(["rectangle", "rectangle"])).not.toContain("label");
  });

  it("intersects sections across mixed kinds — drops Background + Sloppiness (text has neither) but keeps shared text controls", () => {
    const secs = selectionSections(["rectangle", "text"]);
    expect(secs).toEqual(["stroke", "font", "size", "opacity", "arrange"]);
  });

  it("keeps text-only sections when every selected shape is text", () => {
    expect(selectionSections(["text", "text"])).toContain("font");
    expect(selectionSections(["text", "text"])).toContain("size");
  });
});
