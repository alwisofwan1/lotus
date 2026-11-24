import { describe, expect, it } from "vitest";
import { scrollEdges } from "../inspector-scroll";

describe("scrollEdges", () => {
  it("reports no fades when the content fits (no overflow)", () => {
    expect(scrollEdges({ scrollTop: 0, scrollHeight: 300, clientHeight: 300 })).toEqual({ up: false, down: false });
  });

  it("fades the bottom when scrolled to the top of overflowing content", () => {
    expect(scrollEdges({ scrollTop: 0, scrollHeight: 600, clientHeight: 300 })).toEqual({ up: false, down: true });
  });

  it("fades both edges in the middle", () => {
    expect(scrollEdges({ scrollTop: 150, scrollHeight: 600, clientHeight: 300 })).toEqual({ up: true, down: true });
  });

  it("fades only the top at the bottom of the scroll", () => {
    expect(scrollEdges({ scrollTop: 300, scrollHeight: 600, clientHeight: 300 })).toEqual({ up: true, down: false });
  });
});
