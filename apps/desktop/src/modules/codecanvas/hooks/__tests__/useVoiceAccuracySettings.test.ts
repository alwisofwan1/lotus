import { beforeEach, describe, expect, it } from "vitest";
import {
  getVoiceAccuracySettings,
  resetVoiceAccuracyStoreForTests,
  setVoiceAccuracySettings,
} from "../useVoiceAccuracySettings";

const KEY = "lotus-voice-accuracy-v1";
const CANVAS_KEY = "canvas-voice-accuracy-v1";

describe("VoiceAccuracySettings store", () => {
  beforeEach(() => {
    localStorage.clear();
    resetVoiceAccuracyStoreForTests();
  });

  it("persists normalized personal terms, expected languages, and literal replacement rules", () => {
    setVoiceAccuracySettings({
      personalTerms: [" Lotus ", "AGENTS.md", "lotus", ""],
      expectedLanguages: ["id-ID", "en", "ID-id", "not a language"],
      replacements: [
        {
          id: "claude",
          variants: [" clod code ", "cloud code", "CLOD CODE"],
          replacement: "Claude Code",
          timing: "before-ai",
          enabled: true,
        },
      ],
    });

    expect(getVoiceAccuracySettings()).toEqual({
      personalTerms: ["Lotus", "AGENTS.md"],
      expectedLanguages: ["id-ID", "en"],
      replacements: [
        {
          id: "claude",
          variants: ["clod code", "cloud code"],
          replacement: "Claude Code",
          timing: "before-ai",
          enabled: true,
        },
      ],
    });
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(getVoiceAccuracySettings());
  });

  it("fails closed to empty settings when persisted input is malformed or unbounded", () => {
    localStorage.setItem(KEY, JSON.stringify({
      personalTerms: Array.from({ length: 400 }, (_, index) => `Term ${index}`),
      expectedLanguages: ["id", "<script>"],
      replacements: [{ id: "bad", variants: ["x".repeat(200)], replacement: "y", timing: "regex", enabled: true }],
    }));
    resetVoiceAccuracyStoreForTests();

    const settings = getVoiceAccuracySettings();
    expect(settings.personalTerms).toHaveLength(128);
    expect(settings.expectedLanguages).toEqual(["id"]);
    expect(settings.replacements).toEqual([]);
  });
  it("carries the old canvas value over to the app-level key", () => {
    localStorage.setItem(CANVAS_KEY, JSON.stringify({ personalTerms: ["Lotus"] }));
    resetVoiceAccuracyStoreForTests();
    expect(getVoiceAccuracySettings().personalTerms).toEqual(["Lotus"]);
    expect(localStorage.getItem(KEY)).toBe(localStorage.getItem(CANVAS_KEY));
  });
});
