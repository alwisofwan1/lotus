import type { editor } from "monaco-editor";
import { getDesignTheme, type AppTheme } from "@/lib/design-system";
import { bundledThemes, createHighlighter, type Highlighter, type ThemeRegistrationAny } from "shiki";
import { shikiToMonaco } from "@shikijs/monaco";
import { EDITOR_HIGHLIGHT_LANGUAGES } from "@/modules/codespace/services/editor-languages";
import {
  buildLotusEditorTheme,
  isLotusEditorTheme,
  LOTUS_EDITOR_DARK_THEME,
  LOTUS_EDITOR_LIGHT_THEME,
} from "@/modules/codespace/services/lotus-editor-theme";

type MonacoApi = typeof import("monaco-editor");

/*
 * Shiki tokenizes on the main thread, a line at a time, again on every edit of that line. Measured
 * (LOT2-211): a 19k-character minified JS, CSS or Markdown line costs 150–200ms, and the library's
 * 20k cap lets it through. Past 5k characters a line stays uncolored (≤45ms below it), and a
 * pathological grammar gives up after 100ms instead of 500.
 */
const SHIKI_MONACO_OPTIONS = { tokenizeMaxLineLength: 5_000, tokenizeTimeLimit: 100 };

export const CODESPACE_DARK_THEME = LOTUS_EDITOR_DARK_THEME;
export const CODESPACE_LIGHT_THEME = LOTUS_EDITOR_LIGHT_THEME;

export const EDITOR_THEME_OPTIONS: Array<{
  id: string;
  label: string;
  kind: "dark" | "light";
}> = [
  // dark
  { id: LOTUS_EDITOR_DARK_THEME, label: "Lotus Dark", kind: "dark" },
  { id: "gruvbox-dark-hard", label: "Gruvbox Dark Hard", kind: "dark" },
  { id: "gruvbox-dark-medium", label: "Gruvbox Dark Medium", kind: "dark" },
  { id: "one-dark-pro", label: "One Dark Pro", kind: "dark" },
  { id: "tokyo-night", label: "Tokyo Night", kind: "dark" },
  { id: "catppuccin-mocha", label: "Catppuccin Mocha", kind: "dark" },
  { id: "nord", label: "Nord", kind: "dark" },
  { id: "dracula", label: "Dracula", kind: "dark" },
  { id: "vitesse-dark", label: "Vitesse Dark", kind: "dark" },
  { id: "night-owl", label: "Night Owl", kind: "dark" },
  { id: "rose-pine", label: "Rosé Pine", kind: "dark" },
  { id: "monokai", label: "Monokai", kind: "dark" },
  { id: "github-dark", label: "GitHub Dark", kind: "dark" },
  { id: "solarized-dark", label: "Solarized Dark", kind: "dark" },
  // light
  { id: LOTUS_EDITOR_LIGHT_THEME, label: "Lotus Light", kind: "light" },
  { id: "gruvbox-light-soft", label: "Gruvbox Light Soft", kind: "light" },
  { id: "gruvbox-light-medium", label: "Gruvbox Light Medium", kind: "light" },
  { id: "github-light-default", label: "GitHub Light", kind: "light" },
  { id: "catppuccin-latte", label: "Catppuccin Latte", kind: "light" },
  { id: "vitesse-light", label: "Vitesse Light", kind: "light" },
  { id: "rose-pine-dawn", label: "Rosé Pine Dawn", kind: "light" },
  { id: "solarized-light", label: "Solarized Light", kind: "light" },
  { id: "min-light", label: "Min Light", kind: "light" },
];

// Loaded with the highlighter: the languages most files are in. The rest of
// EDITOR_HIGHLIGHT_LANGUAGES load the first time a file needs them.
const EAGER_LANGS = [
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "json",
  "jsonc",
  "css",
  "html",
  "markdown",
  "rust",
  "python",
  "go",
  "shell",
  "yaml",
  "toml",
];

let highlighterPromise: Promise<Highlighter> | null = null;
let highlighterInstance: Highlighter | null = null;
let monacoIntegrationPromise: Promise<void> | null = null;
const loadedThemeNames = new Set<string>([CODESPACE_DARK_THEME, CODESPACE_LIGHT_THEME]);
// `shikiToMonaco` ends by switching Monaco to the first loaded theme; the one the app chose is put back.
let appliedThemeName: string | null = null;

