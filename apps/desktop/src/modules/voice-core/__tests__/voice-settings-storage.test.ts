import { beforeEach, describe, expect, it } from "vitest";
import { readVoiceSetting, writeVoiceSetting } from "../voice-settings-storage";

const SLOT = { key: "lotus-voice-test-v1", legacyKey: "canvas-voice-test-v1" };

describe("voice settings storage", () => {
  beforeEach(() => localStorage.clear());

  it("reads the mode-neutral key", () => {
    localStorage.setItem(SLOT.key, '{"a":1}');
    expect(readVoiceSetting(SLOT)).toBe('{"a":1}');
  });

  it("carries a canvas value over to the mode-neutral key once", () => {
    localStorage.setItem(SLOT.legacyKey, '{"a":2}');
    expect(readVoiceSetting(SLOT)).toBe('{"a":2}');
    expect(localStorage.getItem(SLOT.key)).toBe('{"a":2}');
  });

  it("never reads the canvas key again after the move", () => {
    localStorage.setItem(SLOT.legacyKey, '{"a":2}');
    readVoiceSetting(SLOT);
    localStorage.setItem(SLOT.legacyKey, '{"a":3}');
    expect(readVoiceSetting(SLOT)).toBe('{"a":2}');
  });

  it("prefers the mode-neutral key over a leftover canvas key", () => {
    localStorage.setItem(SLOT.key, '{"a":1}');
    localStorage.setItem(SLOT.legacyKey, '{"a":2}');
    expect(readVoiceSetting(SLOT)).toBe('{"a":1}');
  });

  it("returns null when nothing is stored", () => {
    expect(readVoiceSetting(SLOT)).toBeNull();
  });

  it("writes to the mode-neutral key only", () => {
    writeVoiceSetting(SLOT, '{"a":4}');
    expect(localStorage.getItem(SLOT.key)).toBe('{"a":4}');
    expect(localStorage.getItem(SLOT.legacyKey)).toBeNull();
  });
});
