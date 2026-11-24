import { describe, expect, it } from "vitest";
import {
  deriveTaskPrefix,
  formatTaskKey,
  parseTaskKey,
  uniqueTaskPrefix,
} from "@/modules/tasks/services/task-key";

describe("deriving a project's prefix", () => {
  it("takes the first three letters of a single word, as bb's own projects do", () => {
    expect(deriveTaskPrefix("Test")).toBe("TES");
    expect(deriveTaskPrefix("lotus")).toBe("LOT");
  });

  it("takes initials when the name has several words", () => {
    // "Lotus Pocket" reads as LP; LOT would name the wrong thing.
    expect(deriveTaskPrefix("Lotus Pocket")).toBe("LP");
    expect(deriveTaskPrefix("interview-hss")).toBe("IH");
  });

  it("keeps only letters and digits, because a key has to be typeable", () => {
    expect(deriveTaskPrefix("lotus_v2!")).toBe("LV");
    expect(deriveTaskPrefix("2026-roadmap")).toBe("2R");
  });

  it("answers nothing for a name that cannot name itself", () => {
    // The caller decides what to do about a project called "🙂" — that is a question about the
    // project, not about this function.
    expect(deriveTaskPrefix("🙂")).toBe("");
    expect(deriveTaskPrefix("   ")).toBe("");
  });
});

describe("making it unique", () => {
  it("leaves a free prefix alone", () => {
    expect(uniqueTaskPrefix("lotus", ["INT", "POC"])).toBe("LOT");
  });

  it("numbers a collision rather than re-deriving it", () => {
    // `lotus` and `lotus-host`… a different set of letters would be a name nobody would guess.
    expect(uniqueTaskPrefix("lotus", ["LOT"])).toBe("LOT2");
    expect(uniqueTaskPrefix("lotus", ["LOT", "LOT2"])).toBe("LOT3");
  });

  it("compares case-insensitively — a prefix is spoken, not typed exactly", () => {
    expect(uniqueTaskPrefix("lotus", ["lot"])).toBe("LOT2");
  });
});

describe("the key itself", () => {
  it("joins prefix and number", () => {
    expect(formatTaskKey("INT", 2)).toBe("INT-2");
    expect(formatTaskKey("int", 2)).toBe("INT-2");
  });

  it("draws nothing for a task that has no number yet", () => {
    // Tasks written before the store numbered them. `INT-?` would assert a key nobody can type.
    expect(formatTaskKey("INT", undefined)).toBeNull();
    expect(formatTaskKey("INT", 0)).toBeNull();
    expect(formatTaskKey("INT", 1.5)).toBeNull();
    expect(formatTaskKey("", 2)).toBeNull();
  });

  it("reads back what it wrote, whatever case it arrives in", () => {
    expect(parseTaskKey("INT-2")).toEqual({ prefix: "INT", number: 2 });
    expect(parseTaskKey("  int-2 ")).toEqual({ prefix: "INT", number: 2 });
  });

  it("refuses what is not a key", () => {
    expect(parseTaskKey("INT")).toBeNull();
    expect(parseTaskKey("INT-0")).toBeNull();
    expect(parseTaskKey("INT-2-3")).toBeNull();
    expect(parseTaskKey("a task about INT-2")).toBeNull();
  });
});
