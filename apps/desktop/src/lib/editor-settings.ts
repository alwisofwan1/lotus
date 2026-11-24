export type EditorPreference = "system" | "vscode" | "cursor" | "antigravity" | "custom";
export type EditorLaunchMode = "path" | "path-line" | "path-line-column" | "goto-path-with-position" | "line-flags";

export interface ClaudeEditorSettings {
  editorPreference?: EditorPreference;
  editorCommand?: string;
  editorArgs?: string[];
  editorLaunchMode?: EditorLaunchMode;
}

const SUPPORTED_EDITOR_PREFERENCES: EditorPreference[] = ["system", "vscode", "cursor", "antigravity", "custom"];
const SUPPORTED_EDITOR_LAUNCH_MODES: EditorLaunchMode[] = ["path", "path-line", "path-line-column", "goto-path-with-position", "line-flags"];

export function defaultEditorSettings(): Required<ClaudeEditorSettings> {
  return {
    editorPreference: "system",
    editorCommand: "",
    editorArgs: [],
    editorLaunchMode: "path",
  };
}

export function normalizeEditorSettings(settings?: ClaudeEditorSettings): Required<ClaudeEditorSettings> {
  return {
    editorPreference: SUPPORTED_EDITOR_PREFERENCES.includes(settings?.editorPreference ?? "system")
      ? (settings?.editorPreference ?? "system")
      : "system",
    editorCommand: typeof settings?.editorCommand === "string" ? settings.editorCommand : "",
    editorArgs: Array.isArray(settings?.editorArgs)
      ? settings.editorArgs.filter((arg): arg is string => typeof arg === "string")
      : [],
    editorLaunchMode: SUPPORTED_EDITOR_LAUNCH_MODES.includes(settings?.editorLaunchMode ?? "path")
      ? (settings?.editorLaunchMode ?? "path")
      : "path",
  };
}

export function editorDisplayName(preference: EditorPreference): string {
  switch (preference) {
    case "vscode":
      return "VS Code";
    case "cursor":
      return "Cursor";
    case "antigravity":
      return "Antigravity";
    case "custom":
      return "Custom";
    case "system":
    default:
      return "System Default";
  }
}

export function argsForLaunchMode(mode: EditorLaunchMode): string[] {
  switch (mode) {
    case "path-line":
      return ["{path}:{line}"];
    case "path-line-column":
      return ["{path}:{line}:{column}"];
    case "goto-path-with-position":
      return ["--goto", "{pathWithPosition}"];
    case "line-flags":
      return ["{path}", "--line", "{line}", "--column", "{column}"];
    case "path":
    default:
      return ["{path}"];
  }
}
