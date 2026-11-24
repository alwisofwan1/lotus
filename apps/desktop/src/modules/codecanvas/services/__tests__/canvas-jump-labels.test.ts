import { describe, expect, it } from "vitest";
import {
  assignJumpLabels,
  JUMP_LABEL_ALPHABET,
  matchJumpLabel,
  onScreenNodeIds,
} from "../canvas-jump-labels";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `n${i}`);

describe("assignJumpLabels", () => {
  it("gives one letter per cell while they fit", () => {
    const labels = assignJumpLabels(["a1", "a2", "a3"]);

    expect([...labels.keys()]).toEqual(["a", "s", "d"]);
    expect(labels.get("a")).toBe("a1");
  });

  it("keeps the board's own order, so the labels read down the screen", () => {
    // The caller passes reading order. Sorting here would make the same node take a different letter
    // depending on where it happens to sit, which is the one thing a jump label must not do.
    const labels = assignJumpLabels(["z", "y", "x"]);

    expect([...labels.values()]).toEqual(["z", "y", "x"]);
  });

  it("widens every label at once when one letter is not enough", () => {
    // Uniform width is a correctness requirement, not tidiness. With "a" and "as" both live, typing
    // "a" is ambiguous — the caller cannot tell a hit from a prefix, so it either jumps too early or
    // never jumps at all.
    const labels = assignJumpLabels(ids(JUMP_LABEL_ALPHABET.length + 1));

    expect([...labels.keys()].every((label) => label.length === 2)).toBe(true);
  });

  it("widens again rather than dropping cells off the end", () => {
    const n = JUMP_LABEL_ALPHABET.length ** 2 + 1;

    const labels = assignJumpLabels(ids(n));

    expect(labels.size).toBe(n);
    expect([...labels.keys()].every((label) => label.length === 3)).toBe(true);
  });

  it("never repeats a label", () => {
    const labels = assignJumpLabels(ids(40));

    expect(new Set(labels.keys()).size).toBe(40);
  });

  it("returns nothing for an empty board", () => {
    expect(assignJumpLabels([]).size).toBe(0);
  });

  it("uses only home-row letters, which is why the tool shortcuts have to be suppressed", () => {
    // Several of these letters ARE tool shortcuts (`a` arrow, `d` diamond, `l` line). That is fine
    // only because the mode captures keys while it is open; the alphabet is chosen for the fingers,
    // not to dodge collisions it cannot dodge anyway.
    const labels = assignJumpLabels(ids(9));

    expect([...labels.keys()].join("")).toBe(JUMP_LABEL_ALPHABET);
  });
});

describe("matchJumpLabel", () => {
  const labels = assignJumpLabels(["a1", "a2", "a3"]);

  it("hits on a complete label", () => {
    expect(matchJumpLabel(labels, "s")).toEqual({ kind: "hit", nodeId: "a2" });
  });

  it("waits while the typing could still become a label", () => {
    const wide = assignJumpLabels(ids(20));

    expect(matchJumpLabel(wide, "a")).toEqual({ kind: "pending" });
  });

  it("misses on a key no label starts with", () => {
    expect(matchJumpLabel(labels, "q")).toEqual({ kind: "miss" });
  });

  it("misses once the typing is longer than any label", () => {
    expect(matchJumpLabel(labels, "sd")).toEqual({ kind: "miss" });
  });

  it("is case-insensitive, because Caps Lock is not a decision", () => {
    expect(matchJumpLabel(labels, "S")).toEqual({ kind: "hit", nodeId: "a2" });
  });

  it("treats nothing typed as still waiting", () => {
    expect(matchJumpLabel(labels, "")).toEqual({ kind: "pending" });
  });

  it("misses on an empty label set rather than claiming a hit", () => {
    expect(matchJumpLabel(new Map(), "a")).toEqual({ kind: "miss" });
  });
});

describe("onScreenNodeIds", () => {
  const SCREEN = { width: 1000, height: 800 };
  const box = (left: number, top: number, w = 200, h = 150) =>
    ({ left, top, right: left + w, bottom: top + h });

  it("keeps a cell inside the frame", () => {
    expect(onScreenNodeIds([{ id: "a", box: box(100, 100) }], SCREEN)).toEqual(["a"]);
  });

  it("drops a cell parked off to the side", () => {
    // The reason this function exists: the alphabet is scarce, and cells the operator cannot see were
    // spending single letters — pushing the visible ones to two-letter labels for nothing, and
    // putting badges outside the frame for cells nobody could aim at.
    expect(onScreenNodeIds([{ id: "far", box: box(5000, 100) }], SCREEN)).toEqual([]);
  });

  it("keeps a cell hanging half off the edge", () => {
    // Intersection, not containment. Half a terminal is still something you can see and aim at.
    expect(onScreenNodeIds([{ id: "half", box: box(-100, 100) }], SCREEN)).toEqual(["half"]);
  });

  it("drops one that only touches the edge, because a zero-width sliver is not visible", () => {
    expect(onScreenNodeIds([{ id: "edge", box: box(1000, 100) }], SCREEN)).toEqual([]);
  });

  it("checks above and below too, not just left and right", () => {
    const ids = onScreenNodeIds(
      [
        { id: "above", box: box(100, -400) },
        { id: "mid", box: box(100, 300) },
        { id: "below", box: box(100, 3000) },
      ],
      SCREEN,
    );

    expect(ids).toEqual(["mid"]);
  });

  it("keeps the caller's order, so the labels still read down the screen", () => {
    const ids = onScreenNodeIds(
      [
        { id: "second", box: box(400, 100) },
        { id: "first", box: box(100, 100) },
      ],
      SCREEN,
    );

    expect(ids).toEqual(["second", "first"]);
  });

  it("returns nothing when the board is empty", () => {
    expect(onScreenNodeIds([], SCREEN)).toEqual([]);
  });
});

