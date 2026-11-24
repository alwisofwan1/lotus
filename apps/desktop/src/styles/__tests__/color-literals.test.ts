import { describe, expect, it } from "vitest";
import { compareToBaseline, countColorLiterals } from "./color-literals";

describe("countColorLiterals", () => {
  it("counts hex literals of 3, 4, 6 and 8 digits", () => {
    expect(countColorLiterals("a{color:#fff;background:#ffff;border-color:#a1b2c3;fill:#a1b2c3d4}").count).toBe(4);
  });

  it("does not count hex runs of other lengths or id selectors that are not hex", () => {
    expect(countColorLiterals("#app{} #12345{} #1234567{} .x{color:#ab}").count).toBe(0);
  });

  it("counts rgb, rgba, hsl and hsla calls, any case", () => {
    expect(
      countColorLiterals("a{color:rgb(0 0 0);b:RGBA(0,0,0,.5);c:hsl(10 20% 30%);d:hsla(1,2%,3%,.4)}").count,
    ).toBe(4);
  });

  it("counts every literal on a line, including those inside var() fallbacks and gradients", () => {
    expect(countColorLiterals("a{background:linear-gradient(#000, rgba(0,0,0,0)) var(--x, #fff)}").count).toBe(3);
  });

  it("does not count literals inside comments", () => {
    expect(countColorLiterals("/* was #fff */\na{color:var(--fg)} /* rgb(0 0 0)\n#000 */").count).toBe(0);
  });

  it("exempts a line carrying the marker with a reason", () => {
    const result = countColorLiterals(
      "a{color:#e5484d} /* color-literal-ok: status red is identical in both themes */\nb{color:#000}",
    );
    expect(result.count).toBe(1);
    expect(result.exempted).toBe(1);
  });

  it("reports a marker with no reason and does not exempt that line", () => {
    const result = countColorLiterals("a{color:#e5484d} /* color-literal-ok: */");
    expect(result.count).toBe(1);
    expect(result.markersWithoutReason).toEqual([1]);
  });

  it("exempts the line a marker comment opens on when the comment runs onto further lines", () => {
    const result = countColorLiterals("a{color:#e5484d} /* color-literal-ok: status red,\n   identical in both themes */\nb{color:#000}");
    expect(result).toEqual({ count: 1, exempted: 1, markersWithoutReason: [] });
  });

  it("takes the reason from a later line of the marker comment", () => {
    const result = countColorLiterals("a{color:#e5484d} /* color-literal-ok:\n   status red */");
    expect(result).toEqual({ count: 0, exempted: 1, markersWithoutReason: [] });
  });

  it("reports a multi-line marker with no reason at the line it opens on", () => {
    const result = countColorLiterals("a{color:#e5484d}\nb{color:#000} /* color-literal-ok:\n */");
    expect(result).toEqual({ count: 2, exempted: 0, markersWithoutReason: [2] });
  });

  it("treats the marker as a marker only when it opens its comment", () => {
    const result = countColorLiterals("/* legacy palette,\n   color-literal-ok: kept */ a{color:#000}");
    expect(result).toEqual({ count: 1, exempted: 0, markersWithoutReason: [] });
  });
});

describe("compareToBaseline", () => {
  it("passes when every file matches its baseline", () => {
    expect(compareToBaseline({ "a.css": 3, "b.css": 0 }, { "a.css": 3 })).toEqual([]);
  });

  it("names the file and the delta when a file gains literals", () => {
    expect(compareToBaseline({ "a.css": 5 }, { "a.css": 3 })).toEqual([
      "a.css: 5 colour literals, baseline 3 (+2). Use a token, or exempt the line with a reason.",
    ]);
  });

  it("treats a file missing from the baseline as a budget of zero", () => {
    expect(compareToBaseline({ "new.css": 1 }, {})).toEqual([
      "new.css: 1 colour literals, baseline 0 (+1). Use a token, or exempt the line with a reason.",
    ]);
  });

  it("asks for the baseline to be lowered when a file drops below it", () => {
    expect(compareToBaseline({ "a.css": 1 }, { "a.css": 3 })).toEqual([
      "a.css: 1 colour literals, baseline 3 (-2). Lower the baseline to 1 in this commit.",
    ]);
  });

  it("reports a baseline entry whose file no longer exists", () => {
    expect(compareToBaseline({}, { "gone.css": 2 })).toEqual([
      "gone.css: in the baseline but not found. Remove the entry.",
    ]);
  });
});
