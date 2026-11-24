import { isTauri, tauriInvoke } from "@/lib/tauri/runtime";
import { toWindowRect } from "@/lib/ui-zoom";

// The browser behind the new chat's Preview, CodeChat's inspector and Canvas annotation (07i).
// Webview labels and the annotation event keep their codechat-* strings: capabilities match them.

export interface BrowserPreview {
  label: string;
  url: string;
  reused: boolean;
  /** False while a local dev server is not listening yet: nothing was loaded, ask again later. */
  reachable: boolean;
}

export interface BrowserPreviewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserAnnotationPayload {
  id?: string;
  action?: "selected" | "cancel";
  url?: string;
  title?: string;
  selector?: string;
  label?: string;
  message?: string;
  text?: string;
  status?: string;
  createdAt?: string;
  classes?: string[];
  summary?: string[];
  visualAttachments?: { name: string; content: string; mimeType?: string; previewUrl?: string }[];
  boundingBox?: BrowserPreviewBounds;
  viewport?: {
    width: number;
    height: number;
    scrollX: number;
    scrollY: number;
  };
}

export const BROWSER_ANNOTATION_EVENT = "codechat-browser-annotation";

export async function openBrowserPreviewWindow(url: string): Promise<BrowserPreview> {
  if (!isTauri()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return {
      label: "external-browser",
      url,
      reused: false,
      reachable: true,
    };
  }

  return tauriInvoke<BrowserPreview>("browser_preview_open_window", { url });
}

export async function openEmbeddedBrowserPreview(
  url: string,
  bounds: BrowserPreviewBounds,
  slot?: string,
  /** The folder a `file://` url may read from; required for one. */
  root?: string,
): Promise<BrowserPreview> {
  if (!isTauri()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return {
      label: "external-browser",
      url,
      reused: false,
      reachable: true,
    };
  }

  return tauriInvoke<BrowserPreview>("browser_preview_open", {
    url,
    bounds: toWindowRect(bounds),
    slot,
    root,
  });
}

export async function syncEmbeddedBrowserPreviewBounds(
  bounds: BrowserPreviewBounds,
  slot?: string,
): Promise<void> {
  if (!isTauri()) return;

  return tauriInvoke("browser_preview_sync_bounds", { bounds: toWindowRect(bounds), slot });
}

export async function closeEmbeddedBrowserPreview(slot?: string): Promise<void> {
  if (!isTauri()) return;

  return tauriInvoke("browser_preview_close", { slot });
}

/** False while `url` is a local address nothing listens on yet; asked off the main thread. */
/** `refused`: a local port nothing listens on yet. `unknown-host`: a name DNS does not know. */
export type BrowserPreviewReach = "ok" | "refused" | "unknown-host";

export async function browserPreviewReachable(url: string): Promise<BrowserPreviewReach> {
  if (!isTauri()) return "ok";
  return tauriInvoke<BrowserPreviewReach>("browser_preview_reachable", { url });
}

/** Hides a browser without unloading it, so a Lotus popup can draw where it was. */
export async function setEmbeddedBrowserPreviewVisible(slot: string, visible: boolean): Promise<void> {
  if (!isTauri()) return;

  return tauriInvoke("browser_preview_set_visible", { slot, visible });
}

/** The part of the page to keep, in CSS pixels of the viewport it was measured against. */
export interface BrowserPreviewCrop {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
}

/** A Preview browser as a PNG data URL: the `crop` of it, or the whole page. macOS only. */
export async function captureEmbeddedBrowserPreview(slot: string, crop?: BrowserPreviewCrop): Promise<string> {
  if (!isTauri()) throw new Error("Capturing the preview needs the desktop app.");

  return tauriInvoke<string>("browser_preview_capture", { slot, crop });
}

export async function reloadEmbeddedBrowserPreview(slot?: string): Promise<void> {
  if (!isTauri()) return;

  return tauriInvoke("browser_preview_reload", { slot });
}

export async function goBackEmbeddedBrowserPreview(slot?: string): Promise<void> {
  if (!isTauri()) {
    window.history.back();
    return;
  }

  return tauriInvoke("browser_preview_go_back", { slot });
}

export async function goForwardEmbeddedBrowserPreview(slot?: string): Promise<void> {
  if (!isTauri()) {
    window.history.forward();
    return;
  }

  return tauriInvoke("browser_preview_go_forward", { slot });
}

export async function startEmbeddedBrowserAnnotationMode(slot?: string): Promise<void> {
  if (!isTauri()) return;

  return tauriInvoke("browser_preview_start_annotation", { slot });
}

export async function stopEmbeddedBrowserAnnotationMode(slot?: string): Promise<void> {
  if (!isTauri()) return;

  return tauriInvoke("browser_preview_stop_annotation", { slot });
}

export async function listenBrowserAnnotationEvents(
  onPayload: (payload: BrowserAnnotationPayload) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};

  const { listen } = await import("@tauri-apps/api/event");
  return listen<string>(BROWSER_ANNOTATION_EVENT, (event) => {
    if (typeof event.payload !== "string") return;

    try {
      const payload = JSON.parse(event.payload) as BrowserAnnotationPayload;
      onPayload(payload);
    } catch {
      // Ignore malformed payloads from the preview bridge.
    }
  });
}

export const BROWSER_PREVIEW_LOAD_EVENT = "browser-preview-load";

/** The label Rust gives a slot's browser ends with this: `…--<slot>`. */
export function browserPreviewSlotSuffix(slot: string): string {
  return `--${slot.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

/** A Preview page started or finished loading; failures never arrive, so a start without a finish is a stall. */
export async function listenBrowserPreviewLoad(
  onLoad: (load: { label: string; phase: "started" | "finished"; url?: string }) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};

  const { listen } = await import("@tauri-apps/api/event");
  return listen<{ label: string; phase: "started" | "finished"; url?: string }>(BROWSER_PREVIEW_LOAD_EVENT, (event) => onLoad(event.payload));
}
