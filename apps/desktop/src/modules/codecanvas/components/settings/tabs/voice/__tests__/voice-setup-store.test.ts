import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { clearVoiceTest, recordVoiceTest, resetVoiceSetupStoreForTests, setVoiceSetupState, useVoiceSetupStore } from "../voice-setup-store";

describe("voice setup store", () => {
  beforeEach(() => {
    localStorage.clear();
    resetVoiceSetupStoreForTests();
  });

  it("remembers setup and the last test per card across reloads", () => {
    const { result } = renderHook(() => useVoiceSetupStore());
    expect(result.current).toEqual({ setup: null, tests: {} });

    act(() => {
      setVoiceSetupState("skipped");
      recordVoiceTest("listen", { engineId: "openai", at: 1, ok: true, ms: 500 });
    });
    expect(result.current.setup).toBe("skipped");
    expect(result.current.tests.listen?.ms).toBe(500);

    resetVoiceSetupStoreForTests();
    const again = renderHook(() => useVoiceSetupStore());
    expect(again.result.current.setup).toBe("skipped");
    expect(again.result.current.tests.listen?.engineId).toBe("openai");

    act(() => clearVoiceTest("listen"));
    expect(again.result.current.tests.listen).toBeUndefined();
  });

  it("reads a corrupt tests slot as no tests", () => {
    localStorage.setItem("lotus-voice-tests-v1", "{nope");
    const { result } = renderHook(() => useVoiceSetupStore());
    expect(result.current.tests).toEqual({});
  });
});
