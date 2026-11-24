import { describe, expect, it } from "vitest";
import {
  argsForLaunchMode,
  defaultEditorSettings,
  editorDisplayName,
  normalizeEditorSettings,
  type ClaudeEditorSettings,
} from "../editor-settings";

describe("normalizeEditorSettings", () => {
  it("defaults to system opener", () => {
    expect(normalizeEditorSettings(undefined)).toEqual(defaultEditorSettings());
  });

  it("keeps supported editor preferences", () => {
    const settings: ClaudeEditorSettings = { editorPreference: "cursor" };
    expect(normalizeEditorSettings(settings)).toEqual({
      editorPreference: "cursor",
      editorCommand: "",
      editorArgs: [],
      editorLaunchMode: "path",
    });
  });

  it("falls back when the value is invalid", () => {
    expect(normalizeEditorSettings({ editorPreference: "vim" as "cursor" })).toEqual({
      editorPreference: "system",
      editorCommand: "",
      editorArgs: [],
      editorLaunchMode: "path",
    });
  });

  it("preserves templated args for custom editors", () => {
    expect(normalizeEditorSettings({
      editorPreference: "custom",
      editorCommand: "zed",
      editorArgs: ["{path}", "--line", "{line}"],
      editorLaunchMode: "path",
    })).toEqual({
      editorPreference: "custom",
      editorCommand: "zed",
      editorArgs: ["{path}", "--line", "{line}"],
      editorLaunchMode: "path",
    });
  });
});

describe("editorDisplayName", () => {
  it("returns human-readable labels", () => {
    expect(editorDisplayName("system")).toBe("System Default");
    expect(editorDisplayName("vscode")).toBe("VS Code");
    expect(editorDisplayName("cursor")).toBe("Cursor");
    expect(editorDisplayName("antigravity")).toBe("Antigravity");
    expect(editorDisplayName("custom")).toBe("Custom");
  });
});

describe("argsForLaunchMode", () => {
  it("maps simple launch modes to templates", () => {
    expect(argsForLaunchMode("path")).toEqual(["{path}"]);
    expect(argsForLaunchMode("path-line")).toEqual(["{path}:{line}"]);
    expect(argsForLaunchMode("goto-path-with-position")).toEqual(["--goto", "{pathWithPosition}"]);
  });
});
