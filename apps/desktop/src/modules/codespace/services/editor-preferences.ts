/*
 * The Editor pane's preferences, kept under `codespace` in `~/.claude/settings.json` so every
 * pane and window shares them: code font size, word wrap, auto save, what a save tidies, the
 * minimap and sticky scroll, and the Shiki themes. A project's `.editorconfig` wins over the save
 * preferences for its files (`editor-config.ts`).
 */

import { getSettings, saveSettings } from "@/lib/tauri-api";
import { emitLotusSettingsChanged } from "@/modules/settings/services/settings-events";

export const DEFAULT_EDITOR_FONT_SIZE = 13;
export const MIN_EDITOR_FONT_SIZE = 10;
export const MAX_EDITOR_FONT_SIZE = 24;

/**
 * When the editor saves by itself, as VS Code's `files.autoSave`: never, a second after typing
 * stops, or when the file loses focus (another tab, another pane, another app).
 */
export type EditorAutoSave = "off" | "afterDelay" | "onFocusChange";
export const EDITOR_AUTO_SAVE_OPTIONS: ReadonlyArray<{ value: EditorAutoSave; label: string }> = [
  { value: "off", label: "Off" },
  { value: "afterDelay", label: "After a delay" },
  { value: "onFocusChange", label: "When focus moves away" },
];
/** "After a delay": how long after the last key. */
export const EDITOR_AUTO_SAVE_DELAY_MS = 1000;

function readAutoSave(value: unknown): EditorAutoSave {
  return value === "afterDelay" || value === "onFocusChange" ? value : "off";
}

export type EditorPreferences = {
  fontSize: number;
  wordWrap: boolean;
  autoSave: EditorAutoSave;
  /** Language servers (errors, hover, go to definition) may start, in trusted folders. */
  languageServers: boolean;
  /**
   * Folders whose code the user trusts a language server to run (`lsp-trust.ts` keys). A server
   * runs the project's own tools — `node_modules/.bin`, build scripts — so none starts elsewhere.
   */
  trustedFolders: string[];
  /** Format the file with its language server before each save (⌘S, auto save). */
  formatOnSave: boolean;
  /** Remove spaces and tabs at line ends on save. Never in Markdown: two spaces there are a line break. */
  trimTrailingWhitespace: boolean;
  /** End the file with one line break on save. */
  insertFinalNewline: boolean;
  /** The small picture of the whole file at the editor's right side. */
  minimap: boolean;
  /** Keep the enclosing function or class header at the top while scrolling. */
  stickyScroll: boolean;
  /** Who last changed the cursor's line, at its end and in the status bar. */
  inlineBlame: boolean;
  editorDarkTheme?: string;
  editorLightTheme?: string;
};

export type EditorPreferenceChange = Partial<Pick<
  EditorPreferences,
  | "fontSize" | "wordWrap" | "autoSave" | "languageServers" | "trustedFolders"
  | "formatOnSave" | "trimTrailingWhitespace" | "insertFinalNewline" | "minimap" | "stickyScroll" | "inlineBlame"
>>;

/** Each on/off preference and the `codespace` settings key it is stored under. */
const FLAG_KEYS = {
  formatOnSave: "editorFormatOnSave",
  trimTrailingWhitespace: "editorTrimTrailingWhitespace",
  insertFinalNewline: "editorInsertFinalNewline",
  minimap: "editorMinimap",
  stickyScroll: "editorStickyScroll",
  inlineBlame: "editorInlineBlame",
} as const;
type FlagPreference = keyof typeof FLAG_KEYS;
const FLAG_DEFAULTS: Record<FlagPreference, boolean> = {
  formatOnSave: false,
  trimTrailingWhitespace: false,
  insertFinalNewline: false,
  minimap: false,
  // Monaco's own default, which the editor had before this was a setting.
  stickyScroll: true,
  inlineBlame: true,
};

function clampFontSize(size: number): number {
  return Math.min(MAX_EDITOR_FONT_SIZE, Math.max(MIN_EDITOR_FONT_SIZE, Math.round(size)));
}

/** Line height for a code font size, as the editor has always spaced 12px code (20px). */
export function editorLineHeight(fontSize: number): number {
  return Math.round(fontSize * 1.54);
}

export function stepEditorFontSize(size: number, step: 1 | -1): number {
  return clampFontSize(size + step);
}

export function readEditorPreferences(raw: Record<string, unknown> | null | undefined): EditorPreferences {
  const codespace = raw && typeof raw === "object" ? (raw as { codespace?: unknown }).codespace : null;
  const cs = codespace && typeof codespace === "object" ? codespace as Record<string, unknown> : {};
  const preferences: EditorPreferences = {
    fontSize: typeof cs.editorFontSize === "number" && Number.isFinite(cs.editorFontSize)
      ? clampFontSize(cs.editorFontSize)
      : DEFAULT_EDITOR_FONT_SIZE,
    wordWrap: cs.editorWordWrap === true,
    autoSave: readAutoSave(cs.editorAutoSave),
    languageServers: cs.editorLanguageServers !== false,
    trustedFolders: Array.isArray(cs.editorTrustedFolders)
      ? cs.editorTrustedFolders.filter((item): item is string => typeof item === "string")
      : [],
    ...readFlags(cs),
  };
  if (typeof cs.editorDarkTheme === "string") preferences.editorDarkTheme = cs.editorDarkTheme;
  if (typeof cs.editorLightTheme === "string") preferences.editorLightTheme = cs.editorLightTheme;
  return preferences;
}

function readFlags(cs: Record<string, unknown>): Record<FlagPreference, boolean> {
  const flags = { ...FLAG_DEFAULTS };
  for (const name of Object.keys(FLAG_KEYS) as FlagPreference[]) {
    const value = cs[FLAG_KEYS[name]];
    if (typeof value === "boolean") flags[name] = value;
  }
  return flags;
}

// One save at a time: two quick changes must reach the file in the order they were made.
let saving: Promise<void> = Promise.resolve();

/**
 * Write a change into the settings file as it is now, so keys another surface wrote in between
 * survive, then tell every open pane.
 */
export function saveEditorPreferences(change: EditorPreferenceChange): Promise<void> {
  const next = saving.then(() => writePreferences(change));
  saving = next.catch(() => {});
  return next;
}

async function writePreferences(change: EditorPreferenceChange): Promise<void> {
  const current = ((await getSettings()) ?? {}) as Record<string, unknown>;
  const codespace = current.codespace && typeof current.codespace === "object" ? current.codespace as Record<string, unknown> : {};
  const next = {
    ...current,
    codespace: {
      ...codespace,
      ...(change.fontSize !== undefined ? { editorFontSize: clampFontSize(change.fontSize) } : {}),
      ...(change.wordWrap !== undefined ? { editorWordWrap: change.wordWrap } : {}),
      ...(change.autoSave !== undefined ? { editorAutoSave: change.autoSave } : {}),
      ...(change.languageServers !== undefined ? { editorLanguageServers: change.languageServers } : {}),
      ...(change.trustedFolders !== undefined ? { editorTrustedFolders: [...new Set(change.trustedFolders)] } : {}),
      ...Object.fromEntries((Object.keys(FLAG_KEYS) as FlagPreference[])
        .filter((name) => change[name] !== undefined)
        .map((name) => [FLAG_KEYS[name], change[name]])),
    },
  };
  await saveSettings(next);
  emitLotusSettingsChanged(next);
}
