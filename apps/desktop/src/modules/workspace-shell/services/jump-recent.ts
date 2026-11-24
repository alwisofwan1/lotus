/**
 * When each workspace and pane was last used, for the Jump palette's empty list.
 * Per window, in localStorage: a convenience, so losing it only costs the order.
 */
const KEY = "lotus:jump-recent:v1";
/** Ids of closed panes would pile up forever; the oldest past this go. */
const KEEP = 200;

export function readRecent(): Record<string, number> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return saved && typeof saved === "object" && !Array.isArray(saved) ? (saved as Record<string, number>) : {};
  } catch {
    return {};
  }
}

export function touchRecent(ids: readonly (string | null | undefined)[], at = Date.now()): void {
  try {
    const all = readRecent();
    for (const id of ids) if (id) all[id] = at;
    const kept = Object.entries(all).sort((a, b) => b[1] - a[1]).slice(0, KEEP);
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Storage off or full: the list falls back to activity times.
  }
}