function diffOverrides(dark: boolean): Record<string, string> {
  // Subtle, VS Code-like diff colours instead of Monaco's saturated defaults.
  return {
    "diffEditor.insertedTextBackground": dark ? "#9bb95524" : "#2ea04322",
    "diffEditor.removedTextBackground": dark ? "#ff757524" : "#f8514922",
    "diffEditor.insertedLineBackground": dark ? "#9bb95514" : "#2ea04314",
    "diffEditor.removedLineBackground": dark ? "#ff757514" : "#f8514914",
    "diffEditor.insertedTextBorder": "#00000000",
    "diffEditor.removedTextBorder": "#00000000",
    "diffEditor.diagonalFill": dark ? "#cccccc10" : "#24292f10",
    "diffEditorOverview.insertedForeground": dark ? "#9bb9556b" : "#2ea0436b",
    "diffEditorOverview.removedForeground": dark ? "#ff75756b" : "#f851496b",
    "editorOverviewRuler.errorForeground": "#00000000",
    "editorOverviewRuler.warningForeground": "#00000000",
    "editorOverviewRuler.infoForeground": "#00000000",
    "editorOverviewRuler.deletedForeground": "#00000000",
    "editorOverviewRuler.addedForeground": "#00000000",
    "editorOverviewRuler.modifiedForeground": "#00000000",
    "minimap.errorHighlight": "#00000000",
    "minimap.warningHighlight": "#00000000",
    "scrollbar.shadow": "#00000000",
  };
}

async function loadCustomizedShikiTheme(
  name: keyof typeof bundledThemes,
): Promise<ThemeRegistrationAny> {
  const mod = await bundledThemes[name]();
  const base = (mod as { default: { type?: string; colors?: Record<string, string> } }).default;
  const dark = base.type !== "light";
  return {
    ...base,
    colors: {
      ...(base.colors ?? {}),
      ...diffOverrides(dark),
    },
  } as ThemeRegistrationAny;
}

/** A Lotus editor theme, built from the fixed palette of its own mode. */
function lotusShikiTheme(mode: "dark" | "light"): ThemeRegistrationAny {
  const lotus = buildLotusEditorTheme(getDesignTheme(mode));
  return { ...lotus, colors: { ...lotus.colors, ...diffOverrides(lotus.type === "dark") } } as ThemeRegistrationAny;
}

function ensureHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const [darkTheme, lightTheme] = [lotusShikiTheme("dark"), lotusShikiTheme("light")];
      highlighterInstance = await createHighlighter({
        themes: [darkTheme, lightTheme] as Parameters<typeof createHighlighter>[0]["themes"],
        langs: EAGER_LANGS,
      });
      return highlighterInstance;
    })();
  }
  return highlighterPromise;
}

function ensureLanguagesRegistered(monaco: MonacoApi): void {
  const existing = new Set(monaco.languages.getLanguages().map((language) => language.id));
  for (const lang of EDITOR_HIGHLIGHT_LANGUAGES) {
    if (!existing.has(lang)) {
      monaco.languages.register({ id: lang });
    }
  }
}

function ensureMonacoIntegrated(monaco: MonacoApi): Promise<void> {
  if (!monacoIntegrationPromise) {
    monacoIntegrationPromise = (async () => {
      ensureLanguagesRegistered(monaco);
      const highlighter = await ensureHighlighter();
      shikiToMonaco(highlighter, monaco, SHIKI_MONACO_OPTIONS);
    })();
  }
  return monacoIntegrationPromise;
}

/**
 * Make sure `language` is highlighted: load its grammar the first time a file needs it. Models
 * already open in it are tokenized again once it is in.
 */
export async function ensureCodespaceLanguage(monaco: MonacoApi, language: string): Promise<void> {
  if (!EDITOR_HIGHLIGHT_LANGUAGES.includes(language)) return;
  await ensureMonacoIntegrated(monaco);
  const highlighter = await ensureHighlighter();
  if (highlighter.getLoadedLanguages().includes(language)) return;
  await highlighter.loadLanguage(language as Parameters<Highlighter["loadLanguage"]>[0]);
  shikiToMonaco(highlighter, monaco, SHIKI_MONACO_OPTIONS);
  if (appliedThemeName) monaco.editor.setTheme(appliedThemeName);
}

