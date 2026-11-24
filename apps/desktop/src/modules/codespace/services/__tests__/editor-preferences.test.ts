import { beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
  emit: vi.fn(),
}));

vi.mock("@/lib/tauri-api", () => ({ getSettings: io.getSettings, saveSettings: io.saveSettings }));
vi.mock("@/modules/settings/services/settings-events", () => ({ emitLotusSettingsChanged: io.emit }));

import {
  DEFAULT_EDITOR_FONT_SIZE,
  readEditorPreferences,
  saveEditorPreferences,
  stepEditorFontSize,
} from "../editor-preferences";

const SAVE_AND_VIEW_DEFAULTS = {
  formatOnSave: false,
  trimTrailingWhitespace: false,
  insertFinalNewline: false,
  minimap: false,
  stickyScroll: true,
  inlineBlame: true,
};

describe("editor preferences", () => {
  beforeEach(() => {
    io.getSettings.mockReset();
    io.saveSettings.mockReset().mockResolvedValue(undefined);
    io.emit.mockReset();
  });

  it("defaults to 13px code without word wrap or auto save", () => {
    expect(DEFAULT_EDITOR_FONT_SIZE).toBe(13);
    expect(readEditorPreferences(null)).toEqual({ fontSize: 13, wordWrap: false, autoSave: "off", languageServers: true, trustedFolders: [], ...SAVE_AND_VIEW_DEFAULTS });
    expect(readEditorPreferences({ codespace: { editorFontSize: "big", editorWordWrap: "yes", editorAutoSave: "always" } }))
      .toEqual({ fontSize: 13, wordWrap: false, autoSave: "off", languageServers: true, trustedFolders: [], ...SAVE_AND_VIEW_DEFAULTS });
  });

  it("reads what the settings file says, kept to a readable range", () => {
    expect(readEditorPreferences({ codespace: { editorFontSize: 15, editorWordWrap: true, editorDarkTheme: "nord" } }))
      .toEqual({ fontSize: 15, wordWrap: true, autoSave: "off", languageServers: true, trustedFolders: [], ...SAVE_AND_VIEW_DEFAULTS, editorDarkTheme: "nord" });
    expect(readEditorPreferences({ codespace: { editorAutoSave: "afterDelay" } }).autoSave).toBe("afterDelay");
    expect(readEditorPreferences({ codespace: { editorAutoSave: "onFocusChange" } }).autoSave).toBe("onFocusChange");
    expect(readEditorPreferences({ codespace: { editorFontSize: 3 } }).fontSize).toBe(10);
    expect(readEditorPreferences({ codespace: { editorFontSize: 90 } }).fontSize).toBe(24);
    expect(readEditorPreferences({ codespace: { editorFontSize: 13.6 } }).fontSize).toBe(14);
  });

  it("steps the font size one pixel at a time, inside the range", () => {
    expect(stepEditorFontSize(13, 1)).toBe(14);
    expect(stepEditorFontSize(10, -1)).toBe(10);
    expect(stepEditorFontSize(24, 1)).toBe(24);
  });

  it("saves into the file as it is now, keeping every other key, and tells open panes", async () => {
    io.getSettings.mockResolvedValue({ env: { A: "1" }, codespace: { autoPaneTitles: false, editorFontSize: 13 } });

    await saveEditorPreferences({ fontSize: 16 });

    const saved = { env: { A: "1" }, codespace: { autoPaneTitles: false, editorFontSize: 16 } };
    expect(io.saveSettings).toHaveBeenCalledWith(saved);
    expect(io.emit).toHaveBeenCalledWith(saved);
  });

  it("saves word wrap on its own", async () => {
    io.getSettings.mockResolvedValue(null);
    await saveEditorPreferences({ wordWrap: true });
    expect(io.saveSettings).toHaveBeenCalledWith({ codespace: { editorWordWrap: true } });
  });

  it("saves auto save on its own", async () => {
    io.getSettings.mockResolvedValue({ codespace: { editorFontSize: 14 } });
    await saveEditorPreferences({ autoSave: "afterDelay" });
    expect(io.saveSettings).toHaveBeenCalledWith({ codespace: { editorFontSize: 14, editorAutoSave: "afterDelay" } });
  });

  it("reads and saves the save steps, minimap and sticky scroll", async () => {
    expect(readEditorPreferences({
      codespace: { editorFormatOnSave: true, editorTrimTrailingWhitespace: true, editorMinimap: true, editorStickyScroll: false, editorInsertFinalNewline: "yes" },
    })).toMatchObject({ formatOnSave: true, trimTrailingWhitespace: true, minimap: true, stickyScroll: false, insertFinalNewline: false, inlineBlame: true });

    io.getSettings.mockResolvedValue({ codespace: { editorWordWrap: true } });
    await saveEditorPreferences({ formatOnSave: true, stickyScroll: false });
    expect(io.saveSettings).toHaveBeenCalledWith({ codespace: { editorWordWrap: true, editorFormatOnSave: true, editorStickyScroll: false } });
  });
});
