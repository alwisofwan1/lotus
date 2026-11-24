/**
 * Detect a dev-server "ready" URL in a chunk of terminal output, so the canvas can
 * auto-open a Browser Node pointing at it (W1 — mirrors the iOS Simulator pane
 * opening automatically when Claude runs the app).
 *
 * Deliberately conservative: it only returns a loopback URL when the same text also
 * carries a dev-server readiness signal (Vite/Next/CRA/webpack/nuxt/astro all print
 * one). That keeps it from firing on an arbitrary `http://localhost:…` printed in
 * prose, a `curl` command, or log noise.
 *
 * Pure + synchronous so it is unit-tested without a terminal; the caller feeds it a
 * rolling buffer of recent output (URLs can be split across PTY write chunks, and
 * Vite in particular colors the port with its own ANSI run).
 */

/** ANSI CSI matcher (colors, cursor moves). Built via string so the ESC () is
 *  explicit and the pattern only ever fires on a real escape sequence — never on a
 *  literal `[…]` in ordinary output. */
const ANSI_CSI_RE = new RegExp("\\u001b\\[[0-9;?]*[ -/]*[@-~]", "g");

function stripAnsi(text: string): string {
  return text.replace(ANSI_CSI_RE, "");
}

/** Loopback dev-server URL, e.g. http://localhost:5173/ or http://127.0.0.1:3000. */
const LOOPBACK_URL_RE =
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(?:\/[^\s'"`)\]]*)?/gi;

/**
 * A dev-server readiness signal must be present for a match to count. Covers Vite
 * ("Local:", "➜", "ready in"), Next.js ("Local:", "started server", "Ready in"),
 * CRA/webpack ("Local:", "compiled", "On Your Network"), Nuxt/Astro ("Local", "ready").
 */
const READINESS_RE =
  /(\blocal\s*:|\bready\b|\bstarted\b|\blistening\b|\brunning\b|\bcompiled\b|\bavailable\b|\bserving\b|on your network|dev server|➜)/i;

export interface DevServerUrlMatch {
  /** The navigable URL (0.0.0.0 normalized to localhost). */
  url: string;
}

/**
 * Return the first loopback dev-server URL in `text` when accompanied by a readiness
 * signal, else `null`. `0.0.0.0` (not navigable) is normalized to `localhost`.
 */
export function detectDevServerUrl(text: string): DevServerUrlMatch | null {
  if (!text) return null;
  const clean = stripAnsi(text);
  if (!READINESS_RE.test(clean)) return null;
  LOOPBACK_URL_RE.lastIndex = 0;
  const match = LOOPBACK_URL_RE.exec(clean);
  if (!match) return null;
  const url = match[0].replace(/0\.0\.0\.0/, "localhost");
  return { url };
}
