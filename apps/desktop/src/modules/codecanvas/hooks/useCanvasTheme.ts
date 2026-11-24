"use client";
import { useCallback, useSyncExternalStore } from "react";
import { BUILTIN_THEMES, DEFAULT_CANVAS_THEME_ID, defaultCanvasTheme } from "../services/theme/builtin-themes";
import { mergeCanvasThemeCatalog } from "../services/theme/canvas-theme-catalog";
import { listCanvasThemes } from "@/lib/tauri-api";
import { DEFAULT_TEXT_SIZE, TEXT_SIZES, type CanvasTheme, type TextSize } from "../types/canvas-theme";

// Artisan Theme Engine — the active-theme + node-text-size store (Phase 1a/3).
// Module-level store shared by every consumer (CanvasPage, StyleTab) via
// useSyncExternalStore, persisted to localStorage, SSR-safe. The catalog is the
// built-in set merged with user/agent-authored themes loaded once on hydrate.

const THEME_ID_KEY = "canvas-theme-id-v2";
const TEXT_SIZE_KEY = "canvas-node-text-size-v1";
// Legacy background-theme key (the 7 dropped themes — ADR-0023). Read once for a
// one-shot migration so returning users land on the default instead of a reset.
const LEGACY_THEME_KEY = "canvas-background-theme-v1";

interface ThemeState {
  themeId: string;
  textSize: TextSize | null;
  /** Built-in themes + validated user themes (Phase 3). */
  catalog: readonly CanvasTheme[];
}

const DEFAULT_STATE: ThemeState = { themeId: DEFAULT_CANVAS_THEME_ID, textSize: null, catalog: BUILTIN_THEMES };
let state: ThemeState = DEFAULT_STATE;
let hydrated = false;
const listeners = new Set<() => void>();

function isTextSize(v: string | null | undefined): v is TextSize {
  return !!v && (TEXT_SIZES as readonly string[]).includes(v);
}

function findInCatalog(id: string): CanvasTheme | undefined {
  return state.catalog.find((t) => t.id === id);
}

function loadThemeId(): string {
  try {
    const v2 = localStorage.getItem(THEME_ID_KEY);
    // Trust any persisted id — it may be a user theme that loads asynchronously;
    // the resolver falls back to the default until the catalog catches up.
    if (v2) return v2;
    // One-shot migration: a legacy v1 theme exists but no v2 → adopt the default
    // and stamp v2 so this only happens once. The legacy 7 don't survive as-is.
    if (localStorage.getItem(LEGACY_THEME_KEY)) {
      localStorage.setItem(THEME_ID_KEY, DEFAULT_CANVAS_THEME_ID);
    }
  } catch {}
  return DEFAULT_CANVAS_THEME_ID;
}

function loadTextSize(): TextSize | null {
  try {
    const raw = localStorage.getItem(TEXT_SIZE_KEY);
    return isTextSize(raw) ? raw : null;
  } catch { return null; }
}

function emit() { listeners.forEach((listener) => listener()); }

function setState(next: ThemeState) {
  if (next.themeId === state.themeId && next.textSize === state.textSize && next.catalog === state.catalog) return;
  state = next;
  emit();
}

// Load user/agent-authored themes once and merge them into the catalog. Safe
// everywhere: listCanvasThemes() returns [] outside Tauri or before the backend exists.
async function loadUserThemes() {
  try {
    const specs = await listCanvasThemes();
    if (!specs.length) return;
    const { themes } = mergeCanvasThemeCatalog(specs);
    setState({ ...state, catalog: themes });
  } catch {}
}

function hydrateOnce() {
  if (hydrated) return;
  hydrated = true;
  setState({ themeId: loadThemeId(), textSize: loadTextSize(), catalog: BUILTIN_THEMES });
  void loadUserThemes();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  hydrateOnce();
  return () => { listeners.delete(listener); };
}

const getSnapshot = (): ThemeState => state;
const getServerSnapshot = (): ThemeState => DEFAULT_STATE;

export function setCanvasTheme(id: string) {
  if (!findInCatalog(id)) return;
  try { localStorage.setItem(THEME_ID_KEY, id); } catch {}
  setState({ ...state, themeId: id });
}

export function setCanvasNodeTextSize(size: TextSize) {
  if (!isTextSize(size)) return;
  try { localStorage.setItem(TEXT_SIZE_KEY, size); } catch {}
  setState({ ...state, textSize: size });
}

/** Test-only: clear the shared store so suites don't leak state into each other. */
export function resetCanvasThemeStoreForTests() {
  state = DEFAULT_STATE;
  hydrated = false;
  listeners.clear();
}

export function useCanvasTheme(): {
  themeId: string;
  theme: CanvasTheme;
  themes: readonly CanvasTheme[];
  setTheme: (id: string) => void;
  /** The user's explicit override, or null when following the theme default. */
  nodeTextSize: TextSize | null;
  /** The size actually applied: override ?? theme default ?? "md". */
  effectiveTextSize: TextSize;
  setNodeTextSize: (size: TextSize) => void;
} {
  const { themeId, textSize, catalog } = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const setTheme = useCallback((id: string) => setCanvasTheme(id), []);
  const setNodeTextSize = useCallback((size: TextSize) => setCanvasNodeTextSize(size), []);
  const theme = catalog.find((t) => t.id === themeId) ?? defaultCanvasTheme();
  const effectiveTextSize = textSize ?? theme.defaultTextSize ?? DEFAULT_TEXT_SIZE;
  return { themeId, theme, themes: catalog, setTheme, nodeTextSize: textSize, effectiveTextSize, setNodeTextSize };
}
