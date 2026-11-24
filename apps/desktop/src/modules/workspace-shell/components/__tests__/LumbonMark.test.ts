import { describe, expect, it } from "vitest";
import { lumbonCells } from "../LumbonMark";

const art = (cells: boolean[], n: number) =>
  Array.from({ length: n }, (_, y) => cells.slice(y * n, y * n + n).map((on) => (on ? "#" : ".")).join(""));

describe("lumbonCells", () => {
  it("draws a 9-cell leaf: lobes on top, one cell at the tip, a blank midrib", () => {
    expect(art(lumbonCells(9), 9)).toEqual([
      "..#...#..",
      ".#.#.#.#.",
      "..#...#..",
      ".#.#.#.#.",
      ".###.###.",
      ".#.#.#.#.",
      "..#####..",
      "...###...",
      "....#....",
    ]);
  });

  it("fills in from the tip", () => {
    const half = art(lumbonCells(9, 0.5), 9);
    expect(half.slice(0, 4).join("")).not.toContain("#");
    expect(half[8]).toBe("....#....");
  });
});
