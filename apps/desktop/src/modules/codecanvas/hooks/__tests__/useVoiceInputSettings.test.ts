import { describe, it, expect, beforeEach } from "vitest";
import { getVoiceInputSettings, setVoiceInputSetting, resetVoiceInputStoreForTests } from "../useVoiceInputSettings";
import { DEFAULT_VOICE_INPUT } from "@/modules/codecanvas/services/voice/voice-mode";

const KEY = "lotus-voice-input-v1";
const CANVAS_KEY = "canvas-voice-input-v1";

describe("useVoiceInputSettings store", () => {
  beforeEach(() => {
    localStorage.clear();
    resetVoiceInputStoreForTests();
  });

  it("defaults to auto-submit, polish on, clean dictation mode", () => {
    expect(getVoiceInputSettings()).toEqual(DEFAULT_VOICE_INPUT);
  });

  it("persists a setting change and reflects it on the getter", () => {
    setVoiceInputSetting("dictationMode", "commit");
    expect(getVoiceInputSettings().dictationMode).toBe("commit");
    expect(JSON.parse(localStorage.getItem(KEY)!).dictationMode).toBe("commit");
  });

  it("defaults Send Right Away off and persists it when toggled on", () => {
    expect(getVoiceInputSettings().sendRightAway).toBe(false);
    setVoiceInputSetting("sendRightAway", true);
    expect(getVoiceInputSettings().sendRightAway).toBe(true);
    expect(JSON.parse(localStorage.getItem(KEY)!).sendRightAway).toBe(true);
  });

  describe("one Send Right Away, from the two switches it replaces (ADR-0064)", () => {
    const CODE_KEY = "lotus-code-voice-v1";
    const loadWith = (input: object | null, code: object | null) => {
      if (input) localStorage.setItem(KEY, JSON.stringify(input));
      if (code) localStorage.setItem(CODE_KEY, JSON.stringify(code));
      resetVoiceInputStoreForTests();
      return getVoiceInputSettings().sendRightAway;
    };

    it("is on when Canvas's dictation auto-submit was on", () => {
      expect(loadWith({ dictateAutoSubmit: true }, null)).toBe(true);
    });

    it("is on when Code's send right away was on", () => {
      expect(loadWith({ dictateAutoSubmit: false }, { sendRightAway: true })).toBe(true);
      localStorage.clear();
      expect(loadWith(null, { sendRightAway: true })).toBe(true);
    });

    it("is off when neither was on", () => {
      expect(loadWith({ dictateAutoSubmit: false }, { sendRightAway: false })).toBe(false);
    });

    it("migrates once: turning it off afterwards sticks", () => {
      expect(loadWith({ dictateAutoSubmit: true }, { sendRightAway: true })).toBe(true);
      setVoiceInputSetting("sendRightAway", false);
      resetVoiceInputStoreForTests();
      expect(getVoiceInputSettings().sendRightAway).toBe(false);
    });

    it("records the migrated value, so it does not depend on the old keys again", () => {
      loadWith(null, { sendRightAway: true });
      expect(JSON.parse(localStorage.getItem(KEY)!).sendRightAway).toBe(true);
    });
  });

  it("hydrates a persisted value, merging missing keys to defaults", () => {
    localStorage.setItem(KEY, JSON.stringify({ autoSubmit: false }));
    resetVoiceInputStoreForTests();
    expect(getVoiceInputSettings().autoSubmit).toBe(false);
    expect(getVoiceInputSettings().dictationMode).toBe("clean"); // missing → default
  });

  it("clamps a bad word floor and ignores malformed storage", () => {
    localStorage.setItem(KEY, JSON.stringify({ minWordsToSubmit: -5 }));
    resetVoiceInputStoreForTests();
    expect(getVoiceInputSettings().minWordsToSubmit).toBe(1);
    localStorage.setItem(KEY, "{bad");
    resetVoiceInputStoreForTests();
    expect(getVoiceInputSettings()).toEqual(DEFAULT_VOICE_INPUT);
  });
  it("carries the old canvas value over to the app-level key", () => {
    localStorage.setItem(CANVAS_KEY, JSON.stringify({ autoSubmit: false, dictationMode: "commit" }));
    resetVoiceInputStoreForTests();
    expect(getVoiceInputSettings()).toMatchObject({ autoSubmit: false, dictationMode: "commit" });
    expect(JSON.parse(localStorage.getItem(KEY)!)).toMatchObject({ autoSubmit: false, dictationMode: "commit" });
  });
});
