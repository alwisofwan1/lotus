import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RoughNodeBorder } from "../RoughNodeBorder";

describe("RoughNodeBorder", () => {
  it("renders an svg with hand-drawn path(s) for the given size", () => {
    const { container } = render(<RoughNodeBorder width={200} height={120} seed={42} />);
    expect(container.querySelector("svg")).toBeTruthy();
    const paths = container.querySelectorAll("path");
    expect(paths.length).toBeGreaterThan(0);
    expect(paths[0].getAttribute("d")).toBeTruthy();
  });

  it("produces a stable path for the same seed + size (deterministic wobble)", () => {
    const a = render(<RoughNodeBorder width={200} height={120} seed={7} />);
    const da = a.container.querySelector("path")?.getAttribute("d");
    const b = render(<RoughNodeBorder width={200} height={120} seed={7} />);
    const db = b.container.querySelector("path")?.getAttribute("d");
    expect(db).toBe(da);
  });

  it("renders nothing renderable when size is not measured yet", () => {
    const { container } = render(<RoughNodeBorder width={0} height={0} seed={1} />);
    expect(container.querySelectorAll("path").length).toBe(0);
  });
});
