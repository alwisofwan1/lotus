import { tauriInvoke } from "@/lib/tauri/runtime";
import { toWindowRect } from "@/lib/ui-zoom";

export interface CanvasBrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  zoomFactor?: number;
}

export interface CanvasBrowserOpenResult {
  ok: boolean;
  nodeId: string;
  url: string;
  reused: boolean;
}

export function openCanvasBrowser(
  nativeBrowserId: string,
  url: string,
  bounds: CanvasBrowserBounds,
  allowedRoot?: string,
): Promise<CanvasBrowserOpenResult> {
  return tauriInvoke<CanvasBrowserOpenResult>("open_canvas_browser", {
    terminalId: nativeBrowserId,
    url,
    allowedRoot: allowedRoot ?? null,
    bounds: toWindowRect(bounds),
  });
}

export function closeCanvasBrowser(nativeBrowserId: string): Promise<void> {
  return tauriInvoke<void>("close_canvas_browser", { terminalId: nativeBrowserId });
}

export function navigateCanvasBrowser(
  nativeBrowserId: string,
  url: string,
  allowedRoot?: string,
): Promise<void> {
  return tauriInvoke<void>("navigate_canvas_browser", {
    terminalId: nativeBrowserId,
    url,
    allowedRoot: allowedRoot ?? null,
  });
}

export function syncCanvasBrowserBounds(nativeBrowserId: string, bounds: CanvasBrowserBounds): Promise<void> {
  return tauriInvoke<void>("sync_canvas_browser_bounds", { terminalId: nativeBrowserId, bounds: toWindowRect(bounds) });
}

export function reloadCanvasBrowser(nativeBrowserId: string): Promise<void> {
  return tauriInvoke<void>("reload_canvas_browser", { terminalId: nativeBrowserId });
}

/**
 * Read-only probe: does a live native child WebView exist for this node?
 * Used by the node's self-heal check to detect an "active" claim stranded over a
 * black pane (the WebView was torn down but the claim survived). Side-effect free.
 */
export function isCanvasBrowserOpen(nativeBrowserId: string): Promise<boolean> {
  return tauriInvoke<boolean>("is_canvas_browser_open", { terminalId: nativeBrowserId });
}

export interface CanvasBrowserStatus {
  /** The native child WebView exists. */
  open: boolean;
  /**
   * The WebView exists but sits at (or near) the off-screen park sentinel — the
   * recurrence black pane: a live "active" claim over a parked, never-re-synced
   * surface. Always false when `open` is false.
   */
  viewportParked: boolean;
}

/**
 * Read-only status probe richer than {@link isCanvasBrowserOpen}: reports both
 * existence AND whether an existing WebView is parked off-screen, so the self-heal
 * check can tell the two black-pane classes apart — absent (re-open) vs
 * open-but-parked (re-push bounds). Side-effect free.
 */
export function getCanvasBrowserStatus(nativeBrowserId: string): Promise<CanvasBrowserStatus> {
  return tauriInvoke<CanvasBrowserStatus>("get_canvas_browser_status", { terminalId: nativeBrowserId });
}

/** Step the paired browser through its history: -1 = back, +1 = forward. */
export function historyCanvasBrowser(nativeBrowserId: string, delta: number): Promise<void> {
  return tauriInvoke<void>("history_canvas_browser", { terminalId: nativeBrowserId, delta });
}

export type CanvasBrowserPolicyMode = "open" | "allowlist";

export interface CanvasBrowserPolicy {
  mode: CanvasBrowserPolicyMode;
  /** Allowlist entries: exact origins, bare hosts, host:port, or .suffix.example.com. */
  origins: string[];
}

/**
 * Set the origin allowlist for a browser node. Human-controlled from the node UI;
 * the agent-facing HTTP API only enforces this policy and cannot change it.
 */
