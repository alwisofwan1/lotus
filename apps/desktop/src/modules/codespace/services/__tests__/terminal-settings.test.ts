import { describe, expect, it, vi, beforeEach } from "vitest";

const mockGetSettings = vi.fn();
const mockSaveSettings = vi.fn();

vi.mock("@/lib/tauri-api", () => ({
  getSettings: (...args: unknown[]) => mockGetSettings(...args),
  saveSettings: (...args: unknown[]) => mockSaveSettings(...args),
}));

import {
  clampTerminalFontSize,
  DEFAULT_TERMINAL_FONT_SIZE,
  isTerminalFontZoomShortcut,
  loadTerminalPreferences,
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  persistTerminalFontSize,
} from "@/modules/codespace/services/terminal-settings";

describe("terminal-settings service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("clamps terminal font size within supported bounds", () => {
    expect(clampTerminalFontSize(MIN_TERMINAL_FONT_SIZE - 3)).toBe(MIN_TERMINAL_FONT_SIZE);
    expect(clampTerminalFontSize(MAX_TERMINAL_FONT_SIZE + 4)).toBe(MAX_TERMINAL_FONT_SIZE);
    expect(clampTerminalFontSize(13)).toBe(13);
  });

  it("detects terminal font zoom shortcuts", () => {
    expect(isTerminalFontZoomShortcut({ metaKey: true, key: "+", code: "" } as KeyboardEvent)).toBe(true);
    expect(isTerminalFontZoomShortcut({ ctrlKey: true, key: "0", code: "" } as KeyboardEvent)).toBe(true);
    expect(isTerminalFontZoomShortcut({ ctrlKey: true, key: "k", code: "" } as KeyboardEvent)).toBe(false);
  });

  it("loads normalized terminal preferences from settings", async () => {
    mockGetSettings.mockResolvedValue({ "terminal-font-size": 11 });

    await expect(loadTerminalPreferences()).resolves.toEqual({
      settings: { "terminal-font-size": 11 },
      terminalFontSize: DEFAULT_TERMINAL_FONT_SIZE,
    });
  });

  it("persists terminal font size into settings", async () => {
    mockSaveSettings.mockResolvedValue(undefined);

    await expect(persistTerminalFontSize({ theme: "dark" }, 14)).resolves.toEqual({
      theme: "dark",
      "terminal-font-size": 14,
    });
    expect(mockSaveSettings).toHaveBeenCalledWith({
      theme: "dark",
      "terminal-font-size": 14,
    });
  });
});
