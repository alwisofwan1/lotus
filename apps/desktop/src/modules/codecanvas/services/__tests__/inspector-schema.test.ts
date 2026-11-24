import { describe, expect, it } from "vitest";
import { inspectorSectionsFor } from "../inspector-schema";

describe("inspectorSectionsFor", () => {
  it("shows Background only for container shapes", () => {
    for (const k of ["rectangle", "diamond", "ellipse"] as const) {
      expect(inspectorSectionsFor(k)).toContain("background");
    }
    expect(inspectorSectionsFor("text")).not.toContain("background");
    expect(inspectorSectionsFor("arrow")).not.toContain("background");
    expect(inspectorSectionsFor("line")).not.toContain("background");
  });

  it("omits stroke width / stroke style for the text shape", () => {
    const text = inspectorSectionsFor("text");
    expect(text).not.toContain("strokeWidth");
    expect(text).not.toContain("strokeStyle");
  });

  it("shows Arrow type for both linear kinds, but Arrowheads only for arrow", () => {
    expect(inspectorSectionsFor("arrow")).toContain("arrowType");
    expect(inspectorSectionsFor("arrow")).toContain("arrowheads");
    expect(inspectorSectionsFor("line")).toContain("arrowType");
    expect(inspectorSectionsFor("line")).not.toContain("arrowheads");
    expect(inspectorSectionsFor("rectangle")).not.toContain("arrowType");
  });

  it("orders Arrow type then Arrowheads after Sloppiness and before Opacity (arrow)", () => {
    const a = inspectorSectionsFor("arrow");
    expect(a.indexOf("arrowType")).toBeGreaterThan(a.indexOf("sloppiness"));
    expect(a.indexOf("arrowheads")).toBe(a.indexOf("arrowType") + 1);
    expect(a.indexOf("opacity")).toBeGreaterThan(a.indexOf("arrowheads"));
  });

  it("omits the label section for linear shapes but keeps it for others", () => {
    expect(inspectorSectionsFor("line")).not.toContain("label");
    expect(inspectorSectionsFor("arrow")).not.toContain("label");
    expect(inspectorSectionsFor("rectangle")).toContain("label");
    expect(inspectorSectionsFor("text")).toContain("label");
  });

  it("shows Font + Size for shapes that hold text (text + containers), not linear", () => {
    for (const k of ["text", "rectangle", "diamond", "ellipse"] as const) {
      expect(inspectorSectionsFor(k)).toContain("font");
      expect(inspectorSectionsFor(k)).toContain("size");
    }
    expect(inspectorSectionsFor("arrow")).not.toContain("font");
    expect(inspectorSectionsFor("line")).not.toContain("size");
  });

  it("orders Font then Size before Opacity", () => {
    for (const k of ["text", "rectangle"] as const) {
      const secs = inspectorSectionsFor(k);
      expect(secs.indexOf("size")).toBe(secs.indexOf("font") + 1);
      expect(secs.indexOf("opacity")).toBeGreaterThan(secs.indexOf("size"));
    }
  });

  it("omits Sloppiness for the text shape (it has no hand-drawn geometry to roughen)", () => {
    expect(inspectorSectionsFor("text")).not.toContain("sloppiness");
    expect(inspectorSectionsFor("rectangle")).toContain("sloppiness");
  });

  it("gives the freehand draw shape stroke controls but no arrow type, label, or font", () => {
    const d = inspectorSectionsFor("draw");
    expect(d).toEqual(["stroke", "strokeWidth", "strokeStyle", "sloppiness", "opacity", "arrange"]);
  });

  it("gives an image shape only Opacity + Arrange (a bitmap has no stroke/fill/text)", () => {
    const img = inspectorSectionsFor("image");
    expect(img).toEqual(["opacity", "arrange"]);
    expect(img).not.toContain("stroke");
    expect(img).not.toContain("background");
    expect(img).not.toContain("font");
  });

  it("always ends with Arrange and includes Stroke + Opacity for every kind", () => {
    for (const k of ["rectangle", "diamond", "ellipse", "text", "arrow", "line"] as const) {
      const secs = inspectorSectionsFor(k);
      expect(secs).toContain("stroke");
      expect(secs).toContain("opacity");
      expect(secs[secs.length - 1]).toBe("arrange");
    }
  });
});
