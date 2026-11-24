/**
 * True when running the dev build (`tauri dev` / `next dev`), false for the
 * bundled release (static production export served by the DMG app). Lets the UI
 * flag a dev window so it is never confused with a side-by-side release window.
 */
export function isDevBuild(): boolean {
  return process.env.NODE_ENV !== "production";
}
