import { hasPrimaryModifier } from "@/lib/hotkeys/platform-chords";
import { isTauri } from "@/lib/tauri/runtime";

/**
 * Interface size: the whole app webview's page zoom (WKWebView pageZoom via Tauri `setZoom`).
 * Zoom, not a root font-size, because ~480 font sizes in the app are px and would not follow.
 *
 * Page zoom makes one CSS px = `zoom` window points, so anything that hands DOM coordinates to
 * the native side (child webview bounds) must go through `toWindowRect`.
 */
export const UI_ZOOM_STEPS = [0.9, 1, 1.1, 1.25, 1.4] as const;
export const UI_ZOOM_STORAGE_KEY = "lotus-ui-zoom";

let current = 1;

export function normalizeUiZoom(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return 1;
  return UI_ZOOM_STEPS.reduce((best, step) => (Math.abs(step - n) < Math.abs(best - n) ? step : best), 1);
}

export function getUiZoom(): number {
  return current;
}

/** The next step up or down from `zoom`, clamped to the ends. */
export function stepUiZoom(zoom: number, step: 1 | -1): number {
  const i = UI_ZOOM_STEPS.indexOf(normalizeUiZoom(zoom) as (typeof UI_ZOOM_STEPS)[number]);
  return UI_ZOOM_STEPS[Math.min(UI_ZOOM_STEPS.length - 1, Math.max(0, i + step))];
}

/** A DOM rect (CSS px) in window points, for native child webview bounds. */
export function toWindowRect<T extends { x: number; y: number; width: number; height: number }>(rect: T): T {
  if (current === 1) return rect;
  return { ...rect, x: rect.x * current, y: rect.y * current, width: rect.width * current, height: rect.height * current };
}

const listeners = new Set<(zoom: number) => void>();

export function subscribeUiZoom(listener: (zoom: number) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function apply(zoom: number): Promise<void> {
  current = zoom;
  listeners.forEach((listener) => listener(zoom));
  if (!isTauri()) return;
  // Lazy import: a static one is not loaded on the prerender path.
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  await getCurrentWebview().setZoom(zoom);
}

function readStored(): number {
  try {
    return normalizeUiZoom(window.localStorage.getItem(UI_ZOOM_STORAGE_KEY));
  } catch {
    return 1;
  }
}

/** Saves the choice; every other Lotus window picks it up through the `storage` event. */
export function setUiZoom(zoom: number): Promise<void> {
  const next = normalizeUiZoom(zoom);
  try {
    window.localStorage.setItem(UI_ZOOM_STORAGE_KEY, String(next));
  } catch {
    // Storage off: the size lasts until the window closes.
  }
  return apply(next);
}

/**
 * ⌘= / ⌘- / ⌘0 on macOS, Ctrl= / Ctrl- / Ctrl0 elsewhere. Off macOS the key reached WebView2's own
 * page zoom instead, which is neither saved nor known to `toWindowRect`.
 */
export function isZoomKey(
  event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey">,
  platform?: string,
): 1 | -1 | 0 | null {
  if (event.altKey || !hasPrimaryModifier(event, platform)) return null;
  if (event.key === "=" || event.key === "+" || event.code === "NumpadAdd") return 1;
  if (event.key === "-" || event.key === "_" || event.code === "NumpadSubtract") return -1;
  if (event.key === "0" || event.code === "Numpad0") return 0;
  return null;
}

/** Applies the saved size and wires ⌘+ / ⌘− / ⌘0 (Ctrl off macOS) and cross-window sync. Returns the cleanup. */
export function installUiZoom(): () => void {
  void apply(readStored()).catch(() => undefined);

  const onKey = (event: KeyboardEvent) => {
    // A focused viewer (PDF, image) that zooms itself has already handled the key.
    if (event.defaultPrevented) return;
    const dir = isZoomKey(event);
    if (dir === null) return;
    event.preventDefault();
    void setUiZoom(dir === 0 ? 1 : stepUiZoom(current, dir)).catch(() => undefined);
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === UI_ZOOM_STORAGE_KEY) void apply(normalizeUiZoom(event.newValue)).catch(() => undefined);
  };
  window.addEventListener("keydown", onKey);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("storage", onStorage);
  };
}
