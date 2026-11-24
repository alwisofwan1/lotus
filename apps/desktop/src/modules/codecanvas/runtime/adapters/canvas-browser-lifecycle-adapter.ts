import {
  closeCanvasBrowser,
  getCanvasBrowserStatus,
  historyCanvasBrowser,
  isCanvasBrowserOpen,
  navigateCanvasBrowser,
  openCanvasBrowser,
  reloadCanvasBrowser,
  type CanvasBrowserBounds,
  type CanvasBrowserOpenResult,
  type CanvasBrowserStatus,
} from "@/lib/tauri/canvas-browser";
import type { CanvasBrowserState } from "../../types/canvas";

export interface CanvasBrowserLifecycleIpc {
  open: (
    nativeBrowserId: string,
    url: string,
    bounds: CanvasBrowserBounds,
    allowedRoot?: string,
  ) => Promise<CanvasBrowserOpenResult>;
  close: (nativeBrowserId: string) => Promise<void>;
  navigate: (nativeBrowserId: string, url: string, allowedRoot?: string) => Promise<void>;
  reload: (nativeBrowserId: string) => Promise<void>;
  history: (nativeBrowserId: string, delta: number) => Promise<void>;
  isOpen: (nativeBrowserId: string) => Promise<boolean>;
  status: (nativeBrowserId: string) => Promise<CanvasBrowserStatus>;
}

export interface OpenCanvasBrowserSessionInput {
  nativeBrowserId: string;
  targetUrl: string;
  bounds: CanvasBrowserBounds;
  /** Confinement root for a `file://` target (the active project dir). */
  allowedRoot?: string;
  ipc?: CanvasBrowserLifecycleIpc;
}

export const defaultCanvasBrowserLifecycleIpc: CanvasBrowserLifecycleIpc = {
  open: openCanvasBrowser,
  close: closeCanvasBrowser,
  navigate: navigateCanvasBrowser,
  reload: reloadCanvasBrowser,
  history: historyCanvasBrowser,
  isOpen: isCanvasBrowserOpen,
  status: getCanvasBrowserStatus,
};

export function isBlankCanvasBrowserUrl(url: string): boolean {
  const value = url.trim().toLowerCase();
  return value === "" || value === "about:blank";
}

export function normalizeCanvasBrowserInitialState(
  initialUrl: string,
  initialState: CanvasBrowserState,
): CanvasBrowserState {
  // "loading" or "active" without a URL is an unfulfillable claim — there is no
  // page to open or to be live on. Normalize to disconnected so the node shows
  // its recovery UI instead of a permanently black pane.
  if (initialState !== "disconnected" && isBlankCanvasBrowserUrl(initialUrl)) return "disconnected";
  return initialState;
}

export async function openCanvasBrowserSession({
  nativeBrowserId,
  targetUrl,
  bounds,
  allowedRoot,
  ipc = defaultCanvasBrowserLifecycleIpc,
}: OpenCanvasBrowserSessionInput): Promise<string> {
  const result = await ipc.open(nativeBrowserId, targetUrl, bounds, allowedRoot);
  return result.url || targetUrl;
}

export async function closeCanvasBrowserSession(
  nativeBrowserId: string,
  ipc: CanvasBrowserLifecycleIpc = defaultCanvasBrowserLifecycleIpc,
): Promise<void> {
  await ipc.close(nativeBrowserId);
}

export async function navigateCanvasBrowserSession(
  nativeBrowserId: string,
  url: string,
  allowedRoot?: string,
  ipc: CanvasBrowserLifecycleIpc = defaultCanvasBrowserLifecycleIpc,
): Promise<void> {
  await ipc.navigate(nativeBrowserId, url, allowedRoot);
}

export async function reloadCanvasBrowserSession(
  nativeBrowserId: string,
  ipc: CanvasBrowserLifecycleIpc = defaultCanvasBrowserLifecycleIpc,
): Promise<void> {
  await ipc.reload(nativeBrowserId);
}

export async function historyCanvasBrowserSession(
  nativeBrowserId: string,
  delta: number,
  ipc: CanvasBrowserLifecycleIpc = defaultCanvasBrowserLifecycleIpc,
): Promise<void> {
  await ipc.history(nativeBrowserId, delta);
}

export async function isCanvasBrowserSessionOpen(
  nativeBrowserId: string,
  ipc: CanvasBrowserLifecycleIpc = defaultCanvasBrowserLifecycleIpc,
): Promise<boolean> {
  return ipc.isOpen(nativeBrowserId);
}

export async function getCanvasBrowserSessionStatus(
  nativeBrowserId: string,
  ipc: CanvasBrowserLifecycleIpc = defaultCanvasBrowserLifecycleIpc,
): Promise<CanvasBrowserStatus> {
  return ipc.status(nativeBrowserId);
}
