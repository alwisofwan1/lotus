import { describe, expect, it } from "vitest";
import { shuffled } from "../shuffle";

describe("shuffled", () => {
  it("produces the expected permutation for a given rng (Fisher–Yates)", () => {
    // A fixed sequence of "random" values makes the swap sequence — and therefore the
    // output — fully deterministic, so this pins the exact algorithm rather than just
    // "some shuffle happened".
    const values = [0, 0, 0]; // always picks index 0 at each step
    let i = 0;
    const rng = () => values[i++];
    expect(shuffled(["a", "b", "c", "d"], rng)).toEqual(["b", "c", "d", "a"]);
  });

  it("does not mutate the input array", () => {
    const input = ["a", "b", "c", "d"] as const;
    const copy = [...input];
    shuffled(input, () => 0.5);
    expect(input).toEqual(copy);
  });

  it("returns every element exactly once — nothing lost, nothing duplicated", () => {
    const input = ["Nara", "Bima", "Sena", "Bayu", "Aji"];
    const out = shuffled(input, Math.random);
    expect(out).toHaveLength(input.length);
    expect([...out].sort()).toEqual([...input].sort());
  });

  it("defaults to Math.random and still returns a valid permutation", () => {
    const input = ["Atlas", "Nova", "Kai"];
    const out = shuffled(input);
    expect([...out].sort()).toEqual([...input].sort());
  });

  it("handles empty and single-element pools without throwing", () => {
    expect(shuffled([])).toEqual([]);
    expect(shuffled(["only"])).toEqual(["only"]);
  });
});
