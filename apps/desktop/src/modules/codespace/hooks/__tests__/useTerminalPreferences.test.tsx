import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTerminalPreferences } from "@/modules/codespace/hooks/useTerminalPreferences";
import { LOTUS_SETTINGS_CHANGED_EVENT } from "@/modules/settings/services/settings-events";

const mockGetSettings = vi.fn();
const mockSaveSettings = vi.fn();

vi.mock("@/lib/tauri-api", () => ({
  getSettings: (...args: unknown[]) => mockGetSettings(...args),
  saveSettings: (...args: unknown[]) => mockSaveSettings(...args),
}));

describe("useTerminalPreferences", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockGetSettings.mockResolvedValue({ "terminal-font-size": 14 });
    mockSaveSettings.mockResolvedValue(undefined);
    mockGetSettings.mockClear();
    mockSaveSettings.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("updates terminal font size when settings are saved from the Settings page", async () => {
    const { result } = renderHook(() => useTerminalPreferences());

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.terminalFontSize).toBe(14);

    act(() => {
      window.dispatchEvent(new CustomEvent(LOTUS_SETTINGS_CHANGED_EVENT, {
        detail: { settings: { "terminal-font-size": 13 } },
      }));
    });

    expect(result.current.terminalFontSize).toBe(13);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    expect(mockSaveSettings).not.toHaveBeenCalledWith({ "terminal-font-size": 13 });
  });
});
