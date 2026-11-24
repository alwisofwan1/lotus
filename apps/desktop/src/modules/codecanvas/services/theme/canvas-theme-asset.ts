// Paper-media source resolution (ADR-0023, Phase 2/Layer 5). A theme's paper.media
// src/poster can be a remote URL, a data: URI, or a LOCAL file relative to the
// theme's folder (~/.lotus/canvas-themes/<id>/). Local refs are read by Rust and
// turned into a base64 data: URI here — mirrors the note-assets convention; no
// Tauri asset-protocol infra (keeps working under the static export + CSP).

/**
 * True when a ref points at a LOCAL theme-folder file that must be resolved (read
 * by Rust). False for refs the browser can load as-is: `http(s):`, `data:`, `blob:`,
 * AND web-absolute paths (`/assets/...`) — the latter are bundled app assets served
 * by the webview at the app root (used by built-in themes), not theme-folder files.
 */
export function isLocalAssetRef(src: string): boolean {
  if (!src) return false;
  return !/^(https?:|data:|blob:|\/)/i.test(src.trim());
}

export function toDataUri(mime: string, base64: string): string {
  return `data:${mime};base64,${base64}`;
}
