import { describe, it, expect } from "vitest";
import { shouldTidyOnMutation } from "../canvas-tidy-trigger";

const mode = (tidyMode: "off" | "notes" | "open" | "open-close") => ({ tidyMode });

describe("shouldTidyOnMutation", () => {
  it("off never tidies", () => {
    for (const kind of ["open", "close"] as const) for (const note of [true, false]) expect(shouldTidyOnMutation(kind, note, mode("off"))).toBe(false);
  });

  it("notes tidies only note mutations", () => {
    expect(shouldTidyOnMutation("open", true, mode("notes"))).toBe(true);
    expect(shouldTidyOnMutation("close", true, mode("notes"))).toBe(true);
    expect(shouldTidyOnMutation("open", false, mode("notes"))).toBe(false);
  });

  it("open tidies every open, and a note close", () => {
    expect(shouldTidyOnMutation("open", false, mode("open"))).toBe(true);
    expect(shouldTidyOnMutation("close", false, mode("open"))).toBe(false);
    expect(shouldTidyOnMutation("close", true, mode("open"))).toBe(true);
  });

  it("open-close tidies everything", () => {
    expect(shouldTidyOnMutation("open", false, mode("open-close"))).toBe(true);
    expect(shouldTidyOnMutation("close", false, mode("open-close"))).toBe(true);
  });
});
