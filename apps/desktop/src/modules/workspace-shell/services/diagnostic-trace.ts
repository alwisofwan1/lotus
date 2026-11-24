/**
 * Where the shell leaves its breadcrumbs.
 *
 * `console.warn` in the webview does NOT reach the `tauri dev` terminal — nothing in this app
 * forwards the webview console (checked 2026-09-24: no log plugin, no Next browser-to-terminal
 * option), so a line logged there is only visible with the WebKit inspector open. A packaged build
 * has no console anyone can read at all.
 *
 * `localStorage` is the substitute: it survives a reload, and WebKit keeps it on disk as SQLite —
 * `~/Library/WebKit/com.lotus.desktop/WebsiteData/Default/<origin>/<origin>/LocalStorage/
 * localstorage.sqlite3`, `ItemTable`, value stored as UTF-16LE — so it can be read without asking
 * anyone to open anything. Newest last, hard-capped.
 *
 * One key per question. A shared key lets the chattiest writer push everyone else's lines out.
 */
export function appendDiagnosticTrace(key: string, entry: string, max = 200): void {
  try {
    const previous = window.localStorage.getItem(key);
    const lines = previous ? previous.split("\n") : [];
    lines.push(`${new Date().toISOString()} ${entry}`);
    window.localStorage.setItem(key, lines.slice(-max).join("\n"));
  } catch {
    /* storage is a diagnostic, never a dependency — a quota or a private window must not break a badge */
  }
}
