import { describe, expect, it } from "vitest";
import { DICTATION_MODES, DEFAULT_DICTATION_MODE, resolveDictationMode } from "../dictation-mode";

describe("dictation modes", () => {
  it("default is clean and adds no formatting lines", () => {
    expect(DEFAULT_DICTATION_MODE).toBe("clean");
    expect(DICTATION_MODES.clean.promptLines).toEqual([]);
  });

  it("note + commit each contribute a formatting instruction", () => {
    expect(DICTATION_MODES.note.promptLines.join(" ").toLowerCase()).toMatch(/bullet|paragraph|notes/);
    expect(DICTATION_MODES.commit.promptLines.join(" ").toLowerCase()).toContain("commit");
  });

  it("resolveDictationMode falls back to clean for unknown/undefined ids", () => {
    expect(resolveDictationMode(undefined).id).toBe("clean");
    expect(resolveDictationMode("bogus").id).toBe("clean");
    expect(resolveDictationMode("commit").id).toBe("commit");
  });
});