/** Load a Shiki bundled theme into Monaco the first time it is chosen; the Lotus themes load with the highlighter. */
async function ensureThemeInMonaco(monaco: MonacoApi, themeName: string): Promise<void> {
  if (isLotusEditorTheme(themeName)) return;
  if (!(themeName in bundledThemes)) return;
  if (loadedThemeNames.has(themeName)) return;
  const highlighter = await ensureHighlighter();
  const theme = await loadCustomizedShikiTheme(themeName as keyof typeof bundledThemes);
  await highlighter.loadTheme(theme);
  loadedThemeNames.add(themeName);
  // Re-register all loaded themes with Monaco (defineTheme is idempotent).
  shikiToMonaco(highlighter, monaco, SHIKI_MONACO_OPTIONS);
}

export function getCodespaceMonacoThemeName(
  theme?: AppTheme,
  overrides?: { editorDarkTheme?: string; editorLightTheme?: string },
): string {
  const isLight = theme?.type === "light";
  if (isLight) return overrides?.editorLightTheme ?? CODESPACE_LIGHT_THEME;
  return overrides?.editorDarkTheme ?? CODESPACE_DARK_THEME;
}

export function getCodespaceMonacoDiffThemeName(
  theme?: AppTheme,
  overrides?: { editorDarkTheme?: string; editorLightTheme?: string },
): string {
  return getCodespaceMonacoThemeName(theme, overrides);
}

export async function applyCodespaceMonacoTheme(
  monaco: MonacoApi,
  theme: AppTheme,
  overrides?: { editorDarkTheme?: string; editorLightTheme?: string },
): Promise<void> {
  await ensureMonacoIntegrated(monaco);
  const themeName = getCodespaceMonacoThemeName(theme, overrides);
  await ensureThemeInMonaco(monaco, themeName);
  appliedThemeName = themeName;
  monaco.editor.setTheme(themeName);
}

export function defineCodespaceMonacoThemes(
  monaco: MonacoApi,
  theme: AppTheme,
  overrides?: { editorDarkTheme?: string; editorLightTheme?: string },
): void {
  void applyCodespaceMonacoTheme(monaco, theme, overrides);
}

// Kept for compatibility; consumers may treat the result as the theme name to
// pass into `<MonacoEditor theme={...} />` for the dark/light variant.
export type CodespaceMonacoTheme = editor.IStandaloneThemeData;

/** One coloured run of a line: what a read-only view (the canvas File Node) paints. */
export type HighlightedToken = { content: string; color?: string };

/**
 * The same Shiki highlighter and themes the editor uses, for a view that has no Monaco: text in,
 * coloured runs out, one array per line. An unknown language falls back to plain text. Long lines
 * stay uncoloured past the same cap the editor applies.
 */
export async function highlightCodespaceLines(
  code: string,
  language: string,
  themeName: string,
): Promise<HighlightedToken[][]> {
  const highlighter = await ensureHighlighter();
  if (EDITOR_HIGHLIGHT_LANGUAGES.includes(language) && !highlighter.getLoadedLanguages().includes(language)) {
    await highlighter.loadLanguage(language as Parameters<Highlighter["loadLanguage"]>[0]);
  }
  if (!isLotusEditorTheme(themeName) && themeName in bundledThemes && !highlighter.getLoadedThemes().includes(themeName)) {
    await highlighter.loadTheme(await loadCustomizedShikiTheme(themeName as keyof typeof bundledThemes));
  }
  const theme = highlighter.getLoadedThemes().includes(themeName) ? themeName : CODESPACE_DARK_THEME;
  const lang = highlighter.getLoadedLanguages().includes(language) ? language : "text";
  const lines = highlighter.codeToTokensBase(code, {
    lang: lang as import("shiki").BundledLanguage,
    theme: theme as keyof typeof bundledThemes,
    ...SHIKI_MONACO_OPTIONS,
  });
  // Tokenizing switched the shared highlighter to `theme`, and Monaco's tokenizer reads its colours
  // from whatever theme the highlighter is on: put back the one the editor is showing.
  if (appliedThemeName && appliedThemeName !== theme) highlighter.setTheme(appliedThemeName);
  return lines.map((line) => line.map((token) => ({ content: token.content, ...(token.color ? { color: token.color } : {}) })));
}