export function setCanvasBrowserPolicy(
  nativeBrowserId: string,
  policy: CanvasBrowserPolicy,
): Promise<void> {
  return tauriInvoke<void>("set_canvas_browser_policy", { terminalId: nativeBrowserId, policy });
}

export function getCanvasBrowserPolicy(nativeBrowserId: string): Promise<CanvasBrowserPolicy> {
  return tauriInvoke<CanvasBrowserPolicy>("get_canvas_browser_policy", { terminalId: nativeBrowserId });
}

export type CanvasBrowserApprovalMode = "auto" | "ask";

/**
 * Set a node's write-action approval mode. `ask` holds every agent-issued
 * open/navigate (and future click/type) until the human approves it via
 * {@link resolveCanvasBrowserAction}. Human-controlled; not on the agent API.
 */
export function setCanvasBrowserApprovalMode(
  nativeBrowserId: string,
  mode: CanvasBrowserApprovalMode,
): Promise<void> {
  return tauriInvoke<void>("set_canvas_browser_approval_mode", { terminalId: nativeBrowserId, mode });
}

export function getCanvasBrowserApprovalMode(
  nativeBrowserId: string,
): Promise<CanvasBrowserApprovalMode> {
  return tauriInvoke<CanvasBrowserApprovalMode>("get_canvas_browser_approval_mode", {
    terminalId: nativeBrowserId,
  });
}

/** Approve or deny a pending write action (from the approval chip). Returns whether it was still pending. */
export function resolveCanvasBrowserAction(requestId: string, approve: boolean): Promise<boolean> {
  return tauriInvoke<boolean>("resolve_canvas_browser_action", { requestId, approve });
}

/** Return keyboard focus to the main app WebView (used when a browser node parks for an overlay). */
export function focusCanvasMainWebview(): Promise<void> {
  return tauriInvoke<void>("focus_canvas_main_webview", {});
}

export function startCanvasBrowserAnnotationMode(nativeBrowserId: string): Promise<void> {
  return tauriInvoke<void>("start_canvas_browser_annotation_mode", { terminalId: nativeBrowserId });
}

export function stopCanvasBrowserAnnotationMode(nativeBrowserId: string): Promise<void> {
  return tauriInvoke<void>("stop_canvas_browser_annotation_mode", { terminalId: nativeBrowserId });
}

/** Verify-first instrumentation (Slice 0): relay a frontend annotation-trace
 *  line into the Rust dev terminal (stderr) alongside the nav-scheme/IPC
 *  trace lines, so a live repro reads from one terminal instead of also
 *  needing the WebView DevTools console. */
export function logCanvasBrowserAnnotationTrace(line: string): Promise<void> {
  return tauriInvoke<void>("log_canvas_browser_annotation_trace", { line });
}

export interface CanvasBrowserAnnotationScreenshotCropRect {
  /** Viewport-relative CSS pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** CSS viewport dims the rect was measured against — Rust self-calibrates the
   *  crop scale from the captured PNG size vs these, so page zoom / Retina cancel out. */
  viewportWidth: number;
  viewportHeight: number;
}

/** Capture a native full-viewport screenshot (macOS `takeSnapshot`) for a Browser
 *  Node annotation and return its persisted file path. Invoked from the main app
 *  webview — never from inside the annotated page — so it never depends on that
 *  child webview's own IPC capability grant. When `cropRect` is given, Rust crops
 *  the captured PNG to that region, self-calibrating the CSS→pixel scale from the
 *  actual PNG size vs the CSS viewport (immune to page zoom / device pixel ratio);
 *  omitted/null returns the full viewport. */
export function captureCanvasBrowserAnnotationScreenshot(
  nativeBrowserId: string,
  cropRect?: CanvasBrowserAnnotationScreenshotCropRect | null,
): Promise<string> {
  return tauriInvoke<string>("capture_canvas_browser_annotation_screenshot", {
    terminalId: nativeBrowserId,
    cropRect: cropRect ?? null,
  });
}
